/**
 * Task 13：规模验收（设计 §5.3/§5.2/§12；§13 M1 的验收证据之一）+ §11 的 core 黄金用例。
 *
 * 契约：
 * - 单超步 1000 个 Send 实例（`maxInstancesPerSuperstep: 1500`）在预算内正常完成：
 *   1000 个实例**全部执行**（实例集恰好 work#2..#1001），merge 结果按实例序（Send
 *   数组顺序）逐位落地（append channel 恰好 1000 条、顺序 = 0..999）；
 * - `maxConcurrency`（这里显式给 8）只限并发、不限总量：调度受节流（峰值 ≤ 8），
 *   但 1000 个实例一个不少；
 * - 普通边扇入去重（§5.4）：1000 个 work 实例 → aggregate 只跑一次；
 * - 黄金用例（§11 core 三条中的两条）：普通边扇入按节点名去重、Send 不去重。
 *
 * 全部 handler 是平凡快函数（一次微任务），没有真实计时器；用例的 vitest 默认超时
 * （5s）就是"必须跑在几秒内"的隐性护栏。
 */

import { describe, expect, it } from "vitest";

import { StateGraph } from "../../src/core/graph.js";
import { Send } from "../../src/core/send.js";
import { append } from "../../src/core/state.js";
import { END, type RunEvent, START } from "../../src/core/types.js";
import { fnNode } from "../../src/nodes/fn.js";

type S = { items: number[]; results: number[] };

/** 受控观测：启动序、并发活动数/峰值、aggregate 执行次数（全部确定，无计时器）。 */
type Stats = {
	startedIds: string[];
	active: number;
	peak: number;
	aggregateRuns: number;
};

function newStats(): Stats {
	return { startedIds: [], active: 0, peak: 0, aggregateRuns: 0 };
}

/**
 * fan →(router: 每 item 一个 Send)→ work →(普通边扇入)→ aggregate → END。
 * `work` 每次激活只让出一个微任务（不 sleep），并发峰值由 active/peak 观测。
 */
function fanoutGraph(stats: Stats): StateGraph<S> {
	return new StateGraph<S>({ channels: { results: append } })
		.addNode(
			"fan",
			fnNode<S>(() => ({})),
		)
		.addNode(
			"work",
			fnNode<S, { i: number }>(async (input, ctx) => {
				stats.startedIds.push(ctx.instanceId);
				stats.active += 1;
				stats.peak = Math.max(stats.peak, stats.active);
				await Promise.resolve();
				stats.active -= 1;
				return { results: [input.i] };
			}),
		)
		.addNode(
			"aggregate",
			fnNode<S>(() => {
				stats.aggregateRuns += 1;
				return {};
			}),
		)
		.addEdge(START, "fan")
		.addConditionalEdges("fan", (state) =>
			state.items.map((i) => new Send("work", { i })),
		)
		.addEdge("work", "aggregate")
		.addEdge("aggregate", END);
}

function itemsTo(count: number): number[] {
	return Array.from({ length: count }, (_, i) => i);
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

describe("scale: 1000-instance Send fan-out within budget (设计 §5.3/§5.2, §12)", () => {
	const ITEM_COUNT = 1000;

	it("1000-instance send fanout completes within budget, merging in instance order", async () => {
		const stats = newStats();
		const events: RunEvent[] = [];
		const graph = fanoutGraph(stats);

		const { state } = await graph.compile().run(
			{ items: itemsTo(ITEM_COUNT), results: [] },
			{
				maxInstancesPerSuperstep: 1500,
				maxConcurrency: 8,
				onEvent: (event) => events.push(event),
			},
		);

		// (1) 1000 个实例全部执行：实例集恰好 work#2..#work#1001（fan#1 在前，
		// aggregate#1002 在后），无重无漏
		expect(stats.startedIds).toHaveLength(ITEM_COUNT);
		expect(new Set(stats.startedIds).size).toBe(ITEM_COUNT);
		expect(stats.startedIds[0]).toBe("work#2");
		expect(stats.startedIds.at(-1)).toBe(`work#${ITEM_COUNT + 1}`);

		// (2) fan-in 合并：append channel 恰好 1000 条，顺序 = 实例序 = Send 数组顺序
		expect(state.results).toHaveLength(ITEM_COUNT);
		expect(state.results).toEqual(itemsTo(ITEM_COUNT));

		// (3) 扇入去重：1000 个 work 实例 → aggregate 只跑一次
		expect(stats.aggregateRuns).toBe(1);
		expect(
			ofType(events, "node_started").filter((e) => e.node === "aggregate"),
		).toHaveLength(1);

		// (4) maxConcurrency 只限并发（峰值恰好 8），不限总量（1000 个一个不少）
		expect(stats.peak).toBe(8);
		expect(stats.active).toBe(0);

		// (5) 事件边界：3 个超步全提交，run_finished 恰好一条且完成
		expect(ofType(events, "node_started")).toHaveLength(ITEM_COUNT + 2);
		expect(
			ofType(events, "superstep_committed").map((e) => e.superstep),
		).toEqual([1, 2, 3]);
		expect(ofType(events, "superstep_aborted")).toHaveLength(0);
		expect(ofType(events, "run_finished")).toHaveLength(1);
		expect(ofType(events, "run_finished")[0]).toMatchObject({
			status: "completed",
			superstep: 3,
		});
	});
});

describe("golden (§11 langgraph 差异清单, core 相关三条)", () => {
	it("#2 Send never dedups: N sends to the same node produce N executions", async () => {
		const stats = newStats();
		const { state } = await fanoutGraph(stats)
			.compile()
			.run({ items: [0, 1, 2], results: [] });

		// 3 个 Send = 3 个实例（同名节点不去重），各自执行一次
		expect(stats.startedIds).toEqual(["work#2", "work#3", "work#4"]);
		expect(state.results).toEqual([0, 1, 2]);
	});

	it("#3 plain-edge fan-in dedups by node name: one execution regardless of fan-in width", async () => {
		const stats = newStats();
		const events: RunEvent[] = [];
		const { state } = await fanoutGraph(stats)
			.compile()
			.run(
				{ items: [0, 1, 2, 3, 4], results: [] },
				{ onEvent: (event) => events.push(event) },
			);

		// 5 个实例的普通边汇入同一后继：按节点名去重，只保留最早 seq 的一个实例
		expect(stats.startedIds).toHaveLength(5);
		expect(stats.aggregateRuns).toBe(1);
		expect(
			ofType(events, "node_started").filter((e) => e.node === "aggregate"),
		).toHaveLength(1);
		expect(state.results).toEqual([0, 1, 2, 3, 4]);
	});
});
