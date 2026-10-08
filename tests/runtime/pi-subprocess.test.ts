/**
 * Task 3：pi CLI subprocess 适配器（D16–D19/D21/D23；协议 docs/runtime-protocol.md）。
 *
 * 与真实 pi CLI 的一切交互由**假 pi shim**承担：setUp 在 os.tmpdir() 下建唯一目录，
 * 放 `fake-pi.js`（按 `FAKE_PI_MODE` 切场景）与两种 shim（win32 `pi.cmd` → node；
 * POSIX `pi` sh 脚本 → node）——executor 经 PATH 前缀解析到 shim，走**真实子进程**
 * 的 spawn/shell/管道/杀树链路；无网络、无凭据、不依赖真实 pi 安装。
 *
 * 用例组（brief Step 1）：①版本探测（含缓存、含失败缓存）②成功路径（文本 + usage
 * 映射 + stdin-echo 钉 EOF 契约）③双层判定（D16 各分支）④健壮性（乱码/未知 type/
 * 截断尾行）⑤取消（win32：taskkill 杀树 + 快速 reject + 无孤儿清点）⑥buildSpawnArgs
 * 冻结模板 ⑦env 透传；另有 1 条经 StateGraph 的接线用例（graph.ts 的
 * resolveAgentExecutors 在 T3 接 createPiSubprocessExecutor——D20/T2 留位）。
 *
 * 平台门控：`describe.skipIf(process.platform !== "win32")` 只圈 win32 专属组
 * （cmd shim 解析/shell 链/taskkill）；其余组两种平台都应过（POSIX 用 sh shim）。
 *
 * 悬挂护栏：真子进程用例一律带显式 vitest 超时；取消用例自带 5s guard（防 CI 悬挂）；
 * hang 场景的假进程另有 60s 自毁兜底（杀树失败也不会泄漏到测试运行之外）。
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";

import { StateGraph } from "../../src/core/graph.js";
import { isRetryableError } from "../../src/core/retry.js";
import { END, START } from "../../src/core/types.js";
import { agentNode } from "../../src/nodes/agent.js";
import type { AgentExecutor } from "../../src/runtime/executor.js";
import {
	buildSpawnArgs,
	createPiSubprocessExecutor,
	type PiSubprocessConfig,
	resetPiCliProbeForTests,
} from "../../src/runtime/pi-subprocess.js";

// ---------------------------------------------------------------------------
// 假 pi CLI：fake-pi.js 按 FAKE_PI_MODE 切场景（测试 setUp 写入临时目录）。
// 协议行格式与 M0 ④ 的实测一致（JSONL、LF、首行 session header）。
// ---------------------------------------------------------------------------

const FAKE_PI_JS = `"use strict";
// fake-pi.js —— pi-workflow 测试用假 pi CLI（FAKE_PI_MODE 切场景）。
// 观察点文件（由测试经 FAKE_PI_* 环境变量传入绝对路径）：
// - FAKE_PI_PROBE_COUNTER：--version 调用计数（D18 探测次数钉）
// - FAKE_PI_ECHO_FILE：stdin 全文字节数（D17 EOF 契约钉——读不到 EOF 就没有后续行）
// - FAKE_PI_PID_FILE：自身 PID（D19 杀树后无孤儿清点用）
const fs = require("node:fs");

const mode = process.env.FAKE_PI_MODE || "version";
const write = (s) => process.stdout.write(s);
const line = (obj) => write(JSON.stringify(obj) + "\\n");

const sessionHeader = () =>
  line({
    type: "session",
    version: 3,
    id: "fake-session",
    timestamp: "2026-10-08T00:00:00.000Z",
    cwd: process.cwd(),
  });

const usageFull = {
  input: 1444,
  output: 17,
  cacheRead: 3,
  cacheWrite: 4,
  totalTokens: 1468,
  cacheWrite1h: 0, // pi 独有键：适配器不得转发（D21）
  cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
};

function bumpCounter(file) {
  if (!file) return;
  let n = 0;
  try {
    n = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10) || 0;
  } catch {
    // 首次调用：计数文件还不存在
  }
  fs.writeFileSync(file, String(n + 1));
}

function readStdinToEof() {
  // D17 的对偶验证：适配器必须 write(task) 后立即 end()——读不到 EOF 就永远
  // 不打 message_end，用例的 guard/超时会响。
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("error", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function usageFor() {
  const setting = process.env.FAKE_PI_USAGE || "full";
  if (setting === "none") return undefined; // 消息整体没有 usage 键
  if (setting === "partial") return { input: 5, output: 6, totalTokens: 11, cacheWrite1h: 9 };
  return usageFull;
}

async function main() {
  // --version 优先于场景（D18 探测走这条；版本可用 FAKE_PI_VERSION 覆盖）。
  // FAKE_PI_VERSION_DELAY（ms）> 0 时在计数后挂起再打印——探测窗口内 abort 的用例
  // 靠它锁定"探测在飞"的时刻（R1）。
  if (process.argv.includes("--version")) {
    bumpCounter(process.env.FAKE_PI_PROBE_COUNTER);
    const print = () => write((process.env.FAKE_PI_VERSION || "1.0.4") + "\\n");
    const delay = Number.parseInt(process.env.FAKE_PI_VERSION_DELAY || "0", 10);
    if (delay > 0) {
      setTimeout(print, delay);
    } else {
      print();
    }
    return;
  }

  if (mode === "hang") {
    // 真实挂起：写 PID 供杀树清点（M0 ⑤.4）；60s 自毁兜底防泄漏
    if (process.env.FAKE_PI_PID_FILE) {
      fs.writeFileSync(process.env.FAKE_PI_PID_FILE, String(process.pid));
    }
    sessionHeader();
    setInterval(() => {}, 3600000);
    setTimeout(() => process.exit(0), 60000).unref();
    await new Promise(() => {}); // 永不 resolve
    return;
  }

  if (mode === "success" || mode === "env-echo") {
    sessionHeader(); // 首行 header（M0 ④.1）——真实 pi 立即打
    const stdin = await readStdinToEof(); // 读到 EOF 才继续
    if (process.env.FAKE_PI_ECHO_FILE) {
      fs.writeFileSync(process.env.FAKE_PI_ECHO_FILE, String(stdin.length));
    }
    line({ type: "stdin-echo", len: stdin.length }); // 未知 type：解析器须跳过
    const text = mode === "env-echo" ? "env:" + (process.env.FAKE_PI_ENV_ECHO || "") : "\\u597d\\u7684";
    const message = { role: "assistant", content: [{ type: "text", text: text }], stopReason: "stop" };
    const usage = usageFor();
    if (usage !== undefined) message.usage = usage;
    line({ type: "message_end", message: message });
    line({ type: "agent_settled" });
    return;
  }

  if (mode === "llm-error") {
    sessionHeader();
    line({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: process.env.FAKE_PI_ERROR_MESSAGE || '403 {"error":{"type":"forbidden","message":"Request not allowed"}}',
      },
    });
    line({ type: "agent_settled" });
    return;
  }

  if (mode === "aborted") {
    sessionHeader();
    line({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "half" }],
        stopReason: "aborted",
        errorMessage: "interrupted by user",
      },
    });
    line({ type: "agent_settled" });
    return;
  }

  if (mode === "weird-stop") {
    sessionHeader();
    line({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "mystery" }], stopReason: "weird" },
    });
    line({ type: "agent_settled" });
    return;
  }

  if (mode === "no-assistant") {
    sessionHeader();
    line({ type: "agent_settled" });
    return;
  }

  if (mode === "garbage") {
    // M0 ④.0/⑤.4 混排：CRLF 行 + 乱码行 + 未知 type + JSON 截断整行 + 合法成功行
    // + 无换行的截断尾行（解析失败丢弃，不抛）
    write(JSON.stringify({ type: "session", version: 3, id: "fake", timestamp: "t", cwd: "." }) + "\\r\\n");
    write("<<<not json at all>>>\\n");
    line({ type: "totally_unknown", foo: 1 });
    write('{"type":"message_end","message":{"role":"assis\\n');
    line({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "\\u597d\\u7684" }], stopReason: "stop", usage: usageFull },
    });
    line({ type: "agent_settled" });
    write('{"type":"message_end","message":{"role":"assis');
    return;
  }

  if (mode === "crash") {
    // 启动期错误（M0 ④.6 第二行）：stderr + 退出码 1——双层判定的第 1 层
    process.stderr.write('Error: Model "no-such-provider/no-such-model" not found.\\n');
    process.stderr.write("detail-" + "y".repeat(2000) + "\\n");
    process.exitCode = 1;
    return;
  }

  if (mode === "stderr-flood") {
    // R1 回归锁：stderr > 8KB。头部在前 ~6 字节；"TAIL-MARKER-9KB" 从第 ~9007 字节
    // 起——超出 8KB 收集上限。中间用空格填充：压缩单行会把空白折叠，若收集**无**
    // 上限，"start TAIL-MARKER-9KB" 会整体落进 500 字符消息窗口，断言即可区分。
    process.stderr.write("start ");
    process.stderr.write(" ".repeat(9000));
    process.stderr.write("TAIL-MARKER-9KB");
    process.exitCode = 1;
    return;
  }

  process.exitCode = 1; // 未知场景：失败要响
}

main();
`;

/** win32：cmd shim（shell:true 下 cmd.exe 经 PATH 解析 pi.cmd → node fake-pi.js）。 */
const PI_CMD = '@node "%~dp0fake-pi.js" %*\r\n';

