/**
 * pi CLI 子进程适配器（设计 §9.2；协议细节以 M0 冻结的 docs/runtime-protocol.md 为准，
 * 版本基准 1.0.4）。M3/T3：spawn、JSONL 事件流解析、双层成败判定、杀树、版本探测。
 *
 * `src/runtime/` 是适配器的**物理隔离区**：`node:child_process` 的 `spawn`/`execFile`
 * 只出现在本文件（Global Constraints）；core 只经 compile 期解析（graph.ts 的
 * resolveAgentExecutors → {@link createPiSubprocessExecutor}）取走执行器，运行期行为
 * 全部收敛在这里。不进 `src/index.ts` 公开面（同 `llm-pi-ai.ts`：供 compile 解析与
 * 高级用户直接接线用）。
 *
 * 协议落地（行内注释逐条标注出处）：
 * - **spawn 模板（M0 ②，冻结 verbatim）**：{@link buildSpawnArgs} 纯函数——
 *   `pi --mode json -p --no-session [--model m] [--tools a,b] [...extraArgs]`，
 *   `shell: true`（Windows 命中 npm shim 的唯一方式；Node ≥22 的 DEP0190 弃用告警是
 *   噪声，接受——运行期零新增依赖，不引入 cross-spawn）、cwd/stdio/env/detached 全按
 *   冻结值（POSIX `detached: true` 是 D19 组杀的前提）；
 * - **stdin 通道（D17/M0 ③.4）**：task 只走 stdin，`write(task)` 后立即 `end()`——
 *   不关挂死；不实现临时文件回退（M0 ③.3 已证 stdin 40k 逐字节可靠）；
 * - **事件流解析（M0 ④）**：逐行 JSONL、容忍 `\r` 与任意截断——乱码行、未知 type、
 *   无换行的尾行一律跳过或丢弃，解析器绝不抛；只收集**最后一条** assistant
 *   `message_end`（文本 = `content[]` 中 `type:"text"` 项的 `text` 拼接，M0 ④.4）；
 * - **双层成败（D16/M0 ④.6）**：退出码 ≠ 0 → 失败（stderr 压缩单行截 500 字符——
 *   启动期错误如模型不存在/无凭据都在这层）；退出码 = 0 → 最后一条 assistant 的
 *   `stopReason === "stop"` 才成功；`"error"` → `pi agent failed: <errorMessage>`
 *   （原文保留，瞬态可被 D3 正则族匹配）；`"aborted"` → `name = "AbortError"`
 *   （镜像 `llm-pi-ai.ts` 的 abortError——半截正文不算成功，取消不属可重试族）；
 *   其他值可读失败不猜；无 assistant 消息失败；
 * - **杀树（D19/M0 ⑤）**：signal abort → win32 `taskkill /PID <pid> /T /F`（发出即
 *   算杀，不等进程消亡）、POSIX `process.kill(-pid, "SIGKILL")` 组杀；signal 已
 *   abort 则不 spawn；**先杀后 reject**，快速失败——被放弃的子进程树不得存活；
 * - **usage 映射（D21/M0 ④.3）**：五计数 + `cost` 仅源有才带；数字键缺失以 0 填；
 *   pi 独有的 `cacheWrite1h` 等不转发；usage 对象整体缺失 → 结果不带 usage 字段；
 * - **版本探测（D18/M0 ①）**：首次真正调用 executor 时惰性 spawn `pi --version`
 *   （同 config 的 bin/cwd/env；stdin "ignore"），stdout 去空白须为裸 semver 且满足
 *   `^1.0.4`；失败/超区间 → 可行动错误（含实测值、期望区间与 npm 安装提示）。结果
 *   **进程内缓存（含失败）**——重装/升级 pi 需重启进程；`resetPiCliProbeForTests`
 *   供测试清缓存。`timeoutMs` 不由适配器消费：引擎的单次尝试超时就是 abort 这个
 *   signal（§7.3/T11，同 `llm-pi-ai.ts`）。
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { execFile, spawn } from "node:child_process";

import type { AgentExecutor, TokenUsage } from "./executor.js";

/**
 * subprocess 适配器的启动配置（设计 §4.6 verbatim）：字段全可选——空对象 `{}` 即
 * 接受全部默认（D20：compile 期只校验配置存在，`{}` 合法）。
 */
