/**
 * Task 10：超步原子性与运行期合并冲突（设计 §5.1:316-354、§6.7、§7.1）。
 *
 * 契约：
 * - 本超步全部实例跑完再决策（BSP）：任一实例失败 → **不提交**、`superstep_aborted`，
 *   失败事件序 node_failed → superstep_aborted → run_finished{failed}；
 * - 提交期折叠失败（reducer-less 冲突 / reducer 抛错 / 未知 key）→ 不提交、
 *   `superstep_aborted`，`InvalidWriteError` **原样透传**（不包 NodeExecutionError）；
 * - committed 边界语义：不做逐事件打标，消费方按最近的 superstep_committed /
 *   superstep_aborted 判定（设计 §8.1 的打标在 M1 由边界替代）；
 * - 失败确定性：实例序最小的失败赢得重抛（与完成序无关）；
 * - §6.7：初始 state 过 stateSchema；节点返回未知 key 抛 InvalidWriteError；
 * - §5.1:352：开发模式（NODE_ENV !== "production"）深冻结实例输入（原地，不克隆）。
 *
 * 本任务不含信号/预算/重试（T11/T12）：失败不取消兄弟实例，collateral 恒为空。
 */

import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import { executeRun, resolveServices } from "../../src/core/engine.js";
import {
	GraphRecursionError,
	GraphValidationError,
	InvalidWriteError,
	NodeExecutionError,
	WorkflowError,
} from "../../src/core/errors.js";
import { StateGraph } from "../../src/core/graph.js";
import { Send } from "../../src/core/send.js";
import { append } from "../../src/core/state.js";
import {
	type CompiledGraphData,
	END,
	type NodeDefinition,
	type NodeHandler,
	type RunEvent,
	type RunOptions,
	type RunResult,
	START,
} from "../../src/core/types.js";
import { fnNode } from "../../src/nodes/fn.js";

/** 任务 brief 的 `g.run(...)` 简写：编译（无参）后跑一次。 */
function run<S extends object>(
	graph: StateGraph<S>,
	initial: S,
	options?: RunOptions,
): Promise<RunResult<S>> {
	return graph.compile().run(initial, options);
}

/** 取指定 type 的事件（带类型收窄）。 */
function ofType<T extends RunEvent["type"]>(
	events: readonly RunEvent[],
	type: T,
): Extract<RunEvent, { type: T }>[] {
	return events.filter((event) => event.type === type) as Extract<
		RunEvent,
		{ type: T }
	>[];
}

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

/** 事件类型序列（只保留关心的类型，避免依赖并发完成序）。 */
function sequence(
	events: readonly RunEvent[],
	types: readonly RunEvent["type"][],
): string[] {
	return events
		.filter((event) => types.includes(event.type))
		.map((event) => event.type);
}

type BasicState = { x?: number };

/** START → a、START → b 的并联图；两个节点都写 reducer-less 的 x。 */
function racingWriters(
	writeA: () => Partial<BasicState>,
	writeB: () => Partial<BasicState>,
): StateGraph<BasicState> {
	return new StateGraph<BasicState>()
		.addNode("a", fnNode<BasicState>(writeA))
		.addNode("b", fnNode<BasicState>(writeB))
		.addEdge(START, "a")
		.addEdge(START, "b")
		.addEdge("a", END)
		.addEdge("b", END);
}

/** 自环图：每超步跑一次 "loop"，用于 recursionLimit 断言。 */
function selfLoop(counter: { runs: number }): StateGraph<BasicState> {
	return new StateGraph<BasicState>()
		.addNode(
			"loop",
			fnNode<BasicState>(() => {
				counter.runs += 1;
				return { x: counter.runs };
			}),
		)
		.addEdge(START, "loop")
		.addEdge("loop", "loop");
}

