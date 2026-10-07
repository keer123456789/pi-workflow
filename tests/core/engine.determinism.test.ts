/**
 * Task 13：确定性验收（设计 §2.4/§5.2/§12；§13 M1 的验收证据之一）。
 *
 * 契约（§5.2）：同图 + 同初始状态，两次 run 的**状态轨迹**逐位一致——每超步的
 * channel 快照与合并顺序都相同，且与实例完成时序无关（合并按实例 seq 升序）。
 *
 * 图的形状刻意让"完成序 ≠ 实例序"：Send 扇出的 work 实例按 `n - i` 个微任务阶梯
 * 完成（i 越大越早完成，即完成序 = Send 数组顺序的逆序），而 append channel 的
 * 合并必须仍按实例序落地。因此本文件的确定性断言**非空洞**：
 * - 两次 run 的轨迹 deep-equal（同一编译产物两次 run；以及两次独立 compile）；
 * - 合并结果逐位等于 Send 数组顺序（完成序一旦混进合并就与它相反 → 断言失败）。
 *
 * 轨迹采集是测试内联的收集器，不是引擎设施：
 * - `snapshots` channel（append）：refine 每次激活时把当时合并 state 的投影
 *   `structuredClone` 后追加一条——即"每超步的 channel 快照"；
 * - `trace` channel（append）：每个实例激活时的 `{superstep, node, instanceId, seq}`；
 * - `results` channel（append）：Send 实例的写入按合并序落地（顺序敏感）。
 */

import { describe, expect, it } from "vitest";

import { StateGraph } from "../../src/core/graph.js";
import { Send } from "../../src/core/send.js";
import { append } from "../../src/core/state.js";
import {
	END,
	type NodeContext,
	type RunEvent,
	type RunResult,
	START,
} from "../../src/core/types.js";
import { fnNode } from "../../src/nodes/fn.js";

/** 每个实例激活一次记一条（append channel 的合并序 = 实例序）。 */
type TraceEntry = {
	superstep: number;
	node: string;
	instanceId: string;
	seq: number;
};

/** refine 激活时对合并 state 的投影（快照不含 snapshots 自身，避免自嵌套）。 */
type Snapshot = {
	round: number;
	results: number[];
	trace: TraceEntry[];
};

type S = {
	items: number[];
	round: number;
	results: number[];
	trace: TraceEntry[];
	snapshots: Snapshot[];
};

const ITEMS = [0, 1, 2];
/** refine 跑满两轮后由 router 终止（round = 1 → 再扇出；round = 2 → END）。 */
const ROUNDS = 2;

/** 完成序探针：work handler 实际完成的 `i` 序列（每次 run 前清空）。 */
type Probe = { completionOrder: number[] };

function entry(ctx: NodeContext, node: string): TraceEntry {
	return {
		superstep: ctx.superstep,
		node,
		instanceId: ctx.instanceId,
		seq: ctx.seq,
	};
}

/**
 * seed →(router: Send×|items|)→ work →(普通边, 扇入去重)→ refine →(router 循环一轮)→ …
 * 每次 run 用新的 initial（同值），避免跨 run 共享同一个 state 对象。
 */
function initial(): S {
	return {
		items: [...ITEMS],
		round: 0,
		results: [],
		trace: [],
		snapshots: [],
	};
}

function makeGraph(probe: Probe): StateGraph<S> {
	return (
		new StateGraph<S>({
			name: "determinism",
			channels: { results: append, trace: append, snapshots: append },
		})
			.addNode(
				"seed",
				fnNode<S>((input, ctx) => ({
					items: [...input.items],
					trace: [entry(ctx, "seed")],
				})),
			)
			.addNode(
				"work",
				fnNode<S, { i: number }>(async (input, ctx) => {
					// 阶梯微任务：i=0 走 3 跳、i=1 走 2 跳、i=2 走 1 跳 → 完成序 2,1,0。
					// 纯微任务、无真实计时器（0ms 宏任务也不过界），进程内可复现。
					for (let hop = 0; hop < ITEMS.length - input.i; hop += 1) {
						await Promise.resolve();
					}
					probe.completionOrder.push(input.i);
					return { results: [input.i], trace: [entry(ctx, "work")] };
				}),
			)
			.addNode(
				"refine",
				fnNode<S>((input, ctx) => ({
					round: input.round + 1,
					trace: [entry(ctx, "refine")],
					snapshots: [
						structuredClone({
							round: input.round,
							results: input.results,
							trace: input.trace,
						}),
					],
				})),
			)
			.addEdge(START, "seed")
			.addConditionalEdges("seed", (state) =>
				state.items.map((i) => new Send("work", { i })),
			)
			.addEdge("work", "refine")
			// §5.5 的 lastUpdate 惯例：只看本轮新写入的 round 决定是否再扇出一轮。
			.addConditionalEdges("refine", (state, lastUpdate) =>
				(lastUpdate.round ?? 0) < ROUNDS
					? state.items.map((i) => new Send("work", { i }))
					: END,
			)
	);
}