export type PiSubprocessConfig = {
	/** pi CLI 可执行文件（缺省 `"pi"`，经 PATH 解析；shim 测试也用它指向假 pi）。 */
	bin?: string;
	/** 子进程工作目录（缺省 `process.cwd()`）。 */
	cwd?: string;
	/** 注入子进程的环境变量（在 `process.env` 之上合并，同键覆盖）。 */
	env?: NodeJS.ProcessEnv;
	/** 追加到命令行的额外参数（排在协议前缀参数与 model/tools 之后，原样透传）。 */
	extraArgs?: string[];
	/** 节点未声明 `model` 时的默认模型（D23：`cfg.model ?? defaultModel`，都无则不带 `--model`）。 */
	defaultModel?: string;
};

// ---------------------------------------------------------------------------
// spawn 模板（M0 ②节，冻结 verbatim）
// ---------------------------------------------------------------------------

/**
 * 冻结的 spawn 命令行（M0 ②节 verbatim，纯函数）：参数顺序、缺省值、opts 字段
 * 逐项冻结——改模板必须改协议。`req` 只消费 D23 相关的 `model`/`tools` 两个字段
 * （schema 解析在 handler 层 D22；task 走 stdin 不进 argv，M0 ③.2：argv 有长度上限）。
 */
export function buildSpawnArgs(
	config: PiSubprocessConfig,
	req: { model?: string; tools?: string[] },
): { command: string; args: string[]; opts: SpawnOptions } {
	const model = req.model ?? config.defaultModel; // D23
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		...(model ? ["--model", model] : []),
		...(req.tools ? ["--tools", req.tools.join(",")] : []),
		...(config.extraArgs ?? []),
	];
	const opts: SpawnOptions = {
		shell: true, // Windows 命中 %APPDATA%/npm 的 shim（M0 ②）；DEP0190 是噪声，接受
		cwd: config.cwd ?? process.cwd(),
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...config.env },
		detached: process.platform !== "win32", // POSIX 组杀（D19）需要组长
	};
	return { command: config.bin ?? "pi", args, opts };
}

// ---------------------------------------------------------------------------
// 杀树（D19/M0 ⑤）
// ---------------------------------------------------------------------------

/**
 * 硬杀整棵进程树（D19）：win32 = `taskkill /PID <pid> /T /F`（M0 ⑤.1 冻结形式——
 * `/T` 不可省：shell:true 下句柄 PID 是 cmd.exe，pi 本体是其孙进程）；POSIX = 进程组
 * SIGKILL（spawn 时 `detached: true`，child 是组长——镜像 /T /F 语义，无优雅宽限）。
 * **发出即返回**：不等进程消亡（那是 OS 的事），调用方随即快速 reject。
 */
function killTree(child: ChildProcess): void {
	const pid = child.pid;
	if (pid === undefined) {
		return; // spawn 没成功（无句柄）——没树可杀
	}
	if (process.platform === "win32") {
		// 结果不等待：taskkill 对"树已退出"会报错，属预期——成败不归调用方关心。
		execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// ESRCH = 组已消亡（目标达成）；其余杀失败同样不阻断取消路径的快速 reject。
	}
}

// ---------------------------------------------------------------------------
// 事件流解析（M0 ④）与 usage 映射（D21）
// ---------------------------------------------------------------------------

/** 适配器真正消费的 assistant `message_end` 字段（其余按协议原样忽略）。 */
type AssistantOutcome = {
	text: string;
	stopReason: string | undefined;
	errorMessage: string | undefined;
	usage: unknown;
};

/** assistant `content[]` 中 `type:"text"` 项的 `text` 拼接（M0 ④.4 的取用优先级 1）。 */
function assistantTextOf(content: unknown): string {
	if (!Array.isArray(content)) {
		return "";
	}
	let text = "";
	for (const item of content) {
		if (
			typeof item === "object" &&
			item !== null &&
			(item as Record<string, unknown>).type === "text"
		) {
			const value = (item as Record<string, unknown>).text;
			if (typeof value === "string") {
				text += value;
			}
		}
	}
	return text;
}