/** POSIX：sh shim（exec node，退出码直通）。 */
const PI_SH = '#!/bin/sh\nexec node "$(dirname "$0")/fake-pi.js" "$@"\n';

// ---------------------------------------------------------------------------
// setUp / helpers
// ---------------------------------------------------------------------------

let shimDir = "";
let seq = 0;

beforeAll(async () => {
	shimDir = await mkdtemp(join(tmpdir(), "pi-subprocess-test-"));
	await writeFile(join(shimDir, "fake-pi.js"), FAKE_PI_JS, "utf8");
	await writeFile(join(shimDir, "pi.cmd"), PI_CMD, "utf8");
	await writeFile(join(shimDir, "pi"), PI_SH, {
		encoding: "utf8",
		mode: 0o755,
	});
});

afterAll(async () => {
	await rm(shimDir, { recursive: true, force: true, maxRetries: 5 });
});

beforeEach(() => {
	// 版本探测缓存是进程内单例（D18）：每用例前后清——用例间零串味。
	resetPiCliProbeForTests();
});

afterEach(() => {
	resetPiCliProbeForTests();
});

/** 组一个 executor（brief 逐字形态）+ 本用例专属的观察点文件路径。 */
function executorFor(
	mode: string,
	extraEnv: Record<string, string> = {},
	configOverrides: Partial<PiSubprocessConfig> = {},
): {
	executor: AgentExecutor;
	probeCounter: string;
	echoFile: string;
	pidFile: string;
} {
	seq += 1;
	const probeCounter = join(shimDir, `probe-${seq}`);
	const echoFile = join(shimDir, `echo-${seq}`);
	const pidFile = join(shimDir, `pid-${seq}`);
	const executor = createPiSubprocessExecutor({
		bin: "pi",
		cwd: shimDir,
		env: {
			...process.env,
			PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
			FAKE_PI_MODE: mode,
			FAKE_PI_PROBE_COUNTER: probeCounter,
			FAKE_PI_ECHO_FILE: echoFile,
			FAKE_PI_PID_FILE: pidFile,
			...extraEnv,
		},
		...configOverrides,
	});
	return { executor, probeCounter, echoFile, pidFile };
}