describe("superstep atomicity: commit rules (设计 §5.1:326-332)", () => {
	it("concurrent write to a reducer-less key throws InvalidWriteError listing both node names", async () => {
		const events: RunEvent[] = [];
		const g = racingWriters(
			() => ({ x: 1 }),
			() => ({ x: 2 }),
		);

		const error = await captureRejection(
			run(g, {}, { onEvent: (e) => events.push(e) }),
		);

		expect(error).toBeInstanceOf(InvalidWriteError);
		const conflict = error as InvalidWriteError;
		expect(conflict.key).toBe("x");
		// 写入者按实例序（a#1 → b#2），不是完成序
		expect(conflict.writers).toEqual(["a", "b"]);
		// 原样透传：折叠失败不包成 NodeExecutionError
		expect(error).not.toBeInstanceOf(NodeExecutionError);
		// 整个超步不提交：只有 aborted 边界，没有 committed
		expect(ofType(events, "superstep_committed")).toHaveLength(0);
		expect(sequence(events, ["superstep_aborted", "run_finished"])).toEqual([
			"superstep_aborted",
			"run_finished",
		]);
		expect(ofType(events, "run_finished")[0].status).toBe("failed");
	});

	it("propagates a reducer failure in the fold phase as InvalidWriteError without committing", async () => {
		type S = { log: string[] };
		const events: RunEvent[] = [];

		const g = new StateGraph<S>({ channels: { log: append } })
			.addNode(
				"a",
				fnNode<S>(() => ({ log: ["a"] })),
			)
			.addNode(
				// 把非数组写进 append channel：reducer 抛错 → foldUpdates 包装成 InvalidWriteError
				"bad",
				fnNode<S>((() => ({ log: "not-an-array" })) as unknown as NodeHandler<
					S,
					S
				>),
			)
			.addEdge(START, "a")
			.addEdge(START, "bad")
			.addEdge("a", END)
			.addEdge("bad", END);

		const error = await captureRejection(
			run(g, { log: [] }, { onEvent: (e) => events.push(e) }),
		);

		expect(error).toBeInstanceOf(InvalidWriteError);
		expect((error as InvalidWriteError).key).toBe("log");
		expect((error as InvalidWriteError).writers).toEqual(["bad"]);
		expect(error).not.toBeInstanceOf(NodeExecutionError);
		expect(ofType(events, "superstep_committed")).toHaveLength(0);
		expect(ofType(events, "superstep_aborted")).toHaveLength(1);
		expect(ofType(events, "run_finished")[0].status).toBe("failed");
	});

	it("commits normally when each node writes its own key (control)", async () => {
		type S = { x?: number; y?: number };
		const { state } = await run(
			new StateGraph<S>()
				.addNode(
					"a",
					fnNode<S>(() => ({ x: 1 })),
				)
				.addNode(
					"b",
					fnNode<S>(() => ({ y: 2 })),
				)
				.addEdge(START, "a")
				.addEdge(START, "b")
				.addEdge("a", END)
				.addEdge("b", END),
			{},
		);

		expect(state).toEqual({ x: 1, y: 2 });
	});
});

describe("superstep atomicity: failed superstep (设计 §5.1:323-325)", () => {
	it("does not commit a superstep whose sibling failed; node_failed → superstep_aborted → failed run_finished", async () => {
		const events: RunEvent[] = [];
		const boom = new Error("b blew up");
		const g = racingWriters(
			() => ({ x: 1 }),
			() => {
				throw boom;
			},
		);

		const error = await captureRejection(
			run(g, {}, { onEvent: (e) => events.push(e) }),
		);

		expect(error).toBeInstanceOf(NodeExecutionError);
		const nodeError = error as NodeExecutionError;
		expect(nodeError.node).toBe("b");
		expect(nodeError.instanceId).toBe("b#2");
		expect(nodeError.cause).toBe(boom);
		// 本任务没有信号取消：collateral 仍为空（T11）
		expect(nodeError.collateral).toEqual([]);

		expect(
			sequence(events, ["node_failed", "superstep_aborted", "run_finished"]),
		).toEqual(["node_failed", "superstep_aborted", "run_finished"]);
		expect(ofType(events, "run_finished")[0].status).toBe("failed");
		// 兄弟实例跑完了（node_finished 在），结果被丢弃：超步原子性
		expect(ofType(events, "node_finished").map((e) => e.node)).toEqual(["a"]);
		expect(ofType(events, "superstep_committed")).toHaveLength(0);
	});

	it("rethrows the failure that triggered the cancellation; a lower-seq sibling failing after its own abort is collateral (R20a)", async () => {
		const events: RunEvent[] = [];
		const aBoom = new Error("a boom");
		let releaseA: () => void = () => {};
		const aGate = new Promise<void>((resolve) => {
			releaseA = resolve;
		});

		const g = new StateGraph<BasicState>()
			.addNode(
				"a",
				fnNode<BasicState>(async () => {
					await aGate;
					throw aBoom;
				}),
			)
			.addNode(
				"b",
				fnNode<BasicState>(() => {
					releaseA(); // b 先失败（完成序上 node_failed 先发），并 fail-fast 取消 a
					throw new Error("b boom");
				}),
			)
			.addEdge(START, "a")
			.addEdge(START, "b")
			.addEdge("a", END)
			.addEdge("b", END);

		const error = await captureRejection(
			run(g, {}, { onEvent: (e) => events.push(e) }),
		);

		// b 先失败并取消 a（a 的信号在它抛出 aBoom 之前就已 abort）：
		// 按 R20a，取消后到达的失败一律是"被取消"（判定与错误形状无关），进 collateral，
		// 不与根因竞争——根因是 b#2（唯一真正确认过的失败），a 不发光 node_failed。
		expect(ofType(events, "node_failed").map((e) => e.node)).toEqual(["b"]);
		expect(error).toBeInstanceOf(NodeExecutionError);
		const nodeError = error as NodeExecutionError;
		expect(nodeError.instanceId).toBe("b#2");
		expect((nodeError.cause as Error).message).toBe("b boom");
		expect(nodeError.collateral).toEqual(["a#1"]);
		expect(aBoom.message).toBe("a boom"); // a 的原始错误只作废，不进入根因
		// 两个失败落在同一个 aborted 边界内
		expect(ofType(events, "superstep_aborted")).toHaveLength(1);
	});
});