/**
 * 逐行 JSONL 事件流解析器（M0 ④.0/⑤.4 的健壮性口径）：`feed` 吃 stdout chunk
 * （按 `\n` 切、容忍 `\r`），`end` 收尾——无换行的尾段**能解析就处理、解析失败
 * 丢弃**（被杀场景事件流在任意行边界截断）。行级规则：空行/乱码行/未知 type/`session`
 * header 一律跳过；只收集 `type === "message_end"` 且 `message.role === "assistant"`
 * 的**最后一条**（后到覆盖先到）。解析器绝不抛（协议之外的字节不配让 run 崩）。
 */
function createEventStreamParser(): {
	feed: (chunk: string) => void;
	end: () => void;
	result: () => AssistantOutcome | undefined;
} {
	let buffer = "";
	let last: AssistantOutcome | undefined;

	const handleLine = (rawLine: string): void => {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line.trim() === "") {
			return;
		}
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return; // 乱码行/半行 JSON：跳过（M0 ④.0/⑤.4）
		}
		if (typeof event !== "object" || event === null) {
			return;
		}
		const record = event as Record<string, unknown>;
		if (record.type === "session") {
			return; // 首行 session header（--no-session 也输出，M0 ④.1）：跳过
		}
		if (record.type !== "message_end") {
			return; // 其余事件（含未来新增的未知 type，M0 ④.3 末注）：跳过
		}
		const message = record.message;
		if (typeof message !== "object" || message === null) {
			return;
		}
		const msg = message as Record<string, unknown>;
		if (msg.role !== "assistant") {
			return; // system/user 的 message_end 不参与成败判定
		}
		last = {
			text: assistantTextOf(msg.content),
			stopReason:
				typeof msg.stopReason === "string" ? msg.stopReason : undefined,
			errorMessage:
				typeof msg.errorMessage === "string" ? msg.errorMessage : undefined,
			usage: msg.usage,
		};
	};

	return {
		feed(chunk: string): void {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) {
					break;
				}
				handleLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
			}
		},
		end(): void {
			// 尾行不完整（被杀/截断，M0 ⑤.4）：解析失败即丢弃。
			if (buffer.trim() !== "") {
				handleLine(buffer);
			}
			buffer = "";
		},
		result: () => last,
	};
}