/** 一次 agent 调用请求（引擎 attempt 级语义的最小形态；timeoutMs 不由适配器消费）。 */
type AgentRequest = Parameters<AgentExecutor>[0];

function agentRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
	return {
		task: "hello agent",
		signal: new AbortController().signal,
		timeoutMs: 600_000,
		runId: "run-1",
		instanceId: "node-1",
		...overrides,
	};
}

/** 取 rejection 的抛值（resolve 时返回 undefined——调用方必须断言其为 Error）。 */
async function rejectionOf(value: Promise<unknown>): Promise<unknown> {
	try {
		await value;
	} catch (error) {
		return error;
	}
	return undefined;
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/**
 * 拒绝且必须在 ms 内发生（取消用例的自带护栏——D19 快速失败的钉子）：
 * 超时返回带 label 的 Error（而非悬挂），正常返回 rejection 本体。
 */
async function rejectionWithin(
	promise: Promise<unknown>,
	ms: number,
	label: string,
): Promise<unknown> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new Error(`${label}: not settled within ${ms}ms (guard)`));
		}, ms);
	});
	try {
		const outcome = await Promise.race([
			promise.then(
				() => ({ kind: "fulfilled" as const, error: undefined as unknown }),
				(error: unknown) => ({ kind: "rejected" as const, error }),
			),
			guard,
		]);
		return outcome.kind === "rejected" ? outcome.error : undefined;
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

/** 读观察点计数文件（不存在 = 0）。 */
async function readCounter(file: string): Promise<number> {
	try {
		return Number.parseInt((await readFile(file, "utf8")).trim(), 10) || 0;
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// ⑥ buildSpawnArgs：冻结模板 verbatim（M0 ②节，纯函数逐字段钉）
// ---------------------------------------------------------------------------

describe("buildSpawnArgs (frozen spawn template, M0 ②)", () => {
	it("emits the protocol prefix with the default bin and process defaults", () => {
		const { command, args, opts } = buildSpawnArgs({}, {});

		expect(command).toBe("pi"); // config.bin ?? "pi"
		expect(args).toEqual(["--mode", "json", "-p", "--no-session"]);
		expect(opts.shell).toBe(true); // Windows 命中 npm shim 的唯一方式（DEP0190 噪声接受）
		expect(opts.cwd).toBe(process.cwd()); // config.cwd ?? process.cwd()
		expect(opts.stdio).toEqual(["pipe", "pipe", "pipe"]);
		expect(opts.detached).toBe(process.platform !== "win32"); // POSIX 组杀的前提（D19）
		expect(opts.env).toEqual({ ...process.env }); // config.env 缺省 = 原样拷贝
	});

	it("appends --model/--tools/extraArgs after the frozen prefix and honors config overrides", () => {
		const { command, args, opts } = buildSpawnArgs(
			{
				bin: "pi-9",
				cwd: "/cwd-x",
				env: { FAKE_EXTRA: "1" },
				extraArgs: ["--verbose", "--k=v"],
			},
			{ model: "ark/m1", tools: ["read", "bash"] },
		);

		expect(command).toBe("pi-9");
		expect(args).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			"ark/m1",
			"--tools",
			"read,bash",
			"--verbose",
			"--k=v",
		]);
		expect(opts.cwd).toBe("/cwd-x");
		const env = opts.env as NodeJS.ProcessEnv;
		expect(env.FAKE_EXTRA).toBe("1");
		expect(env.PATH).toBe(process.env.PATH); // 在 process.env 之上合并，同键覆盖
	});

	it("resolves --model as req.model ?? defaultModel and omits it when both are absent (D23)", () => {
		const neither = buildSpawnArgs({}, {});
		expect(neither.args).toEqual(["--mode", "json", "-p", "--no-session"]);

		const fromDefault = buildSpawnArgs(
			{ defaultModel: "ark/glm-5.3-flash" },
			{},
		);
		expect(fromDefault.args).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			"ark/glm-5.3-flash",
		]);

		// req.model 优先于 config.defaultModel（D23：cfg.model ?? defaultModel）。
		const both = buildSpawnArgs({ defaultModel: "ark/glm" }, { model: "x/y" });
		expect(both.args).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			"x/y",
		]);
	});

	it("omits --tools when tools are absent; joins multiple with ',' (D23)", () => {
		const absent = buildSpawnArgs({}, {});
		expect(absent.args).toEqual(["--mode", "json", "-p", "--no-session"]);

		const one = buildSpawnArgs({}, { tools: ["read"] });
		expect(one.args).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--tools",
			"read",
		]);
	});

	it("treats an empty tools array as not configured: no --tools flag (M3 final review ruling)", () => {
		// 裁定口径（M3 最终评审，Minor）：空数组视同未配置——`--tools ""` 未经 M0 实测，
		// 宁缺勿滥；不带 flag 即 pi 的默认工具集（与 tools 未声明同形）。
		const { args } = buildSpawnArgs({}, { tools: [] });

		expect(args).toEqual(["--mode", "json", "-p", "--no-session"]);
		expect(args.includes("--tools")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// ① 版本探测（D18）
// ---------------------------------------------------------------------------

describe("version probe (D18)", () => {
	it("accepts 1.0.4 and proceeds to the run", async () => {
		const { executor } = executorFor("success");

		const result = await executor(agentRequest());

		expect(result.output).toBe("好的");
	}, 30_000);

	it("rejects 0.9.0 / 2.0.0 / non-semver with the actionable message and caches the failure", async () => {
		for (const version of ["0.9.0", "2.0.0", "pi version 1.0.4"]) {
			// 进程内缓存含失败（D18）：循环内复用一个进程，逐轮清缓存。
			resetPiCliProbeForTests();
			const { executor, probeCounter } = executorFor("success", {
				FAKE_PI_VERSION: version,
			});

			const first = (await rejectionOf(executor(agentRequest()))) as Error;
			expect(first).toBeInstanceOf(Error);
			expect(first.message).toContain(
				"pi CLI is not usable: expected version ^1.0.4 (verified against 1.0.4)",
			);
			expect(first.message).toContain(`got ${version}`);
			expect(first.message).toContain(
				"install @earendil-works/pi-coding-agent (npm i -g @earendil-works/pi-coding-agent)",
			);
			expect(first.message).toContain("or set services.agent.subprocess.bin");

			// 失败同样缓存：第二次不再探测（计数仍 1），同一错误原文。
			const second = (await rejectionOf(executor(agentRequest()))) as Error;
			expect(second.message).toBe(first.message);
			expect(await readCounter(probeCounter)).toBe(1);
		}

		// R1（评审 Minor 2）：observed 原文进消息前截 ~200 字符——病态 bin 把版本行
		// 写成日志倾倒时错误消息仍有界；D18 冻结模板的形状不变（只截 got 的内容）。
		resetPiCliProbeForTests();
		const long = "x".repeat(300);
		const longProbe = executorFor("success", { FAKE_PI_VERSION: long });
		const longError = (await rejectionOf(
			longProbe.executor(agentRequest()),
		)) as Error;
		expect(longError.message).toContain(`got ${long.slice(0, 200)}`);
		// 300 个 x 没有全进消息（200 截断生效）；`x`.repeat(201) 同样不出现。
		expect(longError.message.includes(long)).toBe(false);
		expect(await readCounter(longProbe.probeCounter)).toBe(1);
	}, 40_000);

	it("caches the successful probe across executor calls (probe child spawned once)", async () => {
		const { executor, probeCounter } = executorFor("success");

		const first = await executor(agentRequest({ task: "first" }));
		const second = await executor(agentRequest({ task: "second" }));

		expect(first.output).toBe("好的");
		expect(second.output).toBe("好的");
		// 两次真实调用（各含一次主 spawn），探测子进程只拉起一次。
		expect(await readCounter(probeCounter)).toBe(1);
	}, 40_000);
});

// ---------------------------------------------------------------------------
// ② 成功路径 + usage 映射（D21）+ stdin EOF 契约（D17）
// ---------------------------------------------------------------------------

describe("success path (stopReason stop)", () => {
	it("returns the final assistant text with mapped usage and proves stdin reached EOF", async () => {
		const { executor, echoFile } = executorFor("success");
		const task = "hello agent"; // ASCII：字节数 === 字符数，len 断言无歧义

		const result = await executor(agentRequest({ task }));

		expect(result.output).toBe("好的");
		expect(result.usage).toEqual({
			input: 1444,
			output: 17,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 1468,
			cost: {
				input: 0.001,
				output: 0.002,
				cacheRead: 0.0001,
				cacheWrite: 0.0002,
				total: 0.0033,
			},
		});
		// D21：pi 独有键不进 TokenUsage。
		expect(result.usage !== undefined && "cacheWrite1h" in result.usage).toBe(
			false,
		);
		// D17 钉子：fake 读到 EOF 才打 message_end——echo 文件有值本身即证明
		// 适配器 write(task) 后 end() 了（否则此用例悬挂到超时）。
		expect(await readFile(echoFile, "utf8")).toBe(String(task.length));
	}, 30_000);

	it("zero-fills missing numeric usage keys and drops pi-only keys (D21)", async () => {
		const { executor } = executorFor("success", { FAKE_PI_USAGE: "partial" });

		const result = await executor(agentRequest());

		expect(result.usage).toEqual({
			input: 5,
			output: 6,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 11,
		});
	}, 30_000);

	it("omits the usage field entirely when the assistant message has none (D21)", async () => {
		const { executor } = executorFor("success", { FAKE_PI_USAGE: "none" });

		const result = await executor(agentRequest());

		expect(result.output).toBe("好的");
		expect(result.usage).toBeUndefined();
		expect("usage" in result).toBe(false);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// ③ 双层判定（D16）
// ---------------------------------------------------------------------------

describe("two-layer verdict (D16)", () => {
	it("layer 1: non-zero exit fails with the compressed single-line stderr truncated at 500 chars", async () => {
		const { executor } = executorFor("crash");

		const error = (await rejectionOf(executor(agentRequest()))) as Error;

		expect(error).toBeInstanceOf(Error);
		expect(error.message.startsWith("pi CLI failed (exit 1): ")).toBe(true);
		// stderr 原文进消息（压缩单行）：启动期错误如模型不存在都在这层（M0 ④.6）。
		expect(error.message).toContain(
			'Error: Model "no-such-provider/no-such-model" not found.',
		);
		expect(error.message).toContain("detail-");
		// 2000+ 字符 stderr → 摘要截 500：消息总长 = 前缀 + 500，且不含换行。
		expect(error.message.length).toBe(24 + 500);
		expect(error.message.includes("\n")).toBe(false);
	}, 30_000);

	it("layer 2: stopReason 'error' keeps the upstream errorMessage verbatim (D3-reachable)", async () => {
		const { executor } = executorFor("llm-error");

		const error = (await rejectionOf(executor(agentRequest()))) as Error;

		// 原文保留（瞬态文本可被 isRetryableError 的 D3 正则族匹配）。
		expect(error.message).toBe(
			'pi agent failed: 403 {"error":{"type":"forbidden","message":"Request not allowed"}}',
		);
	}, 30_000);

	it("layer 2: stopReason 'aborted' rejects with an AbortError (mirrors llm-pi-ai)", async () => {
		const { executor } = executorFor("aborted");

		const error = (await rejectionOf(executor(agentRequest()))) as Error;

		expect(error.name).toBe("AbortError");
		expect(error.message).toContain("pi agent aborted");
		expect(error.message).toContain("interrupted by user");
	}, 30_000);

	it("layer 2: an unknown stopReason fails without guessing success", async () => {
		const { executor } = executorFor("weird-stop");

		const error = (await rejectionOf(executor(agentRequest()))) as Error;

		expect(error.message).toBe(
			'pi agent failed: unsupported stopReason "weird"',
		);
	}, 30_000);

	it("layer 2: an event stream without an assistant message fails with a dedicated message", async () => {
		const { executor } = executorFor("no-assistant");

		const error = (await rejectionOf(executor(agentRequest()))) as Error;

		expect(error.message).toBe("pi agent produced no assistant message");
	}, 30_000);

	// M3 最终评审（Important）：适配器 × 引擎的**交叉契约钉**。适配器对 stopReason
	// "error" 抛 `pi agent failed: <errorMessage>`（D16，原文保留）；引擎把 executor 的
	// 抛值原样交给 isRetryableError 按 D3 正则族分类（engine.ts 重试分支）。此前两侧只有
	// 间接证据（适配器测消息前缀形状、引擎测自定义 executor），交叉点无直接测试：瞬态
	// 5xx 原文经前缀拼接后必须仍落 D3 族（现状已可重试，本用例是契约锁），非瞬态 403
	// 不得被误判为可重试。
	it("layer 2: 'error' with a transient upstream message stays retryable through the 'pi agent failed:' prefix (D3 cross-contract)", async () => {
		const { executor } = executorFor("llm-error", {
			FAKE_PI_ERROR_MESSAGE: "503 Service Unavailable",
		});

		const error = (await rejectionOf(executor(agentRequest()))) as Error;

		expect(error.message).toBe("pi agent failed: 503 Service Unavailable");
		expect(isRetryableError(error)).toBe(true);
	}, 30_000);

	it("layer 2: 'error' with a non-transient upstream message is not retryable (D3 cross-contract)", async () => {
		const { executor } = executorFor("llm-error", {
			FAKE_PI_ERROR_MESSAGE: "403 Forbidden",
		});

		const error = (await rejectionOf(executor(agentRequest()))) as Error;

		expect(error.message).toBe("pi agent failed: 403 Forbidden");
		expect(isRetryableError(error)).toBe(false);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// ④ 健壮性：乱码/未知 type/CRLF/截断尾行都不抛、不误判（M0 ④.0/⑤.4）
// ---------------------------------------------------------------------------

describe("event-stream robustness (M0 ④.0/⑤.4)", () => {
	it("extracts the success out of CRLF, garbage lines, unknown types and a truncated tail", async () => {
		const { executor } = executorFor("garbage");

		const result = await executor(agentRequest());

		// 截断尾行（无换行 + 半个 JSON）被丢弃，合法成功行照常生效。
		expect(result.output).toBe("好的");
		expect(result.usage?.input).toBe(1444);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// ⑦ env 透传（M0 ②：env = { ...process.env, ...config.env }）
// ---------------------------------------------------------------------------

describe("env passthrough", () => {
	it("merges config.env over process.env inside the child", async () => {
		const { executor } = executorFor("env-echo", {
			FAKE_PI_ENV_ECHO: "marker-env-42",
		});

		const result = await executor(agentRequest());

		// fake 回显 config.env 注入的变量；PATH 也可用（shim 被解析）即证明合并而非替换。
		expect(result.output).toBe("env:marker-env-42");
	}, 30_000);
});

// ---------------------------------------------------------------------------
// ⑤ win32 专属：shim 解析/shell 链/taskkill 杀树（D19）
// ---------------------------------------------------------------------------

/** win32 清点：PID 是否仍存活（tasklist CSV 精确匹配，杀树后的无孤儿判据——M0 ⑤.4）。 */
function pidAlive(pid: string): Promise<boolean> {
	return new Promise((resolve) => {
		execFile(
			"tasklist",
			["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"],
			(_error, stdout) => {
				resolve(stdout.includes(`"${pid}"`));
			},
		);
	});
}

/** 轮询直到 PID 消亡（或超时——返回 false 供断言失败时给出清晰信息）。 */
async function waitForExit(pid: string, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		if (!(await pidAlive(pid))) {
			return true;
		}
		if (Date.now() > deadline) {
			return false;
		}
		await sleep(100);
	}
}

describe.skipIf(process.platform !== "win32")(
	"win32: shim chain + taskkill tree kill (D19)",
	() => {
		it("resolves the default bin 'pi' through the PATH shim chain (cmd.exe → node fake-pi)", async () => {
			// 不给 bin（= "pi"）：shell:true 下经 cmd.exe 按 PATH 解析 pi.cmd——
			// M0 ②节实测的真实进程链（host node → cmd.exe → pi node）。
			const { executor } = executorFor("success", {}, { bin: undefined });

			const result = await executor(agentRequest({ task: "shim" }));

			expect(result.output).toBe("好的");
		}, 30_000);

		it("kills the whole process tree on abort and rejects AbortError fast (D19)", async () => {
			const { executor, pidFile } = executorFor("hang");
			const controller = new AbortController();
			const pending = executor(agentRequest({ signal: controller.signal }));

			// 等假 pi 写出自己的 PID（真实挂起的孙进程：host → cmd.exe → node fake-pi.js）。
			let pid = "";
			const deadline = Date.now() + 5000;
			while (pid === "" && Date.now() < deadline) {
				await sleep(25);
				pid = (await readFile(pidFile, "utf8").catch(() => "")).trim();
			}
			expect(pid).not.toBe("");

			controller.abort();
			// 先杀后 reject（D19）：5s guard 内必须拿到 AbortError——快得等不到进程自然退出。
			const error = (await rejectionWithin(
				pending,
				5000,
				"abort must fail fast",
			)) as Error;
			expect(error).toBeInstanceOf(Error);
			expect(error.name).toBe("AbortError");

			// 杀树生效：孙进程在宽限内消亡——无孤儿（M0 ⑤.4 的清点判据）。
			expect(await waitForExit(pid, 5000)).toBe(true);
		}, 30_000);
	},
);

// ---------------------------------------------------------------------------
// graph 接线（D20/T2 留位：resolveAgentExecutors 在 T3 接 createPiSubprocessExecutor）
// ---------------------------------------------------------------------------

describe("graph wiring (executor 'subprocess')", () => {
	it("binds the subprocess adapter at compile time and runs an agent node end-to-end", async () => {
		seq += 1;
		const probeCounter = join(shimDir, `probe-${seq}`);
		const echoFile = join(shimDir, `echo-${seq}`);
		const g = new StateGraph<{ out?: string }>()
			.addNode(
				"writer",
				agentNode<{ out?: string }, "out">({
					task: "直接任务",
					writeTo: "out",
					executor: "subprocess",
				}),
			)
			.addEdge(START, "writer")
			.addEdge("writer", END);

		const compiled = g.compile({
			services: {
				agent: {
					subprocess: {
						bin: "pi",
						cwd: shimDir,
						env: {
							...process.env,
							PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
							FAKE_PI_MODE: "success",
							FAKE_PI_PROBE_COUNTER: probeCounter,
							FAKE_PI_ECHO_FILE: echoFile,
						},
					},
				},
			},
		});
		const { state } = await compiled.run({});

		// T2 只做到"compile 过"（无探测/无绑定）；T3 起此图真正可跑——产出经 writeTo 落 state。
		expect(state.out).toBe("好的");
	}, 40_000);
});

// ---------------------------------------------------------------------------
// R1 回归锁（T3 评审 Minor 1）：预 abort 不 spawn / 探测期取消不缓存 / stderr 8KB 上限
// ---------------------------------------------------------------------------

describe("R1 regression locks (T3 review)", () => {
	it("rejects an already-aborted signal before any spawn (no probe child, no main process)", async () => {
		const { executor, probeCounter, echoFile } = executorFor("success");
		const controller = new AbortController();
		controller.abort(); // 先 abort 再调用（D19：signal 已 abort → 不 spawn）

		const error = (await rejectionOf(
			executor(agentRequest({ signal: controller.signal })),
		)) as Error;

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("AbortError");
		expect(error.message).toBe("pi agent aborted");
		// 不 spawn 的证据：探测子进程从未拉起（计数文件不存在 → 0），
		// 主进程也从未跑过（echo 文件从未写出）。
		expect(await readCounter(probeCounter)).toBe(0);
		await expect(readFile(echoFile, "utf8")).rejects.toThrow();
	}, 30_000);

	it("does not cache an abort landing inside the probe window (next call re-probes and succeeds)", async () => {
		// 探测窗口：fake 的 --version 在计数后延迟 3s 才打印——abort 落在窗口内，
		// 探测子进程被杀、探测以 "aborted" 收场。
		const aborted = executorFor("success", { FAKE_PI_VERSION_DELAY: "3000" });
		const controller = new AbortController();
		const pending = aborted.executor(
			agentRequest({ signal: controller.signal }),
		);
		let probed = 0;
		const deadline = Date.now() + 5000;
		while (probed === 0 && Date.now() < deadline) {
			await sleep(25);
			probed = await readCounter(aborted.probeCounter);
		}
		expect(probed).toBe(1); // 探测子进程已在窗口内（打印版本之前）

		controller.abort();
		const error = (await rejectionWithin(
			pending,
			5000,
			"probe-window abort must fail fast",
		)) as Error;
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("AbortError");

		// 取消不是"pi 不可用"的证据——不缓存（实现裁定，R1 钉）：清缓存后下一次
		// 调用**重新探测且成功**，自己的计数文件从 0 起算 = 1（若失败被缓存，
		// 这里会直接复抛 "pi CLI is not usable" 且计数为 0）。
		resetPiCliProbeForTests();
		const fresh = executorFor("success");
		const result = await fresh.executor(agentRequest());
		expect(result.output).toBe("好的");
		expect(await readCounter(fresh.probeCounter)).toBe(1);
	}, 40_000);

	it("caps collected stderr at 8KB — bytes beyond the cap never reach the failure message", async () => {
		const { executor } = executorFor("stderr-flood");

		const error = (await rejectionOf(executor(agentRequest()))) as Error;

		expect(error.message.startsWith("pi CLI failed (exit 1): ")).toBe(true);
		// 8KB 之前的头部幸存（压缩单行）。
		expect(error.message).toContain("start");
		// 第 ~9007 字节起的标记从未被收集。压缩会把中间 9000 个空格折叠成一个，
		// 若收集无上限，"start TAIL-MARKER-9KB" 会整体落进 500 字符消息窗口——
		// 此断言即失败。8KB 上限（Task 3 Step 3）由此可黑盒观测。
		expect(error.message.includes("TAIL-MARKER-9KB")).toBe(false);
	}, 30_000);
});