describe("runtime stateSchema obligations (设计 §6.7)", () => {
	const schema = Type.Object({ x: Type.Number() });

	function graphWithSchema(): StateGraph<{ x?: number; y?: number }> {
		return new StateGraph<{ x?: number; y?: number }>({ stateSchema: schema })
			.addNode(
				"a",
				fnNode<{ x?: number; y?: number }>(() => ({ x: 1 })),
			)
			.addEdge(START, "a")
			.addEdge("a", END);
	}

	it("rejects an initial state that does not match stateSchema before the run starts", async () => {
		const events: RunEvent[] = [];
		const g = graphWithSchema();

		const error = await captureRejection(
			g.compile().run({ y: 2 }, { onEvent: (e) => events.push(e) }),
		);

		expect(error).toBeInstanceOf(GraphValidationError);
		const invalid = error as GraphValidationError;
		expect(invalid.message).toBe("initial state does not match stateSchema");
		expect(invalid.issues.length).toBeGreaterThan(0);
		expect(invalid.issues.join(" | ")).toContain("x");
		// 校验先于 run：一个事件都没发（run_started 都没有）
		expect(events).toEqual([]);
	});

	it("runs normally when the initial state matches stateSchema (control)", async () => {
		const { state } = await run(graphWithSchema(), { x: 0 });

		expect(state.x).toBe(1);
	});

	it("throws InvalidWriteError for an output key outside stateSchema, without committing", async () => {
		const events: RunEvent[] = [];
		const g = new StateGraph<{ x?: number; y?: number }>({
			stateSchema: schema,
		})
			.addNode(
				"a",
				fnNode<{ x?: number; y?: number }>(() => ({ y: 2 })),
			)
			.addEdge(START, "a")
			.addEdge("a", END);

		const error = await captureRejection(
			run(g, { x: 0 }, { onEvent: (e) => events.push(e) }),
		);

		expect(error).toBeInstanceOf(InvalidWriteError);
		const writeError = error as InvalidWriteError;
		expect(writeError.key).toBe("y");
		expect(writeError.writers).toEqual(["a"]);
		expect(error).not.toBeInstanceOf(NodeExecutionError);
		expect(ofType(events, "superstep_committed")).toHaveLength(0);
		expect(ofType(events, "superstep_aborted")).toHaveLength(1);
		expect(ofType(events, "run_finished")[0].status).toBe("failed");
	});

	it("does not check output keys when no stateSchema is provided (unchanged behavior)", async () => {
		type S = { x?: number; y?: number };
		const { state } = await run(
			new StateGraph<S>()
				.addNode(
					"a",
					fnNode<S>(() => ({ y: 2 })),
				)
				.addEdge(START, "a")
				.addEdge("a", END),
			{},
		);

		expect(state.y).toBe(2);
	});
});

