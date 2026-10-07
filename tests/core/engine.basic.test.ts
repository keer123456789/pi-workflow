/**
 * Task 8：引擎基础——超步（BSP）循环、普通边去重、事件流（设计 §5.1/§5.2/§5.4/§5.5、§8）。
 *
 * 契约：
 * - 普通边全部激活；同一超步内按目标节点名去重（保留最早 seq 的一个实例）；
 * - 实例输入 = 超步开始时的 state 只读快照（BSP：同超步实例互相看不到对方写入）；
 * - 提交按全局实例序（instanceId = `name#seq`）升序折叠，与完成顺序无关；
 * - 事件按完成序发出，eventSeq 全局严格递增；superstep 单调不减；
 * - 超步数超过 recursionLimit（默认 25）→ GraphRecursionError（自环测试 limit=3）；
 * - handler 抛错 = fail-fast：node_failed → superstep_aborted → run_finished(failed)
 *   → NodeExecutionError（superstep_aborted 是 T10 补的失败超步边界）。
 *
 * 本任务不含 router/Send/预算/取消/重试（T9–T12）。
 */

import { describe, expect, it } from "vitest";

import { executeRun, resolveServices } from "../../src/core/engine.js";
import {
	GraphRecursionError,
	NodeExecutionError,
} from "../../src/core/errors.js";
import { StateGraph } from "../../src/core/graph.js";
import { append } from "../../src/core/state.js";
import {
	type CompiledGraph,
	type CompiledGraphData,
	END,
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

type BasicState = { v?: number };

/** START → a → END 的最小图（未编译）。 */
function basic(cfg?: { name?: string }): StateGraph<BasicState> {
	return new StateGraph<BasicState>(cfg)
		.addNode(
			"a",
			fnNode<BasicState>(() => ({ v: 1 })),
		)
		.addEdge(START, "a")
		.addEdge("a", END);
}

describe("engine: superstep loop", () => {
	it("runs START→a→END, merging handler output into state", async () => {
		const { state, runId } = await run(basic(), {});

		expect(state.v).toBe(1);
		expect(runId).toBeTruthy();
	});

	it("runs a multi-superstep chain, accumulating state and seeing prior commits", async () => {
		type ChainState = { log: string[] };
		let logAtB: string[] | undefined;
		const events: RunEvent[] = [];

		const g = new StateGraph<ChainState>({ channels: { log: append } })
			.addNode(
				"a",
				fnNode<ChainState>(() => ({ log: ["a"] })),
			)
			.addNode(
				"b",
				fnNode<ChainState>((input) => {
					logAtB = [...input.log];
					return { log: ["b"] };
				}),
			)
			.addNode(
				"c",
				fnNode<ChainState>(() => ({ log: ["c"] })),
			)
			.addEdge(START, "a")
			.addEdge("a", "b")
			.addEdge("b", "c")
			.addEdge("c", END);

		const { state } = await run(
			g,
			{ log: [] },
			{ onEvent: (e) => events.push(e) },
		);

		expect(state.log).toEqual(["a", "b", "c"]);
		// b 的输入是超步 1 提交后的 state（跨超步可见）
		expect(logAtB).toEqual(["a"]);
		// 每个超步一次提交，编号从 1 递增
		expect(
			ofType(events, "superstep_committed").map((e) => e.superstep),
		).toEqual([1, 2, 3]);
		expect(ofType(events, "node_started").map((e) => e.instanceId)).toEqual([
			"a#1",
			"b#2",
			"c#3",
		]);
		// superstep 单调不减
		const supersteps = events.map((e) => e.superstep);
		expect(supersteps).toEqual([...supersteps].sort((x, y) => x - y));
	});

	it("never runs a node that was not activated", async () => {
		type GhostState = { hit?: number };
		let ghostRuns = 0;

		const g = new StateGraph<GhostState>()
			.addNode(
				"a",
				fnNode<GhostState>(() => ({ hit: 1 })),
			)
			.addNode(
				"ghost",
				fnNode<GhostState>(() => {
					ghostRuns += 1;
					return { hit: 1 };
				}),
			)
			.addEdge(START, "a")
			.addEdge("a", END);

		const { state } = await run(g, {});

		expect(state.hit).toBe(1);
		expect(ghostRuns).toBe(0);
	});
});

describe("engine: plain-edge dedup (设计 §5.4)", () => {
	it("dedups plain-edge fan-in: two predecessors → one aggregate execution", async () => {
		type FanInState = { count?: number };
		let aggregateRuns = 0;

		const g = new StateGraph<FanInState>()
			.addNode(
				"a",
				fnNode<FanInState>(() => ({})),
			)
			.addNode(
				"b",
				fnNode<FanInState>(() => ({})),
			)
			.addNode(
				"aggregate",
				fnNode<FanInState>((input) => {
					aggregateRuns += 1;
					return { count: (input.count ?? 0) + 1 };
				}),
			)
			.addEdge(START, "a")
			.addEdge(START, "b")
			.addEdge("a", "aggregate")
			.addEdge("b", "aggregate")
			.addEdge("aggregate", END);

		const { state } = await run(g, {});

		expect(aggregateRuns).toBe(1);
		expect(state.count).toBe(1);
	});

	it("dedups fan-in from three predecessors into a single activation", async () => {
		type FanInState = { count?: number };
		const aggregateIds: string[] = [];

		const g = new StateGraph<FanInState>()
			.addNode(
				"a",
				fnNode<FanInState>(() => ({})),
			)
			.addNode(
				"b",
				fnNode<FanInState>(() => ({})),
			)
			.addNode(
				"c",
				fnNode<FanInState>(() => ({})),
			)
			.addNode(
				"aggregate",
				fnNode<FanInState>((_input, ctx) => {
					aggregateIds.push(ctx.instanceId);
					return { count: 1 };
				}),
			)
			.addEdge(START, "a")
			.addEdge(START, "b")
			.addEdge(START, "c")
			.addEdge("a", "aggregate")
			.addEdge("b", "aggregate")
			.addEdge("c", "aggregate")
			.addEdge("aggregate", END);

		await run(g, {});

		// a#1、b#2、c#3 之后，去重产生唯一一个 aggregate 实例
		expect(aggregateIds).toEqual(["aggregate#4"]);
	});
});

describe("engine: BSP snapshot (设计 §5.1)", () => {
	it("gives every instance of a superstep the pre-superstep state snapshot", async () => {
		type SnapState = { v?: number; observed?: number };
		const seen: number[] = [];
		const events: RunEvent[] = [];
		let fastFinished: () => void = () => {};
		const fastDone = new Promise<void>((resolve) => {
			fastFinished = resolve;
		});

		const g = new StateGraph<SnapState>()
			.addNode(
				"fast",
				fnNode<SnapState>((input) => {
					seen.push(input.v ?? -1);
					fastFinished();
					return { v: 20 };
				}),
			)
			.addNode(
				"slow",
				fnNode<SnapState>(async (input) => {
					// fast 已经跑完并返回，但它的写入要等整个超步提交后才可见
					await fastDone;
					await new Promise((resolve) => setTimeout(resolve, 5));
					seen.push(input.v ?? -1);
					return { observed: input.v ?? -1 };
				}),
			)
			.addEdge(START, "fast")
			.addEdge(START, "slow")
			.addEdge("fast", END)
			.addEdge("slow", END);

		const { state } = await run(g, {}, { onEvent: (e) => events.push(e) });

		// 两个实例都看到超步开始前的 state（v 尚未写入）
		expect(seen).toEqual([-1, -1]);
		expect(state).toEqual({ v: 20, observed: -1 });
		// 事件按完成序发出（fast 先完成先发）
		expect(ofType(events, "node_finished").map((e) => e.node)).toEqual([
			"fast",
			"slow",
		]);
	});

	it("commits updates in instance-seq order regardless of completion order", async () => {
		type OrderState = { log: string[] };
		let releaseB: () => void = () => {};
		const bFinished = new Promise<void>((resolve) => {
			releaseB = resolve;
		});

		const g = new StateGraph<OrderState>({ channels: { log: append } })
			.addNode(
				// a 先激活（seq 1）但后完成
				"a",
				fnNode<OrderState>(async () => {
					await bFinished;
					return { log: ["a"] };
				}),
			)
			.addNode(
				"b",
				fnNode<OrderState>(() => {
					releaseB();
					return { log: ["b"] };
				}),
			)
			.addEdge(START, "a")
			.addEdge(START, "b")
			.addEdge("a", END)
			.addEdge("b", END);

		const { state } = await run(g, { log: [] });

		// 顺序按实例 seq（a 在前），不按完成顺序（b 在前）
		expect(state.log).toEqual(["a", "b"]);
	});
});

describe("engine: event stream (设计 §8)", () => {
	it("emits an ordered event stream with strictly increasing eventSeq", async () => {
		const events: RunEvent[] = [];

		const { runId } = await run(
			basic({ name: "basic" }),
			{},
			{
				onEvent: (e) => events.push(e),
			},
		);

		expect(events.map((e) => e.type)).toEqual([
			"run_started",
			"node_started",
			"node_finished",
			"superstep_committed",
			"run_finished",
		]);
		// 全局 eventSeq 严格递增，首个事件是 1
		expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
		// 所有事件带同一个 runId
		expect(events.every((e) => e.runId === runId)).toBe(true);

		const started = ofType(events, "run_started")[0];
		expect(started).toMatchObject({
			graph: "basic",
			superstep: 0,
			input: {},
		});
		const nodeStarted = ofType(events, "node_started")[0];
		expect(nodeStarted).toMatchObject({
			node: "a",
			instanceId: "a#1",
			kind: "fn",
			superstep: 1,
		});
		const finished = ofType(events, "node_finished")[0];
		expect(finished).toMatchObject({
			node: "a",
			instanceId: "a#1",
			output: { v: 1 },
		});
		expect(finished.durationMs).toBeGreaterThanOrEqual(0);
		const runFinished = ofType(events, "run_finished")[0];
		expect(runFinished).toMatchObject({ status: "completed", superstep: 1 });
		expect(runFinished.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("uses the injected clock for ts and durationMs (compile-time services)", async () => {
		let now = 0;
		const clock = () => {
			now += 5;
			return now;
		};
		const events: RunEvent[] = [];

		const compiled: CompiledGraph<BasicState> = basic().compile({
			services: { clock },
		});

		await compiled.run({}, { onEvent: (e) => events.push(e) });

		// 每次取时 +5：事件 ts 全部来自注入时钟
		expect(events.every((e) => e.ts % 5 === 0)).toBe(true);
		// handler 同步执行，t0/t1 之间恰好一次取时
		expect(ofType(events, "node_finished")[0].durationMs).toBe(5);
	});

	it("fails fast on a handler throw: node_failed → failed run_finished → NodeExecutionError", async () => {
		const boom = new Error("boom");
		const events: RunEvent[] = [];

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
			run(g, {}, { onEvent: (e) => events.push(e) }),
		);

		expect(error).toBeInstanceOf(NodeExecutionError);
		const nodeError = error as NodeExecutionError;
		expect(nodeError.node).toBe("bad");
		expect(nodeError.instanceId).toBe("bad#1");
		expect(nodeError.cause).toBe(boom);
		// 本任务没有重试/取消，没有连带实例
		expect(nodeError.collateral).toEqual([]);

		// T10 起：失败超步以 superstep_aborted 收尾（committed 边界语义，§8.1）
		expect(events.map((e) => e.type)).toEqual([
			"run_started",
			"node_started",
			"node_failed",
			"superstep_aborted",
			"run_finished",
		]);
		expect(ofType(events, "node_failed")[0]).toMatchObject({
			node: "bad",
			instanceId: "bad#1",
			error: "boom",
		});
		expect(ofType(events, "run_finished")[0].status).toBe("failed");
	});
});

describe("engine: recursion limit (设计 §5.5)", () => {
	it("throws GraphRecursionError when a self-loop exceeds recursionLimit", async () => {
		const events: RunEvent[] = [];
		let runs = 0;

		const g = new StateGraph<BasicState>()
			.addNode(
				"a",
				fnNode<BasicState>(() => {
					runs += 1;
					return { v: runs };
				}),
			)
			.addEdge(START, "a")
			.addEdge("a", "a");

		const error = await captureRejection(
			run(g, {}, { recursionLimit: 3, onEvent: (e) => events.push(e) }),
		);

		expect(error).toBeInstanceOf(GraphRecursionError);
		const recursion = error as GraphRecursionError;
		expect(recursion.limit).toBe(3);
		// 超步 1..3 执行，第 4 个超步会越限
		expect(recursion.superstep).toBe(4);
		expect(runs).toBe(3);
		expect(ofType(events, "run_finished")[0]).toMatchObject({
			status: "failed",
			superstep: 4,
		});
	});

	it("completes immediately when START has no successors (defensive no-op run)", async () => {
		const events: RunEvent[] = [];
		const data: CompiledGraphData<BasicState> = {
			name: "empty",
			channels: {},
			nodes: new Map(),
			plainEdges: new Map(),
			routers: new Map(),
			warnings: [],
		};

		const result = await executeRun(
			data,
			{ v: 7 },
			{ onEvent: (e) => events.push(e) },
			resolveServices(),
		);

		expect(result.state).toEqual({ v: 7 });
		expect(result.runId).toBeTruthy();
		expect(events.map((e) => e.type)).toEqual(["run_started", "run_finished"]);
		expect(ofType(events, "run_finished")[0]).toMatchObject({
			status: "completed",
			superstep: 0,
		});
	});
});

describe("engine: wiring", () => {
	it("wires run() and invoke() to the engine with a fresh runId per run", async () => {
		const compiled = basic().compile();

		const first = await compiled.run({});
		const second = await compiled.invoke({});

		expect(first.runId).toBeTruthy();
		expect(first.runId).not.toBe(second.runId);
		expect(second.state.v).toBe(1);
	});
});