/** 数字键缺失/非有限数值以 0 填（D21：pi 的 usage 键集可变，M0 ④.3）。 */
function countOf(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * usage 映射（D21）：只带 D4 的五个计数；`cost` **只在源 usage 有 cost 时**进结果；
 * pi 独有的 `cacheWrite1h`/`raw*`/`reasoning` 不转发；usage 对象整体缺失 → 调用方
 * 不带 usage 字段（由 {@link verdictOf} 的存在性判断负责）。
 */
function toTokenUsage(raw: Record<string, unknown>): TokenUsage {
	const mapped: TokenUsage = {
		input: countOf(raw, "input"),
		output: countOf(raw, "output"),
		cacheRead: countOf(raw, "cacheRead"),
		cacheWrite: countOf(raw, "cacheWrite"),
		totalTokens: countOf(raw, "totalTokens"),
	};
	const cost = raw.cost;
	if (typeof cost === "object" && cost !== null) {
		mapped.cost = {
			input: countOf(cost as Record<string, unknown>, "input"),
			output: countOf(cost as Record<string, unknown>, "output"),
			cacheRead: countOf(cost as Record<string, unknown>, "cacheRead"),
			cacheWrite: countOf(cost as Record<string, unknown>, "cacheWrite"),
			total: countOf(cost as Record<string, unknown>, "total"),
		};
	}
	return mapped;
}

// ---------------------------------------------------------------------------
// 双层成败判定（D16/M0 ④.6）
// ---------------------------------------------------------------------------

/** stderr 收集上限（Task 3 Step 3：8KB 截断——第 1 层失败消息无需全量 stderr）。 */
const STDERR_MAX_BYTES = 8 * 1024;
/** 第 1 层失败消息里 stderr 摘要的长度上限（压缩单行后截断）。 */
const STDERR_SUMMARY_MAX = 500;

/** 压缩成单行并截 500 字符（D16 的消息体口径）。 */
function compressStderr(raw: string): string {
	return raw.replace(/\s+/g, " ").trim().slice(0, STDERR_SUMMARY_MAX);
}

/** 抛值的一句话描述（与引擎 messageOf 同口径的简化版：只用于拼错误消息）。 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * abort 失败（镜像 `llm-pi-ai.ts` 的 abortError）：`name = "AbortError"` 的普通
 * Error——上层按名字识别"这是取消"。不用 DOMException（Node 里它不是 Error 子类，
 * 诊断消息会丢失）；消息不落 D3 可重试族（取消不该重试）。
 */
function abortError(detail: string | undefined): Error {
	const error = new Error(
		detail === undefined ? "pi agent aborted" : `pi agent aborted: ${detail}`,
	);
	error.name = "AbortError";
	return error;
}

type Verdict =
	| { ok: true; result: { output: string; usage?: TokenUsage } }
	| { ok: false; error: Error };

/**
 * 双层成败判定（D16/M0 ④.6，纯函数）：
 * 1. 退出码 ≠ 0（含 POSIX 被信号杀死的 code=null）→ 失败，stderr 压缩单行截 500；
 * 2. 退出码 = 0 → 最后一条 assistant `message_end` 的 stopReason 定成败：
 *    `"stop"` 成功（文本 + D21 usage）；`"error"` 保留 errorMessage 原文；
 *    `"aborted"` 抛 AbortError；其他值可读失败不猜；无 assistant 消息失败。
 * LLM 失败退出码仍是 0（M0 ④.6 实测）——退出码 0 不代表成功，第 2 层永远要扫。
 */
function verdictOf(
	exitCode: number | null,
	exitSignal: string | null,
	assistant: AssistantOutcome | undefined,
	stderr: string,
): Verdict {
	if (exitCode !== 0) {
		const exitLabel =
			exitCode !== null
				? String(exitCode)
				: `signal ${exitSignal ?? "unknown"}`;
		const summary = compressStderr(stderr);
		return {
			ok: false,
			error: new Error(
				`pi CLI failed (exit ${exitLabel}): ${summary === "" ? "(no stderr output)" : summary}`,
			),
		};
	}
	if (assistant === undefined) {
		return {
			ok: false,
			error: new Error("pi agent produced no assistant message"),
		};
	}
	switch (assistant.stopReason) {
		case "stop": {
			// D21：usage 对象整体缺失 → 结果**连 usage 键都没有**（键在且值 undefined
			// 会让 "usage" in result 为真，破坏"缺失 → 不上报"的引擎契约）。
			const result: { output: string; usage?: TokenUsage } = {
				output: assistant.text,
			};
			if (typeof assistant.usage === "object" && assistant.usage !== null) {
				result.usage = toTokenUsage(assistant.usage as Record<string, unknown>);
			}
			return { ok: true, result };
		}
		case "error":
			return {
				ok: false,
				error: new Error(
					`pi agent failed: ${assistant.errorMessage ?? "(pi reported an error without a message)"}`,
				),
			};
		case "aborted":
			return { ok: false, error: abortError(assistant.errorMessage) };
		default:
			// 协议之外的 stopReason（未来值/脏数据）：失败要响，不猜成功。
			return {
				ok: false,
				error: new Error(
					`pi agent failed: unsupported stopReason "${String(assistant.stopReason)}"`,
				),
			};
	}
}

// ---------------------------------------------------------------------------
// 版本探测（D18/M0 ①）——进程内缓存（含失败）
// ---------------------------------------------------------------------------

/** 探测结果缓存（D18）：`undefined` = 还没探过；失败同样缓存（重装 pi 需重启进程）。 */
let probeCache: { kind: "ok" } | { kind: "failed"; error: Error } | undefined;

/** 清版本探测缓存（仅测试用：D18 的缓存以进程为界，测试需要用例间隔离）。 */
export function resetPiCliProbeForTests(): void {
	probeCache = undefined;
}

/** 解析裸 semver `x.y.z`（M0 ①：stdout 去空白后须整行匹配）。 */
function parseSemver(raw: string): [number, number, number] | undefined {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw);
	return match === null
		? undefined
		: [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** semver `^1.0.4` 区间判定（≥1.0.4 <2.0.0；无 semver 依赖——区间冻结，手写即准）。 */
function satisfiesCaretRange(version: [number, number, number]): boolean {
	const [major, minor, patch] = version;
	return major === 1 && (minor > 0 || patch >= 4);
}

/** D18 的可行动错误：含实测值、期望区间与两条可行动路线（装包 / 显式指 bin）。 */
function probeNotUsableError(
	observed: string,
	exitCode: number | null,
	stderr: string,
	spawnError: Error | undefined,
): Error {
	const detail =
		observed !== ""
			? observed
			: spawnError !== undefined
				? `spawn failed: ${messageOf(spawnError)}`
				: exitCode !== null && exitCode !== 0
					? `no version on stdout (exit ${exitCode}${stderr.trim() === "" ? "" : `: ${compressStderr(stderr)}`})`
					: "no version on stdout";
	return new Error(
		`pi CLI is not usable: expected version ^1.0.4 (verified against 1.0.4), got ${detail}; install @earendil-works/pi-coding-agent (npm i -g @earendil-works/pi-coding-agent) or set services.agent.subprocess.bin`,
	);
}

type ProbeOutcome =
	| { kind: "ok" }
	| { kind: "failed"; error: Error }
	| { kind: "aborted" };

/**
 * 单次探测：spawn `<bin> --version`（同 config 的 bin/cwd/env；stdin "ignore"——
 * M0 ①）。signal abort → 杀树 + `{ kind: "aborted" }`（**不缓存**——取消不是
 * "pi 不可用"的证据，缓存会被一次取消污染成永久失败）。
 */
function probeOnce(
	config: PiSubprocessConfig,
	signal: AbortSignal,
): Promise<ProbeOutcome> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve({ kind: "aborted" });
			return;
		}
		const child = spawn(config.bin ?? "pi", ["--version"], {
			shell: true, // 同主调用：bin 经 PATH/shim 解析（M0 ②）
			cwd: config.cwd ?? process.cwd(),
			stdio: ["ignore", "pipe", "pipe"], // M0 ①：--version 只看 stdout
			env: { ...process.env, ...config.env },
			detached: process.platform !== "win32",
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});

		let settled = false;
		const settle = (outcome: ProbeOutcome): void => {
			if (settled) {
				return;
			}
			settled = true;
			signal.removeEventListener("abort", onAbort);
			resolve(outcome);
		};
		const onAbort = (): void => {
			killTree(child); // 先杀（D19）
			settle({ kind: "aborted" });
		};
		signal.addEventListener("abort", onAbort, { once: true });

		child.on("error", (error) => {
			settle({
				kind: "failed",
				error: probeNotUsableError("", null, stderr, error),
			});
		});
		child.on("close", (code) => {
			const observed = stdout.trim();
			const version = parseSemver(observed);
			if (code === 0 && version !== undefined && satisfiesCaretRange(version)) {
				settle({ kind: "ok" });
				return;
			}
			settle({
				kind: "failed",
				error: probeNotUsableError(observed, code, stderr, undefined),
			});
		});
	});
}