describe("handler return shape (T8 review)", () => {
	it("treats undefined and null returns as no writes", async () => {
		type S = { v?: number };
		const g = new StateGraph<S>()
			.addNode(
				"undef",
				fnNode<S>((() => undefined) as unknown as NodeHandler<S, S>),
			)
			.addNode("nil", fnNode<S>((() => null) as unknown as NodeHandler<S, S>))
			.addEdge(START, "undef")
			.addEdge(START, "nil")
			.addEdge("undef", END)
			.addEdge("nil", END);

		const { state } = await run(g, { v: 1 });

		expect(state).toEqual({ v: 1 });
	});

	it("fails the node for an array return (no longer a silent no-op)", async () => {
		const events: RunEvent[] = [];
		const g = new StateGraph<BasicState>()
			.addNode(
				"bad",
				fnNode<BasicState>((() => [1, 2]) as unknown as NodeHandler<
					BasicState,
					BasicState
				>),
			)
			.addEdge(START, "bad")
			.addEdge("bad", END);

		const error = await captureRejection(
			run(g, {}, { onEvent: (e) => events.push(e) }),
		);

		expect(error).toBeInstanceOf(NodeExecutionError);
		const nodeError = error as NodeExecutionError;
		expect(nodeError.node).toBe("bad");
		expect(nodeError.cause).toBeInstanceOf(TypeError);
		expect(nodeError.message).toContain("Partial<S>");
		// 不是成功的空写入：node_failed（无 node_finished）+ 超步 aborted
		expect(ofType(events, "node_failed")[0].error).toContain("Partial<S>");
		expect(ofType(events, "node_finished")).toHaveLength(0);
		expect(ofType(events, "superstep_aborted")).toHaveLength(1);
	});

	it("fails the node for a primitive return", async () => {
		const g = new StateGraph<BasicState>()
			.addNode(
				"bad",
				fnNode<BasicState>(
					(() => 42) as unknown as NodeHandler<BasicState, BasicState>,
				),
			)
			.addEdge(START, "bad")
			.addEdge("bad", END);

		const error = await captureRejection(run(g, {}));

		expect(error).toBeInstanceOf(NodeExecutionError);
		expect((error as NodeExecutionError).cause).toBeInstanceOf(TypeError);
		expect((error as NodeExecutionError).message).toContain("number");
	});

	it("fails the node for a non-plain object return (Map / Date / class instance)", async () => {
		type S = { v?: number };
		class Custom {}
		const cases: { label: string; value: unknown }[] = [
			{ label: "Map", value: new Map([["v", 1]]) },
			{ label: "Date", value: new Date(0) },
			{ label: "Custom", value: new Custom() },
		];

		// Map/Date/类实例都是"对象"，但不是 Partial<S> 更新表：Object.keys 拿不到
		// 任何写入 → 静默 no-op（与数组同一类 bug）。必须按节点失败处理。
		for (const { label, value } of cases) {
			const g = new StateGraph<S>()
				.addNode(
					"bad",
					fnNode<S>((() => value) as unknown as NodeHandler<S, S>),
				)
				.addEdge(START, "bad")
				.addEdge("bad", END);

			const error = await captureRejection(run(g, {}));

			expect(error).toBeInstanceOf(NodeExecutionError);
			expect((error as NodeExecutionError).cause).toBeInstanceOf(TypeError);
			expect((error as NodeExecutionError).message).toContain(label);
		}
	});
});

describe("failure message rendering (T8 review)", () => {
	it("renders a non-Error thrown object via JSON, not [object Object]", async () => {
		const events: RunEvent[] = [];
		const g = new StateGraph<BasicState>()
			.addNode(
				"bad",
				fnNode<BasicState>(() => {
					throw { code: 429 };
				}),
			)
			.addEdge(START, "bad")
			.addEdge("bad", END);

		const error = await captureRejection(
			run(g, {}, { onEvent: (e) => events.push(e) }),
		);

		expect(ofType(events, "node_failed")[0].error).toBe('{"code":429}');
		expect((error as NodeExecutionError).message).toContain('{"code":429}');
	});

	it("falls back to String() when the thrown value cannot be JSON-serialized", async () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const g = new StateGraph<BasicState>()
			.addNode(
				"bad",
				fnNode<BasicState>(() => {
					throw circular;
				}),
			)
			.addEdge(START, "bad")
			.addEdge("bad", END);

		const error = await captureRejection(run(g, {}));

		// JSON.stringify 抛错也不能让渲染路径炸掉 run
		expect(error).toBeInstanceOf(NodeExecutionError);
		expect((error as NodeExecutionError).message).toContain("[object Object]");
	});
});

