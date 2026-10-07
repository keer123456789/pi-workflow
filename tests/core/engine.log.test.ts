/**
 * Task 3：引擎的 run 日志接线（设计 §8、D2/D7/D8）。
 *
 * 契约：
 * - **默认开启**（D2）：`services.logger !== undefined` → 原样使用（`{}` = 全静默）；
 *   否则内置 JSONL 实现，目录 = `options.logDir || PI_WORKFLOW_LOG_DIR || ".pi-workflow/runs"`（空串回落）
 *   （**每次 run** 解析），文件 `<dir>/<时间戳>-<runId>/run.jsonl`；
 * - **双路同源**（D7/D9）：onEvent 与 logger 同序、同一个（脱敏后的）事件对象；
 *   `logOutputs: "hash"` 时三字段 → `"sha256:<64hex>"`，两路都见摘要；
 * - **失败策略**（D8）：`fail`（默认）任一钩子抛错 → run 拒绝——`onRunStart` 抛错时
 *   **一个事件都不发**；`onEvent` 抛错走失败出口（`superstep_aborted` + `run_finished{failed}`）；
 *   `onRunFinish` 抛错在 `run_finished` 之后拒绝；`warn` 只 console.warn 并继续；
 * - **预检失败**（初始 state 非法 / 已 abort 的 signal）不碰 logger：不建目录、不发事件。
 *
 * 夹具目录一律 `os.tmpdir()` 下 `mkdtempSync`，`afterEach` 递归清理——仓库工作树零残留。
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GraphValidationError, WorkflowError } from "../../src/core/errors.js";
import { StateGraph } from "../../src/core/graph.js";
import {
	END,
	type RunEvent,
	type RunOptions,
	type RunResult,
	START,
} from "../../src/core/types.js";
import type { RunLogger } from "../../src/log/runlog.js";
import { fnNode } from "../../src/nodes/fn.js";

/** 本次用例创建的临时根目录（afterEach 统一递归删除）。 */
let tempRoots: string[] = [];

function makeTempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-workflow-engine-log-"));
	tempRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of tempRoots) {
		rmSync(root, { recursive: true, force: true });
	}
	tempRoots = [];
	vi.restoreAllMocks();
});

/** 运行并交出 rejection 的错误本体（断言错误字段用）。 */
async function captureRejection(
	runPromise: Promise<unknown>,
): Promise<unknown> {
	try {
		await runPromise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the run to reject, but it resolved");
}

type LogState = { v?: number; note?: string };

/** START → a → b → END：两次提交、两组 node_started/node_finished。 */
function twoNodeGraph(): StateGraph<LogState> {
	return new StateGraph<LogState>({ name: "log-graph" })
		.addNode(
			"a",
			fnNode<LogState>(() => ({ v: 1 })),
		)
		.addNode(
			"b",
			fnNode<LogState>(() => ({ v: 2 })),
		)
		.addEdge(START, "a")
		.addEdge("a", "b")
		.addEdge("b", END);
}

/** 本次 run 的 JSONL 文件路径：目录名以 `-<runId>` 结尾且只应有一个。 */
function findRunFile(root: string, runId: string): string {
	const entries = readdirSync(root).filter((name) =>
		name.endsWith(`-${runId}`),
	);
	expect(entries).toHaveLength(1);
	return join(root, entries[0], "run.jsonl");
}

/** 读回 JSONL：末行以 `\n` 结束（D9），逐行 JSON.parse。 */
function parseJsonl(file: string): RunEvent[] {
	const text = readFileSync(file, "utf8");
	expect(text.endsWith("\n")).toBe(true);
	return text
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as RunEvent);
}

/** 取指定类型的事件（带类型收窄）。 */
function ofType<T extends RunEvent["type"]>(
	events: readonly RunEvent[],
	type: T,
): Extract<RunEvent, { type: T }>[] {
	return events.filter((event) => event.type === type) as Extract<
		RunEvent,
		{ type: T }
	>[];
}

/**
 * "不可打印"的抛值（R2）：null 原型（`String(value)` → TypeError）+ 抛错的 `toJSON`
 * （`JSON.stringify(value)` → 抛）——`messageOf` 的两条渲染路都会抛，修前异常会从
 * `emitter.emit` 逃逸。注意**纯** `Object.create(null)` 不触发这条路径：
 * JSON.stringify 返回 `"{}"`，渲染成功（测试里两种值都覆盖）。
 */