/**
 * D18：首次真正调用 executor 时惰性探测（compile 是同步函数，不能在 compile 期
 * spawn）。结果进程内缓存（含失败）——成功后续调用零探测开销；失败把错误缓存下来，
 * 同进程后续调用直接复抛同一错误。
 */
async function ensurePiCliUsable(
	config: PiSubprocessConfig,
	signal: AbortSignal,
): Promise<void> {
	if (probeCache?.kind === "ok") {
		return;
	}
	if (probeCache?.kind === "failed") {
		throw probeCache.error;
	}
	const outcome = await probeOnce(config, signal);
	if (outcome.kind === "aborted") {
		return; // 不缓存；调用方随即按 signal.aborted 快速失败（D19）
	}
	if (outcome.kind === "ok") {
		probeCache = { kind: "ok" };
		return;
	}
	probeCache = { kind: "failed", error: outcome.error };
	throw outcome.error;
}

// ---------------------------------------------------------------------------
// 主调用：spawn + stdin + 解析 + abort 监听 + 判定
// ---------------------------------------------------------------------------

const noop = (): void => {};

/**
 * 一次 agent 调用的子进程生命周期：spawn（冻结模板）→ stdin 写 task 即关（D17）→
 * 流式解析 stdout/收集 stderr → abort 即杀树 + 快速 reject（D19）→ close 时双层
 * 判定（D16）。
 */