describe("writeTo commit semantics (设计 §5.1:354)", () => {
	/** 手搓 writeTo 定义：handler 返回"单个值"（非 Partial<S>），M1 的 NodeHandler 表达不了。 */
	function writeToNode<S extends object, I>(
		writeTo: string,
		handler: (input: Readonly<I>) => unknown,
	): NodeDefinition<S, I> {
		return {
			kind: "fn",
			name: "",
			handler: handler as unknown as NodeHandler<S, I>,
			writeTo,
		};
	}

	it("commits a writeTo node's return value as a single value under that key", async () => {
		type S = { result?: { ok: boolean } };
		const events: RunEvent[] = [];

		const g = new StateGraph<S>()
			.addNode(
				"writer",
				writeToNode<S, S>("result", () => ({ ok: true })),
			)
			.addEdge(START, "writer")
			.addEdge("writer", END);

		const { state } = await run(g, {}, { onEvent: (e) => events.push(e) });

		expect(state).toEqual({ result: { ok: true } });
		// node_finished.output 记录 handler 的原始返回值（不是写入表）
		expect(ofType(events, "node_finished")[0].output).toEqual({ ok: true });
	});

	it("folds Send instances of a writeTo node through the target key's reducer", async () => {
		type S = { parts: string[] };

		const g = new StateGraph<S>({ channels: { parts: append } })
			.addNode(
				"hub",
				fnNode<S>(() => ({})),
			)
			.addConditionalEdges("hub", () => [
				new Send("writer", { id: "a" }),
				new Send("writer", { id: "b" }),
			])
			.addNode(
				"writer",
				writeToNode<S, { id: string }>("parts", (input) => [input.id]),
			)
			.addEdge(START, "hub");

		const { state } = await run(g, { parts: [] });

		// 每个 Send 实例的返回值（数组）经 parts 的 append reducer 汇入
		expect(state.parts).toEqual(["a", "b"]);
	});

	it("treats two writeTo writes to a reducer-less key as a runtime write conflict", async () => {
		type S = { last?: string };
		const events: RunEvent[] = [];

		const g = new StateGraph<S>()
			.addNode(
				"hub",
				fnNode<S>(() => ({})),
			)
			.addConditionalEdges("hub", () => [
				new Send("writer", { id: "a" }),
				new Send("writer", { id: "b" }),
			])
			.addNode(
				"writer",
				writeToNode<S, { id: string }>("last", (input) => `v-${input.id}`),
			)
			.addEdge(START, "hub");

		const error = await captureRejection(
			run(g, {}, { onEvent: (e) => events.push(e) }),
		);

		expect(error).toBeInstanceOf(InvalidWriteError);
		expect((error as InvalidWriteError).key).toBe("last");
		expect((error as InvalidWriteError).writers).toEqual(["writer", "writer"]);
		expect(ofType(events, "superstep_aborted")).toHaveLength(1);
	});

	it("treats a writeTo node's undefined/null return as no writes (pin)", async () => {
		type S = { result?: unknown; marker: number };

		const g = new StateGraph<S>()
			.addNode(
				"undef",
				writeToNode<S, S>("result", () => undefined),
			)
			.addNode(
				"nil",
				writeToNode<S, S>("result", () => null),
			)
			.addEdge(START, "undef")
			.addEdge(START, "nil")
			.addEdge("undef", END)
			.addEdge("nil", END);

		const { state } = await run(g, { marker: 1 });

		// carry 6 的统一规则不豁免 writeTo：undefined/null 仍是"没有写入"
		expect(state).toEqual({ marker: 1 });
		expect("result" in state).toBe(false);
	});

	it("maps writeTo outputs in lastUpdate as well (router sees the single value)", async () => {
		type S = { result?: string };
		let routerSaw: Partial<S> | undefined;

		const g = new StateGraph<S>()
			.addNode(
				"writer",
				writeToNode<S, S>("result", () => "payload"),
			)
			.addConditionalEdges("writer", (_state, lastUpdate) => {
				routerSaw = lastUpdate;
				return END;
			})
			.addEdge(START, "writer");

		await run(g, {});

		expect(routerSaw).toEqual({ result: "payload" });
	});
});