function unprintableThrown(): unknown {
	const value = Object.create(null) as Record<string, unknown>;
	value.toJSON = () => {
		throw new Error("no json");
	};
	return value;
}

describe("engine × run log (D2/D7/D8/D9)", () => {
	it("writes run_started / node events / run_finished to the default JSONL when logDir is provided", async () => {
		const dir = makeTempRoot();
		const events: RunEvent[] = [];

		const result: RunResult<LogState> = await twoNodeGraph()
			.compile()
			.run({ v: 0 }, { logDir: dir, onEvent: (event) => events.push(event) });

		expect(result.state).toEqual({ v: 2 });
		const file = findRunFile(dir, result.runId);
		expect(existsSync(file)).toBe(true);

		const lines = parseJsonl(file);
		// 两路**同序同内容**（完成序；同一个事件对象的 JSON 快照）
		expect(lines).toEqual(events);
		expect(lines.map((event) => event.type)).toEqual([
			"run_started",
			"node_started",
			"node_finished",
			"superstep_committed",
			"node_started",
			"node_finished",
			"superstep_committed",
			"run_finished",
		]);
		// 头部：run_started（graph/初始 input/superstep 0/runId），尾部：run_finished completed
		const started = ofType(lines, "run_started")[0];
		expect(started).toMatchObject({
			graph: "log-graph",
			superstep: 0,
			runId: result.runId,
		});
		expect(started.input).toEqual({ v: 0 });
		const finished = ofType(lines, "run_finished")[0];
		expect(finished).toMatchObject({
			status: "completed",
			runId: result.runId,
		});
		expect(finished.durationMs).toBeGreaterThanOrEqual(0);
		// 实例事件带 node/instanceId（D9 样例的字段面）
		expect(
			ofType(lines, "node_started").map((event) => event.instanceId),
		).toEqual(["a#1", "b#2"]);
		// seq 全局单调递增（文件序 = 完成序）
		expect(lines.map((event) => event.seq)).toEqual(
			lines.map((_, index) => index + 1),
		);
	});

	it("hash mode redacts input/output on BOTH the file and onEvent (sha256:<hex>)", async () => {
		const dir = makeTempRoot();
		const events: RunEvent[] = [];
		const secret = "绝密-并购底稿-42";

		const { runId } = await twoNodeGraph()
			.compile()
			.run(
				{ v: 0, note: secret },
				{
					logDir: dir,
					logOutputs: "hash",
					onEvent: (event) => events.push(event),
				},
			);

		const file = findRunFile(dir, runId);
		const lines = parseJsonl(file);
		// 两路拿到同一个脱敏后事件（文件 = onEvent 的 JSON 快照）
		expect(lines).toEqual(events);

		const started = ofType(lines, "run_started")[0];
		const outputs = ofType(lines, "node_finished");
		// D7 的公式：sha256(JSON.stringify(value))，前缀 "sha256:"、64 位小写 hex
		expect(started.input).toBe(
			`sha256:${createHashOf(JSON.stringify({ v: 0, note: secret }))}`,
		);
		expect(outputs.map((event) => event.output)).toEqual([
			`sha256:${createHashOf(JSON.stringify({ v: 1 }))}`,
			`sha256:${createHashOf(JSON.stringify({ v: 2 }))}`,
		]);
		for (const value of [
			started.input,
			...outputs.map((event) => event.output),
		]) {
			expect(String(value)).toMatch(/^sha256:[0-9a-f]{64}$/);
		}
		// 明文绝不落盘（法律文书敏感——脱敏的就是这个）
		expect(readFileSync(file, "utf8")).not.toContain(secret);
	});

	it("hands the same event object to onEvent and the logger (hash mode included)", async () => {
		const listenerEvents: RunEvent[] = [];
		const loggerEvents: RunEvent[] = [];
		const logger: RunLogger = {
			onEvent: (event) => loggerEvents.push(event),
		};

		await twoNodeGraph()
			.compile({ services: { logger } })
			.run(
				{ v: 0, note: "机密" },
				{
					logOutputs: "hash",
					onEvent: (event) => listenerEvents.push(event),
				},
			);

		expect(loggerEvents.map((event) => event.type)).toEqual(
			listenerEvents.map((event) => event.type),
		);
		for (const [index, event] of loggerEvents.entries()) {
			// 脱敏只做一次：两个 sink 收到**同一个对象**（D7"两路都见脱敏值"）
			expect(event).toBe(listenerEvents[index]);
			expect(event.seq).toBe(index + 1);
			expect(event.runId).toBe(loggerEvents[0].runId);
		}
		expect(String(ofType(loggerEvents, "run_started")[0].input)).toMatch(
			/^sha256:[0-9a-f]{64}$/,
		);
	});

	it("calls onRunStart after preflight/before run_started, and onRunFinish after run_finished", async () => {
		const order: string[] = [];
		const startInfos: { runId: string; graph: string; ts: number }[] = [];
		const finishInfos: {
			runId: string;
			status: "completed" | "failed";
			ts: number;
		}[] = [];
		const logger: RunLogger = {
			onRunStart: (info) => {
				startInfos.push(info);
				order.push("onRunStart");
			},
			onEvent: (event) => order.push(event.type),
			onRunFinish: (info) => {
				finishInfos.push(info);
				order.push(`onRunFinish:${info.status}`);
			},
		};

		const { runId } = await twoNodeGraph()
			.compile({ services: { logger } })
			.run({ v: 0 });

		// 时机契约（D6/D8）：start 在 run_started 之前；finish 在 run_finished 之后
		expect(order[0]).toBe("onRunStart");
		expect(order[1]).toBe("run_started");
		expect(order.at(-2)).toBe("run_finished");
		expect(order.at(-1)).toBe("onRunFinish:completed");
		expect(startInfos).toHaveLength(1);
		expect(startInfos[0]).toMatchObject({ runId, graph: "log-graph" });
		expect(typeof startInfos[0].ts).toBe("number");
		expect(finishInfos).toHaveLength(1);
		expect(finishInfos[0]).toMatchObject({ runId, status: "completed" });
		expect(typeof finishInfos[0].ts).toBe("number");
	});

	it("falls back to full mode for an invalid logOutputs value", async () => {
		const dir = makeTempRoot();

		const { runId } = await twoNodeGraph()
			.compile()
			.run(
				{ v: 0 },
				{
					logDir: dir,
					logOutputs: "HASH" as unknown as RunOptions["logOutputs"],
				},
			);

		// 非法值回落缺省 "full"：input 原样落盘（未脱敏）
		const started = ofType(
			parseJsonl(findRunFile(dir, runId)),
			"run_started",
		)[0];
		expect(started.input).toEqual({ v: 0 });
	});

	it("falls back to the fail policy for an invalid onLogError value", async () => {
		const boom = new Error("boom");
		const logger: RunLogger = {
			onEvent: () => {
				throw boom;
			},
		};

		const error = await captureRejection(
			twoNodeGraph()
				.compile({ services: { logger } })
				.run(
					{ v: 0 },
					{ onLogError: "nope" as unknown as RunOptions["onLogError"] },
				),
		);

		expect(error).toBeInstanceOf(WorkflowError);
		expect((error as Error).cause).toBe(boom);
	});

	it("onLogError 'fail' rejects the run when the logger throws at start (no events at all)", async () => {
		const dir = makeTempRoot();
		// dir 指向一个已存在的**文件**：内置 logger 的 onRunStart（mkdir）必然失败
		const blocked = join(dir, "blocked");
		writeFileSync(blocked, "occupied");
		const events: RunEvent[] = [];

		const error = await captureRejection(
			twoNodeGraph()
				.compile()
				.run(
					{ v: 0 },
					{ logDir: blocked, onEvent: (event) => events.push(event) },
				),
		);

		expect(error).toBeInstanceOf(WorkflowError);
		// 消息 = logger 原错的文本（T2 裁定：不重复拼 "run log write failed: " 前缀）
		const cause = (error as Error).cause as Error;
		expect(cause).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(cause.message);
		expect((error as Error).message).toMatch(/^run log write failed: /);
		expect((error as Error).message).toContain(blocked);
		// cause 是内置 logger 的包装错误，它自带 fs 原错
		expect(cause.cause).toBeInstanceOf(Error);
		// preflight 已过、但 onRunStart 先于 run_started 失败：一个事件都不发（含 run_finished）
		expect(events).toEqual([]);
	});

	it("onLogError 'fail' rejects the run when onRunFinish throws after run_finished", async () => {
		const finishBoom = new Error("finish boom");
		const events: RunEvent[] = [];
		const logger: RunLogger = {
			onRunFinish: () => {
				throw finishBoom;
			},
		};

		const error = await captureRejection(
			twoNodeGraph()
				.compile({ services: { logger } })
				.run({ v: 0 }, { onEvent: (event) => events.push(event) }),
		);

		// 拒绝发生在 run_finished **之后**：事件流完整，且最后一条就是 completed
		expect(events.at(-1)?.type).toBe("run_finished");
		expect(events.at(-1)).toMatchObject({ status: "completed" });
		expect(
			events.filter((event) => event.type === "superstep_committed"),
		).toHaveLength(2);
		// 自定义 logger 的原始错误：引擎补一次契约前缀（D8 的消息面），cause 附原错
		expect(error).toBeInstanceOf(WorkflowError);
		expect((error as Error).message).toBe("run log write failed: finish boom");
		expect((error as Error).cause).toBe(finishBoom);
	});

	it("onLogError 'fail' rejects mid-run through the failure exit (superstep_aborted + run_finished failed)", async () => {
		const midBoom = new Error("mid boom");
		const events: RunEvent[] = [];
		const logger: RunLogger = {
			onEvent: (event) => {
				if (event.type === "node_started") {
					throw midBoom;
				}
			},
		};

		const error = await captureRejection(
			twoNodeGraph()
				.compile({ services: { logger } })
				.run({ v: 0 }, { onEvent: (event) => events.push(event) }),
		);

		// 审计优先（D2）：日志一断即中止 run——失败出口是本超步不提交 + run_finished{failed}；
		// 两路事件照发（sink 的失败不吞 onEvent 投递）
		expect(events.map((event) => event.type)).toEqual([
			"run_started",
			"node_started",
			"superstep_aborted",
			"run_finished",
		]);
		expect(ofType(events, "node_started")[0].instanceId).toBe("a#1");
		expect(events.at(-1)).toMatchObject({
			type: "run_finished",
			status: "failed",
			superstep: 1,
		});
		expect(error).toBeInstanceOf(WorkflowError);
		expect((error as Error).message).toBe("run log write failed: mid boom");
		expect((error as Error).cause).toBe(midBoom);
	});

	it("onLogError 'warn' logs console.warn and still resolves", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const boom = new Error("event boom");
		const logger: RunLogger = {
			onEvent: () => {
				throw boom;
			},
		};

		const result = await twoNodeGraph()
			.compile({ services: { logger } })
			.run({ v: 0 }, { onLogError: "warn" });

		// run 完全不受影响（状态照常提交、promise 照常 resolve）
		expect(result.state).toEqual({ v: 2 });
		expect(warn).toHaveBeenCalled();
		// D8 的确切降级形态：console.warn("pi-workflow: run log write failed: <原因>")
		expect(warn.mock.calls[0][0]).toBe(
			"pi-workflow: run log write failed: event boom",
		);
		for (const call of warn.mock.calls) {
			expect(call[0]).toMatch(/^pi-workflow: run log write failed: /);
		}
	});

	it("onLogError 'fail' still rejects with the D8 message when the thrown value is unprintable", async () => {
		// R2：不可打印的抛值不得让异常从 emit 逃逸（那会绕过整个 D8 消息面）。
		for (const [thrown, expected] of [
			// 纯 Object.create(null)：JSON.stringify 出 "{}"，渲染得了（不进兜底）
			[Object.create(null), "run log write failed: {}"],
			// null 原型 + 抛错的 toJSON：JSON.stringify 与 String() **两条渲染路都抛** → 兜底文本
			[unprintableThrown(), "run log write failed: [unprintable error]"],
		] as const) {
			const logger: RunLogger = {
				onEvent: () => {
					throw thrown;
				},
			};

			const error = await captureRejection(
				twoNodeGraph().compile({ services: { logger } }).run({ v: 0 }),
			);

			// (a) fail 策略：仍以带前缀的 WorkflowError 拒绝（不外泄裸错）……
			expect(error).toBeInstanceOf(WorkflowError);
			expect((error as Error).message).toBe(expected);
			expect((error as Error).cause).toBe(thrown);
		}
	});

	it("onLogError 'warn' warns with the fallback text and keeps running for unprintable throws", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const thrown = unprintableThrown();
		const logger: RunLogger = {
			onEvent: () => {
				throw thrown;
			},
		};

		const result = await twoNodeGraph()
			.compile({ services: { logger } })
			.run({ v: 0 }, { onLogError: "warn" });

		// (b) warn 策略：照常 warn + 继续，run 不受影响
		expect(result.state).toEqual({ v: 2 });
		expect(warn.mock.calls[0][0]).toBe(
			"pi-workflow: run log write failed: [unprintable error]",
		);
	});

	it("falls back past an empty logDir to the env / default directory (never cwd)", async () => {
		const dir = makeTempRoot();
		const previous = process.env.PI_WORKFLOW_LOG_DIR;
		process.env.PI_WORKFLOW_LOG_DIR = dir;
		try {
			// R2：`logDir: ""` 是空相对路径（会落到 cwd）——与 null/undefined 一样回落下一级
			const { runId } = await twoNodeGraph()
				.compile()
				.run({ v: 0 }, { logDir: "" });

			const lines = parseJsonl(findRunFile(dir, runId));
			expect(lines[0]).toMatchObject({ type: "run_started", runId });
			expect(lines.at(-1)).toMatchObject({
				type: "run_finished",
				status: "completed",
				runId,
			});
		} finally {
			if (previous === undefined) {
				delete process.env.PI_WORKFLOW_LOG_DIR;
			} else {
				process.env.PI_WORKFLOW_LOG_DIR = previous;
			}
		}
	});

	it("logs by default to PI_WORKFLOW_LOG_DIR (env) when nothing is configured", async () => {
		const dir = makeTempRoot();
		const previous = process.env.PI_WORKFLOW_LOG_DIR;
		// 默认目录**每次 run** 解析：测试期后设的 env 覆盖也生效
		process.env.PI_WORKFLOW_LOG_DIR = dir;
		try {
			const { runId } = await twoNodeGraph().compile().run({ v: 0 });

			const lines = parseJsonl(findRunFile(dir, runId));
			expect(lines[0]).toMatchObject({ type: "run_started", runId });
			expect(lines.at(-1)).toMatchObject({
				type: "run_finished",
				status: "completed",
				runId,
			});
		} finally {
			if (previous === undefined) {
				delete process.env.PI_WORKFLOW_LOG_DIR;
			} else {
				process.env.PI_WORKFLOW_LOG_DIR = previous;
			}
		}
	});

	it("services.logger {} silences completely (no directory, onEvent unaffected)", async () => {
		const dir = makeTempRoot();
		const events: RunEvent[] = [];

		const { state } = await twoNodeGraph()
			.compile({ services: { logger: {} } })
			.run({ v: 0 }, { logDir: dir, onEvent: (event) => events.push(event) });

		expect(state).toEqual({ v: 2 });
		// 显式关闭 = 连目录都不建（logDir 被忽略：默认工厂根本没被调用）
		expect(readdirSync(dir)).toEqual([]);
		expect(events.map((event) => event.type)).toContain("run_finished");
	});

	it("preflight rejection (invalid initial state) writes no log file", async () => {
		const dir = makeTempRoot();
		const events: RunEvent[] = [];
		const graph = new StateGraph<{ x?: number; y?: number }>({
			stateSchema: Type.Object({ x: Type.Number() }),
		})
			.addNode(
				"a",
				fnNode<{ x?: number; y?: number }>(() => ({ x: 1 })),
			)
			.addEdge(START, "a")
			.addEdge("a", END);

		const error = await captureRejection(
			graph
				.compile()
				.run({ y: 2 }, { logDir: dir, onEvent: (event) => events.push(event) }),
		);

		expect(error).toBeInstanceOf(GraphValidationError);
		// 预检失败不碰 logger（D8 末句）：不建目录、不建文件、一个事件都不发
		expect(readdirSync(dir)).toEqual([]);
		expect(events).toEqual([]);
	});

	it("preflight rejection (already-aborted signal) writes no log file", async () => {
		const dir = makeTempRoot();
		const events: RunEvent[] = [];
		const controller = new AbortController();
		controller.abort();

		const error = await captureRejection(
			twoNodeGraph()
				.compile()
				.run(
					{ v: 0 },
					{
						logDir: dir,
						signal: controller.signal,
						onEvent: (event) => events.push(event),
					},
				),
		);

		expect(error).toBeInstanceOf(WorkflowError);
		expect((error as Error).message).toBe("run cancelled");
		expect(readdirSync(dir)).toEqual([]);
		expect(events).toEqual([]);
	});
});

/** D7 摘要输入的参照实现（避免把被测代码的 helper 当作断言依据）。 */
function createHashOf(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