/** 一次独立编译 + 一次 run（"两次独立 compile"场景）。 */
function runFreshGraph(): Promise<RunResult<S>> {
	return makeGraph({ completionOrder: [] }).compile().run(initial());
}

/** 事件投影：去掉 runId/ts/durationMs/input 这些每次 run 必然不同的字段。 */
function projectEvents(
	events: readonly RunEvent[],
): { type: RunEvent["type"]; superstep: number; instanceId?: string }[] {
	return events.map((event) => ({
		type: event.type,
		superstep: event.superstep,
		instanceId: "instanceId" in event ? event.instanceId : undefined,
	}));
}

describe("determinism: identical state traces across runs (设计 §2.4/§5.2, §12)", () => {
	it("same compiled graph run twice: identical per-superstep channel snapshots and merge order", async () => {
		const probe: Probe = { completionOrder: [] };
		const compiled = makeGraph(probe).compile();

		const eventsA: RunEvent[] = [];
		const a = await compiled.run(initial(), {
			onEvent: (event) => eventsA.push(event),
		});
		const orderA = probe.completionOrder.splice(0);

		const eventsB: RunEvent[] = [];
		const b = await compiled.run(initial(), {
			onEvent: (event) => eventsB.push(event),
		});
		const orderB = probe.completionOrder.splice(0);

		// (0) runId 每次新建（不是 state 的一部分，不参与轨迹比较）
		expect(a.runId).not.toBe(b.runId);

		// (1) 两次 run 的完成序一致，且**恒为实例序的逆序**（3,2,1 → 每轮 2,1,0）
		expect(orderA).toEqual([2, 1, 0, 2, 1, 0]);
		expect(orderB).toEqual(orderA);

		// (2) 每超步 channel 快照数组：deep-equal 逐位一致（本轮验收的核心断言）
		expect(b.state.snapshots).toEqual(a.state.snapshots);
		expect(b.state).toEqual(a.state);

		// (3) 合并序锚点：append 的落地顺序是 Send 数组顺序（实例序），不是完成序。
		// 完成序是 [2,1,0]，若合并按完成序，这里会得到 [2,1,0,...] → 断言失败。
		expect(a.state.results).toEqual([0, 1, 2, 0, 1, 2]);
		expect(a.state.trace.map((e) => e.instanceId)).toEqual([
			"seed#1",
			"work#2",
			"work#3",
			"work#4",
			"refine#5",
			"work#6",
			"work#7",
			"work#8",
			"refine#9",
		]);
		expect(a.state.trace.map((e) => e.superstep)).toEqual([
			1, 2, 2, 2, 3, 4, 4, 4, 5,
		]);

		// (4) 每超步快照的内容（round 是 refine 写入前的值：第 1/2 轮各一份）
		expect(a.state.snapshots.map((s) => s.round)).toEqual([0, 1]);
		expect(a.state.snapshots[0]?.results).toEqual([0, 1, 2]);
		expect(a.state.snapshots[1]?.results).toEqual([0, 1, 2, 0, 1, 2]);
		expect(a.state.snapshots[0]?.trace).toHaveLength(4);

		// (5) 事件流（seq 序即完成序，本图完成序确定）投影后逐位一致
		expect(projectEvents(eventsB)).toEqual(projectEvents(eventsA));
		expect(eventsA.map((event) => event.seq)).toEqual(
			Array.from({ length: eventsA.length }, (_, index) => index + 1),
		);
	});

	it("two independent compiles of the same graph agree", async () => {
		const a = await runFreshGraph();
		const b = await runFreshGraph();

		expect(b.state.snapshots).toEqual(a.state.snapshots);
		expect(b.state).toEqual(a.state);
	});

	it("merges in instance order, not completion order (确定性断言的抗空洞锚点)", async () => {
		const probe: Probe = { completionOrder: [] };
		const { state } = await makeGraph(probe).compile().run(initial());

		// work 每轮完成的次序是 2,1,0（阶梯微任务把完成序与实例序反过来）
		expect(probe.completionOrder).toEqual([2, 1, 0, 2, 1, 0]);
		// 而合并（append 的落地序）严格按实例序 = Send 数组顺序
		expect(state.results).toEqual([0, 1, 2, 0, 1, 2]);
		expect(state.snapshots[1]?.results).toEqual([0, 1, 2, 0, 1, 2]);
	});
});

describe("golden (§11 langgraph 差异清单, core 相关三条)", () => {
	it("#1 run() resolves to { state, runId }, not bare state", async () => {
		const result = await runFreshGraph();

		// 不是裸 state：解构出 state 与 runId 两个字段（§4.4 的 RunResult）
		expect(Object.keys(result).sort()).toEqual(["runId", "state"]);
		expect(typeof result.runId).toBe("string");
		expect(result.runId.length).toBeGreaterThan(0);
		expect(result.state.round).toBe(ROUNDS);
	});
});