describe("recursion limit (设计 §5.5)", () => {
	it("pins the default recursionLimit at 25 (attempted superstep = 26)", async () => {
		const counter = { runs: 0 };
		const events: RunEvent[] = [];

		const error = await captureRejection(
			run(selfLoop(counter), {}, { onEvent: (e) => events.push(e) }),
		);

		expect(error).toBeInstanceOf(GraphRecursionError);
		const recursion = error as GraphRecursionError;
		expect(recursion.limit).toBe(25);
		// superstep = 被拒绝的"尝试超步"（limit + 1），不是已执行的超步数
		expect(recursion.superstep).toBe(26);
		expect(counter.runs).toBe(25);
		expect(ofType(events, "run_finished")[0]).toMatchObject({
			status: "failed",
			superstep: 26,
		});
	});

	it("falls back to the default limit for non-finite values (NaN / ±Infinity)", async () => {
		const limits = [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		];

		for (const limit of limits) {
			const counter = { runs: 0 };

			const error = await captureRejection(
				run(selfLoop(counter), {}, { recursionLimit: limit }),
			);

			// NaN 会让所有比较为 false：不兜底则界限整个失效（自环永不终止）
			expect(error).toBeInstanceOf(GraphRecursionError);
			expect((error as GraphRecursionError).limit).toBe(25);
			expect((error as GraphRecursionError).superstep).toBe(26);
			expect(counter.runs).toBe(25);
		}
	});
});

describe("dev-mode input freeze (设计 §5.1:352)", () => {
	const originalEnv = process.env.NODE_ENV;
	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.NODE_ENV;
			return;
		}
		process.env.NODE_ENV = originalEnv;
	});

	/**
	 * 显式落到开发模式：冻结语义不能依赖运行环境（R1——套件在 NODE_ENV=production
	 * 下跑时，这些用例必须仍断言"已冻结"，而不是悄悄变成 no-op 断言）。
	 */
	function forceDevMode(): void {
		process.env.NODE_ENV = "development";
	}

	it("deep-freezes plain-activation inputs in place; mutation throws in strict mode", async () => {
		forceDevMode();
		type S = { nested: { v: number }; list: number[] };
		let frozenInput = false;
		let frozenNested = false;
		let frozenList = false;
		let mutationError: unknown;

		const g = new StateGraph<S>()
			.addNode(
				"a",
				fnNode<S>((input) => {
					frozenInput = Object.isFrozen(input);
					frozenNested = Object.isFrozen(input.nested);
					frozenList = Object.isFrozen(input.list);
					try {
						input.nested.v = 99;
					} catch (error) {
						mutationError = error;
					}
					return {};
				}),
			)
			.addEdge(START, "a")
			.addEdge("a", END);

		const initial: S = { nested: { v: 1 }, list: [] };
		await run(g, initial);

		expect(frozenInput).toBe(true);
		expect(frozenNested).toBe(true);
		expect(frozenList).toBe(true);
		// 原位冻结、不克隆：handler 拿到的就是状态快照本身
		expect(Object.isFrozen(initial)).toBe(true);
		expect(mutationError).toBeInstanceOf(TypeError);
		expect(initial.nested.v).toBe(1);
	});

	it("deep-freezes Send payloads too (same reference, no clone)", async () => {
		forceDevMode();
		type S = { out?: string };
		const payload = { value: "p" };
		let frozenPayload = false;
		let sameReference = false;

		const g = new StateGraph<S>()
			.addNode(
				"hub",
				fnNode<S>(() => ({})),
			)
			.addConditionalEdges("hub", () => new Send("target", payload))
			.addNode(
				"target",
				fnNode<S, { value: string }>((input) => {
					frozenPayload = Object.isFrozen(input);
					sameReference = (input as unknown) === payload;
					return { out: input.value };
				}),
			)
			.addEdge(START, "hub");

		const { state } = await run(g, {});

		expect(frozenPayload).toBe(true);
		expect(sameReference).toBe(true);
		expect(Object.isFrozen(payload)).toBe(true);
		expect(state.out).toBe("p");
	});

	it("freezes cyclic inputs without infinite recursion (WeakSet guard)", async () => {
		forceDevMode();
		type Cyc = { self?: Cyc };
		const initial: Cyc = {};
		initial.self = initial;

		const g = new StateGraph<Cyc>()
			.addNode(
				"a",
				fnNode<Cyc>(() => ({})),
			)
			.addEdge(START, "a")
			.addEdge("a", END);

		await run(g, initial);

		expect(Object.isFrozen(initial)).toBe(true);
		expect(Object.isFrozen(initial.self)).toBe(true);
	});

	it("skips freezing when NODE_ENV is production", async () => {
		process.env.NODE_ENV = "production";
		type S = { nested: { v: number } };
		let frozen = true;

		const g = new StateGraph<S>()
			.addNode(
				"a",
				fnNode<S>((input) => {
					frozen = Object.isFrozen(input);
					input.nested.v = 2;
					return {};
				}),
			)
			.addEdge(START, "a")
			.addEdge("a", END);

		const initial: S = { nested: { v: 1 } };
		await run(g, initial);

		expect(frozen).toBe(false);
		expect(initial.nested.v).toBe(2);
	});
});