function runPiAgent(
	config: PiSubprocessConfig,
	req: Parameters<AgentExecutor>[0],
): Promise<{ output: string; usage?: TokenUsage }> {
	return new Promise((resolve, reject) => {
		const { command, args, opts } = buildSpawnArgs(config, req);
		const child = spawn(command, args, opts);

		let settled = false;
		const settle = (
			outcome: { output: string; usage?: TokenUsage } | Error,
		): void => {
			if (settled) {
				return;
			}
			settled = true;
			// 成功路径移除监听；失败/取消路径同样清理（signal 可能被引擎复用）。
			req.signal.removeEventListener("abort", onAbort);
			if (outcome instanceof Error) {
				reject(outcome);
			} else {
				resolve(outcome);
			}
		};
		const onAbort = (): void => {
			killTree(child); // 先杀后 reject（D19）：发出即算杀，不等消亡
			settle(abortError(undefined));
		};
		req.signal.addEventListener("abort", onAbort, { once: true });

		// D17（M0 ③.4）：task 只走 stdin——写完立即 end()，不关挂死。
		// 杀树/退出后父端写入可能 EPIPE：预期噪声，吞掉（成败由 close/abort 驱动）。
		child.stdin?.on("error", noop);
		child.stdin?.write(req.task);
		child.stdin?.end();

		const parser = createEventStreamParser();
		child.stdout?.on("error", noop);
		child.stdout?.setEncoding("utf8"); // 按字符解码：跨 chunk 的多字节序列由 Node 拼全
		child.stdout?.on("data", (chunk: string) => {
			parser.feed(chunk);
		});

		// stderr 收集上限 8KB（只服务第 1 层失败消息，无需全量保留）。
		const stderrChunks: Buffer[] = [];
		let stderrBytes = 0;
		child.stderr?.on("error", noop);
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderrBytes >= STDERR_MAX_BYTES) {
				return;
			}
			const take = chunk.subarray(0, STDERR_MAX_BYTES - stderrBytes);
			stderrChunks.push(take);
			stderrBytes += take.length;
		});

		// spawn 本身失败（如 cwd 不存在/EMFILE）：shell:false 才常见；shell:true 下
		// 多数启动期错误表现为 cmd/sh 退出码非 0（第 1 层判定接手）。两路都接。
		child.on("error", (error) => {
			settle(
				new Error(`pi CLI could not be spawned: ${messageOf(error)}`, {
					cause: error,
				}),
			);
		});

		child.on("close", (code, signal) => {
			parser.end(); // 尾行不完整：解析失败丢弃（M0 ⑤.4）
			const verdict = verdictOf(
				code,
				signal,
				parser.result(),
				Buffer.concat(stderrChunks).toString("utf8"),
			);
			settle(verdict.ok ? verdict.result : verdict.error);
		});
	});
}

/**
 * 造一个 pi CLI subprocess 执行器（D20 的 `"subprocess"` 分支；graph.ts 在
 * resolveAgentExecutors 里调用）。同一 config 的多次调用共享版本探测缓存（D18）。
 */
export function createPiSubprocessExecutor(
	config: PiSubprocessConfig,
): AgentExecutor {
	return async (req) => {
		if (req.signal.aborted) {
			throw abortError(undefined); // 已取消：不 spawn（D19）
		}
		await ensurePiCliUsable(config, req.signal); // D18：惰性探测（含失败缓存）
		if (req.signal.aborted) {
			throw abortError(undefined); // 探测期间被取消：同样不 spawn
		}
		return runPiAgent(config, req);
	};
}