describe("internal invariants: unregistered plain-edge targets (T8 review)", () => {
	it("throws a loud WorkflowError naming source and target instead of silently dropping", async () => {
		const events: RunEvent[] = [];
		const data: CompiledGraphData<BasicState> = {
			name: "hand-built",
			channels: {},
			nodes: new Map([["a", fnNode<BasicState>(() => ({ x: 1 }))]]),
			plainEdges: new Map([[START, ["ghost"]]]),
			routers: new Map(),
			warnings: [],
		};

		const error = await captureRejection(
			executeRun(
				data,
				{},
				{ onEvent: (e) => events.push(e) },
				resolveServices(),
			),
		);

		// 内部不变量被破坏：响亮报错，绝不静默丢边
		expect(error).toBeInstanceOf(WorkflowError);
		expect(error).not.toBeInstanceOf(NodeExecutionError);
		expect((error as Error).message).toContain('"ghost"');
		expect((error as Error).message).toContain(`"${START}"`);
		// 没有节点失败：不发光 node_failed；run 边界仍然完整
		expect(ofType(events, "node_failed")).toHaveLength(0);
		expect(events.map((e) => e.type)).toEqual(["run_started", "run_finished"]);
		expect(ofType(events, "run_finished")[0].status).toBe("failed");
	});

	it("attaches the listener error to the initial-activation invariant failure", async () => {
		const listenerBoom = new Error("listener boom");
		const data: CompiledGraphData<BasicState> = {
			name: "hand-built",
			channels: {},
			nodes: new Map(),
			plainEdges: new Map([[START, ["ghost"]]]),
			routers: new Map(),
			warnings: [],
		};

		const error = await captureRejection(
			executeRun(
				data,
				{},
				{
					onEvent: (e) => {
						if (e.type === "run_started") {
							throw listenerBoom;
						}
					},
				},
				resolveServices(),
			),
		);

		expect(error).toBeInstanceOf(WorkflowError);
		expect((error as WorkflowError).listenerError).toBe(listenerBoom);
	});

	it("also fires for a mid-graph target (after the superstep committed)", async () => {
		const events: RunEvent[] = [];
		const data: CompiledGraphData<BasicState> = {
			name: "hand-built",
			channels: {},
			nodes: new Map([["a", fnNode<BasicState>(() => ({ x: 1 }))]]),
			plainEdges: new Map([
				[START, ["a"]],
				["a", ["ghost"]],
			]),
			routers: new Map(),
			warnings: [],
		};

		const error = await captureRejection(
			executeRun(
				data,
				{},
				{ onEvent: (e) => events.push(e) },
				resolveServices(),
			),
		);

		expect(error).toBeInstanceOf(WorkflowError);
		expect((error as Error).message).toContain('"ghost"');
		expect((error as Error).message).toContain('"a"');
		// 超步 1 已提交（a 的写入已落地），失败发生在生成下一批时
		expect(events.map((e) => e.type)).toEqual([
			"run_started",
			"node_started",
			"node_finished",
			"superstep_committed",
			"run_finished",
		]);
		expect(ofType(events, "run_finished")[0].status).toBe("failed");
	});

	it("attaches the listener error to a next-batch failure (after commit)", async () => {
		const listenerBoom = new Error("listener boom");
		const data: CompiledGraphData<BasicState> = {
			name: "hand-built",
			channels: {},
			nodes: new Map([["a", fnNode<BasicState>(() => ({ x: 1 }))]]),
			plainEdges: new Map([
				[START, ["a"]],
				["a", ["ghost"]],
			]),
			routers: new Map(),
			warnings: [],
		};

		const error = await captureRejection(
			executeRun(
				data,
				{},
				{
					onEvent: (e) => {
						if (e.type === "node_finished") {
							throw listenerBoom;
						}
					},
				},
				resolveServices(),
			),
		);

		expect(error).toBeInstanceOf(WorkflowError);
		expect((error as WorkflowError).listenerError).toBe(listenerBoom);
	});
});

describe("onEvent listener errors (T8 review)", () => {
	function singleNode(): StateGraph<BasicState> {
		return new StateGraph<BasicState>()
			.addNode(
				"a",
				fnNode<BasicState>(() => ({ x: 1 })),
			)
			.addEdge(START, "a")
			.addEdge("a", END);
	}

	it("continues the run and reports the first listener error after run_finished", async () => {
		const listenerBoom = new Error("listener boom");
		const seen: RunEvent["type"][] = [];

		const error = await captureRejection(
			run(
				singleNode(),
				{},
				{
					onEvent: (e) => {
						seen.push(e.type);
						if (e.type === "node_finished") {
							throw listenerBoom;
						}
					},
				},
			),
		);

		// 监听器抛错不改变状态机：整条事件流（含提交与 run_finished）照常发完
		expect(seen).toEqual([
			"run_started",
			"node_started",
			"node_finished",
			"superstep_committed",
			"run_finished",
		]);
		// 也不静默：run_finished 之后统一报告（WorkflowError，cause = 监听器错误）
		expect(error).toBeInstanceOf(WorkflowError);
		expect((error as Error).cause).toBe(listenerBoom);
		expect((error as Error).message).toContain("listener boom");
	});

	it("remembers only the first listener error while still delivering every event", async () => {
		const first = new Error("first");
		const second = new Error("second");
		let calls = 0;

		const error = await captureRejection(
			run(
				singleNode(),
				{},
				{
					onEvent: () => {
						calls += 1;
						throw calls === 1 ? first : second;
					},
				},
			),
		);

		expect(calls).toBe(5);
		expect((error as Error).cause).toBe(first);
	});

	it("does not mask a failing run; the listener error is attached instead of dropped", async () => {
		const boom = new Error("boom");
		const listenerBoom = new Error("listener boom");
		const g = new StateGraph<BasicState>()
			.addNode(
				"bad",
				fnNode<BasicState>(() => {
					throw boom;
				}),
			)
			.addEdge(START, "bad")
			.addEdge("bad", END);

		const error = await captureRejection(
			run(
				g,
				{},
				{
					onEvent: (e) => {
						if (e.type === "node_failed") {
							throw listenerBoom;
						}
					},
				},
			),
		);

		// 主失败优先：错误身份、消息、cause 都不被监听器 bug 抹掉
		expect(error).toBeInstanceOf(NodeExecutionError);
		expect((error as NodeExecutionError).cause).toBe(boom);
		// ……但监听器错误也不静默：附随在主错误上（R1）
		expect((error as WorkflowError).listenerError).toBe(listenerBoom);
	});

	it("attaches the listener error to a commit-phase failure too", async () => {
		const listenerBoom = new Error("listener boom");
		const g = racingWriters(
			() => ({ x: 1 }),
			() => ({ x: 2 }),
		);

		const error = await captureRejection(
			run(
				g,
				{},
				{
					onEvent: (e) => {
						if (e.type === "node_finished") {
							throw listenerBoom;
						}
					},
				},
			),
		);

		expect(error).toBeInstanceOf(InvalidWriteError);
		expect((error as WorkflowError).listenerError).toBe(listenerBoom);
	});

	it("attaches the listener error to a recursion-limit failure", async () => {
		const counter = { runs: 0 };
		const listenerBoom = new Error("listener boom");

		const error = await captureRejection(
			run(
				selfLoop(counter),
				{},
				{
					recursionLimit: 1,
					onEvent: (e) => {
						if (e.type === "node_finished") {
							throw listenerBoom;
						}
					},
				},
			),
		);

		expect(error).toBeInstanceOf(GraphRecursionError);
		expect((error as WorkflowError).listenerError).toBe(listenerBoom);
	});
});
