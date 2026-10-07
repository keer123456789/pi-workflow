/**
 * Task 12：预算护栏与 I/O 并发上限（设计 §5.1:325-327、§5.3、§4.4）。
 *
 * 契约：
 * - 检查点在**生成下一批之后、执行之前**（§5.1 伪码）：越限的这一批一个实例都不执行
 *   ——没有 handler 调用、没有 node_started / node_failed，也没有超步边界（什么都没跑）；
 * - `maxInstancesPerSuperstep`（默认 1000）：`pending.length > limit` →
 *   `InstanceBudgetError{kind: "superstep"}`；
 * - `maxTotalInstances`（默认 10000）：累计**创建**的实例数（含排队未启动的）> limit →
 *   `InstanceBudgetError{kind: "total"}`——额度按创建算，maxConcurrency 不是绕过预算的后门；
 * - 两个预算的非有限值（NaN / ±Infinity）回落默认（与 recursionLimit 同一策略）；
 * - `run_finished.superstep` = 该批**将被执行**的超步号（与 recursionLimit 的"尝试超步"
 *   同一编号规则：limit 内跑满后，失败事件记的是下一个超步号）；
 * - `maxConcurrency`（默认 8，§4.4/§5.1:327）：同一超步**同时执行**的实例数封顶，超出的
 *   排队等槽位、槽位一空按实例序启动；排队期间信号被 abort 的实例（兄弟失败 fail-fast /
 *   run 取消）永不执行——handler 不被调用，记入 `NodeExecutionError.collateral`；
 * - 两个预算与并发上限都是纯 options 驱动（缺省落默认值），不影响未越限的图。
 *
 * 全部用例确定性：没有真实计时器——handler 用受控 promise 挂起，`tick()` 只做微任务排空
 * （0ms 宏任务屏障），并发峰值靠 handler 内的计数器观测。
 */

import { describe, expect, it } from "vitest";

import {
	InstanceBudgetError,
	NodeExecutionError,
	WorkflowError,
} from "../../src/core/errors.js";
import { StateGraph } from "../../src/core/graph.js";
import { Send } from "../../src/core/send.js";
import {
	END,
	type NodeDefinition,
	type RunEvent,
	type RunHandle,
	type RunOptions,
	START,
} from "../../src/core/types.js";
import { fnNode } from "../../src/nodes/fn.js";

type S = { items: number[] };

/** 任务 brief 的 `g.run(...)` 简写：编译（无参）后跑一次。 */
function run(
	graph: StateGraph<S>,
	initial: S,
	options?: RunOptions,
): RunHandle<S> {
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

/** 0ms 宏任务屏障：排空微任务后再继续（受控 promise 用例的阶段对齐点）。 */
function tick(): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});
}

/** 节点被取消时的标准 rejection（AbortError 形态）。 */
function abortError(): Error {
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}

/** i = 0..n-1 的初始 state（extract 的 router 按 data 规模扇出）。 */
function itemsState(n: number): S {
	return { items: Array.from({ length: n }, (_, i) => i) };
}

/**
 * extract →（router Send 扇出 `n` 个）work。work 无普通出边：跑完这一轮即止。
 * 扇出数量完全由数据规模决定（§5.3 的 map-reduce 形态）。
 */
function fanout(work: NodeDefinition<S, { i: number }>): StateGraph<S> {
	return new StateGraph<S>()
		.addNode(
			"extract",
			fnNode<S>(() => ({})),
		)
		.addConditionalEdges("extract", (state) =>
			state.items.map((i) => new Send("work", { i })),
		)
		.addNode("work", work)
		.addEdge(START, "extract")
		.addEdge("work", END);
}

describe("instance budget guards: maxInstancesPerSuperstep (设计 §5.1:325, §5.3)", () => {
	it("rejects a Send fan-out over the limit before executing any instance of that batch", async () => {
		const events: RunEvent[] = [];
		const workStarts: number[] = [];
		const g = fanout(
			fnNode<S, { i: number }>((input) => {
				workStarts.push(input.i);
				return {};
			}),
		);

		const error = await captureRejection(
			run(g, itemsState(5), {
				maxInstancesPerSuperstep: 3,
				onEvent: (e) => events.push(e),
			}),
		);

		expect(error).toBeInstanceOf(InstanceBudgetError);
		const budget = error as InstanceBudgetError;
		expect(budget.kind).toBe("superstep");
		expect(budget.limit).toBe(3);
		// 冒犯的这一批零执行：5 个 work handler 一次都没被调用
		expect(workStarts).toEqual([]);
		// 事件流：第 1 超步（extract）照常提交；越限的那批没有超步边界
		// （没有实例跑过，superstep_aborted 无意义），事件以 run_finished{failed} 收尾
		expect(ofType(events, "node_started").map((e) => e.instanceId)).toEqual([
			"extract#1",
		]);
		expect(
			ofType(events, "superstep_committed").map((e) => e.superstep),
		).toEqual([1]);
		expect(ofType(events, "superstep_aborted")).toHaveLength(0);
		expect(ofType(events, "node_failed")).toHaveLength(0);
		// 单条 run_finished 契约：一次 run 恰好一条收尾事件
		expect(ofType(events, "run_finished")).toHaveLength(1);
		// run_finished.superstep = 该批将被执行的超步号（attempted superstep，与
		// recursionLimit 的编号规则一致）：extract 跑的是 1，越限的是 2
		expect(ofType(events, "run_finished")[0]).toMatchObject({
			status: "failed",
			superstep: 2,
		});
	});

	it("runs a batch of exactly maxInstancesPerSuperstep instances (limit 是 `>`, not `>=`)", async () => {
		const workStarts: number[] = [];
		const g = fanout(
			fnNode<S, { i: number }>((input) => {
				workStarts.push(input.i);
				return {};
			}),
		);

		const { state } = await run(g, itemsState(3), {
			maxInstancesPerSuperstep: 3,
		});

		expect(workStarts).toEqual([0, 1, 2]);
		expect(state.items).toEqual([0, 1, 2]);
	});

	it("applies the default limit of 1000 when unspecified", async () => {
		const workStarts: number[] = [];
		const g = fanout(
			fnNode<S, { i: number }>((input) => {
				workStarts.push(input.i);
				return {};
			}),
		);

		const error = await captureRejection(run(g, itemsState(1001)));

		expect(error).toBeInstanceOf(InstanceBudgetError);
		expect((error as InstanceBudgetError).kind).toBe("superstep");
		expect((error as InstanceBudgetError).limit).toBe(1000);
		expect(workStarts).toEqual([]);
	});

	it("falls back to the default limit for non-finite values (NaN / ±Infinity)", async () => {
		for (const limit of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			const workStarts: number[] = [];
			const g = fanout(
				fnNode<S, { i: number }>((input) => {
					workStarts.push(input.i);
					return {};
				}),
			);

			// 非有限值会让所有比较失效（界限形同虚设）：一律回落默认 1000。
			const error = await captureRejection(
				run(g, itemsState(1001), { maxInstancesPerSuperstep: limit }),
			);

			expect(error).toBeInstanceOf(InstanceBudgetError);
			expect((error as InstanceBudgetError).kind).toBe("superstep");
			expect((error as InstanceBudgetError).limit).toBe(1000);
			expect(workStarts).toEqual([]);
		}
	});
});

describe("instance budget guards: maxTotalInstances (设计 §5.1:326, §5.3)", () => {
	it("counts creations cumulatively across supersteps and rejects the batch that pushes it over", async () => {
		// 自环每轮 +2 实例：loop 的 router 返回 ["loop", "tick"]，每轮新建 2 个实例。
		// 累计序列 1 → 3 → 5 的三批都执行（≤ 5），把累计推到 7 的第 4 批整体不执行。
		const events: RunEvent[] = [];
		const counts = { loop: 0, tick: 0 };
		const g = new StateGraph<S>()
			.addNode(
				"loop",
				fnNode<S>(() => {
					counts.loop += 1;
					return {};
				}),
			)
			.addNode(
				"tick",
				fnNode<S>(() => {
					counts.tick += 1;
					return {};
				}),
			)
			.addConditionalEdges("loop", () => ["loop", "tick"])
			.addEdge(START, "loop");

		const error = await captureRejection(
			run(g, itemsState(0), {
				maxTotalInstances: 5,
				onEvent: (e) => events.push(e),
			}),
		);

		expect(error).toBeInstanceOf(InstanceBudgetError);
		const budget = error as InstanceBudgetError;
		expect(budget.kind).toBe("total");
		expect(budget.limit).toBe(5);
		// 跑过的是 loop#1（累计 1）、loop#2 + tick#3（累计 3）、loop#4 + tick#5（累计 5）；
		// 第 4 批 loop#6 + tick#7 把累计推到 7 → 零执行
		expect(counts).toEqual({ loop: 3, tick: 2 });
		expect(ofType(events, "node_started")).toHaveLength(5);
		expect(
			ofType(events, "superstep_committed").map((e) => e.superstep),
		).toEqual([1, 2, 3]);
		expect(ofType(events, "superstep_aborted")).toHaveLength(0);
		// 单条 run_finished 契约：一次 run 恰好一条收尾事件
		expect(ofType(events, "run_finished")).toHaveLength(1);
		// 失败记的是被拒绝的那一批的（尝试）超步号：3 个超步已跑完，第 4 个没跑成
		expect(ofType(events, "run_finished")[0]).toMatchObject({
			status: "failed",
			superstep: 4,
		});
	});

	it("applies the default total budget of 10000 (额度按创建算，执行从未发生)", async () => {
		// 单超步 10001 个 Send：把单超步上限显式抬高以隔离 total 检查。
		// 累计 = extract#1 + 10001 个 Send = 10002 > 10000 → 整批不执行。
		const workStarts: number[] = [];
		const g = fanout(
			fnNode<S, { i: number }>((input) => {
				workStarts.push(input.i);
				return {};
			}),
		);

		const error = await captureRejection(
			run(g, itemsState(10001), { maxInstancesPerSuperstep: 20_000 }),
		);

		expect(error).toBeInstanceOf(InstanceBudgetError);
		expect((error as InstanceBudgetError).kind).toBe("total");
		expect((error as InstanceBudgetError).limit).toBe(10_000);
		expect(workStarts).toEqual([]);
	});

	it("falls back to the default total budget for non-finite values (NaN / ±Infinity)", async () => {
		for (const limit of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			const g = fanout(fnNode<S, { i: number }>(() => ({})));

			const error = await captureRejection(
				run(g, itemsState(10001), {
					maxInstancesPerSuperstep: 20_000,
					maxTotalInstances: limit,
				}),
			);

			expect(error).toBeInstanceOf(InstanceBudgetError);
			expect((error as InstanceBudgetError).kind).toBe("total");
			expect((error as InstanceBudgetError).limit).toBe(10_000);
		}
	});
});

describe("I/O concurrency cap: maxConcurrency (设计 §4.4 / §5.1:327)", () => {
	/**
	 * 受控并发探针：n 个 work 实例（扇出数量由 initial.items 决定），handler 记录启动序、
	 * 累计在跑数与峰值，然后挂在受控 promise 上直到 `releaseAll()`。没有真实计时器。
	 */
	function concurrencyProbe(n: number): {
		graph: StateGraph<S>;
		initial: S;
		startedIds: string[];
		stats: { active: number; peak: number };
		releaseAll: () => void;
	} {
		const startedIds: string[] = [];
		const stats = { active: 0, peak: 0 };
		const releases: (() => void)[] = [];
		const graph = fanout(
			fnNode<S, { i: number }>(async (_input, ctx) => {
				startedIds.push(ctx.instanceId);
				stats.active += 1;
				stats.peak = Math.max(stats.peak, stats.active);
				await new Promise<void>((resolve) => {
					releases.push(resolve);
				});
				stats.active -= 1;
				return {};
			}),
		);
		return {
			graph,
			initial: itemsState(n),
			startedIds,
			stats,
			releaseAll: () => {
				for (const release of releases.splice(0)) {
					release();
				}
			},
		};
	}

	it("caps concurrent execution at maxConcurrency and starts queued instances in instance order", async () => {
		const probe = concurrencyProbe(10);

		const handle = run(probe.graph, probe.initial, { maxConcurrency: 3 });
		await tick(); // extract#1 完成、第 2 超步开始：只有 3 个 work 在跑

		expect(probe.startedIds).toEqual(["work#2", "work#3", "work#4"]);
		expect(probe.stats.active).toBe(3);
		expect(probe.stats.peak).toBe(3);

		// 槽位一空就按实例序启动下一个（3 → 3 → 3 → 1 四波）
		probe.releaseAll();
		await tick();
		expect(probe.startedIds).toHaveLength(6);
		expect(probe.startedIds).toEqual([
			"work#2",
			"work#3",
			"work#4",
			"work#5",
			"work#6",
			"work#7",
		]);
		expect(probe.stats.active).toBe(3);
		expect(probe.stats.peak).toBe(3);

		probe.releaseAll();
		await tick();
		expect(probe.startedIds).toHaveLength(9);
		expect(probe.stats.active).toBe(3);

		probe.releaseAll();
		await tick();
		expect(probe.startedIds).toHaveLength(10);
		expect(probe.stats.active).toBe(1);

		probe.releaseAll();
		const { state } = await handle;

		// 全程峰值 ≤ 3：没有任何时刻有第 4 个实例在跑
		expect(probe.stats.peak).toBe(3);
		expect(state).toEqual(probe.initial);
	});

	it("defaults maxConcurrency to 8 (non-finite values fall back too)", async () => {
		const requests: (number | undefined)[] = [
			undefined,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		];

		for (const requested of requests) {
			const probe = concurrencyProbe(10);
			const options: RunOptions =
				requested === undefined ? {} : { maxConcurrency: requested };

			const handle = run(probe.graph, probe.initial, options);
			await tick();

			expect(probe.startedIds).toHaveLength(8);
			expect(probe.stats.active).toBe(8);

			probe.releaseAll();
			await tick();
			expect(probe.startedIds).toHaveLength(10);

			probe.releaseAll();
			await handle;
			expect(probe.stats.peak).toBe(8);
		}
	});

	it("clamps a non-positive maxConcurrency to 1 (serial execution, no deadlock)", async () => {
		const probe = concurrencyProbe(3);

		const handle = run(probe.graph, probe.initial, { maxConcurrency: 0 });
		await tick();
		expect(probe.startedIds).toEqual(["work#2"]);
		expect(probe.stats.active).toBe(1);

		for (let wave = 0; wave < 3; wave += 1) {
			probe.releaseAll();
			await tick();
		}
		await handle;

		// 串行：任意时刻最多 1 个实例在跑
		expect(probe.stats.peak).toBe(1);
		expect(probe.startedIds).toEqual(["work#2", "work#3", "work#4"]);
	});

	it("never starts instances queued behind a fail-fast abort; they are collateral", async () => {
		const events: RunEvent[] = [];
		const boom = new Error("work#2 blew up");
		const startedIds: string[] = [];
		const g = fanout(
			fnNode<S, { i: number }>(async (input, ctx) => {
				startedIds.push(ctx.instanceId);
				if (input.i === 0) {
					throw boom;
				}
				// 其余实例尊重信号：被 fail-fast abort 时 reject AbortError
				return await new Promise<Partial<S>>((_resolve, reject) => {
					ctx.signal.addEventListener("abort", () => reject(abortError()), {
						once: true,
					});
				});
			}),
		);

		const error = await captureRejection(
			run(g, itemsState(10), {
				maxConcurrency: 3,
				onEvent: (e) => events.push(e),
			}),
		);

		expect(error).toBeInstanceOf(NodeExecutionError);
		const nodeError = error as NodeExecutionError;
		expect(nodeError.instanceId).toBe("work#2");
		expect(nodeError.cause).toBe(boom);
		// 在跑的 2 个（work#3/#4）与排队中的 7 个（work#5..#11）都是 collateral，按实例序
		expect(nodeError.collateral).toEqual([
			"work#3",
			"work#4",
			"work#5",
			"work#6",
			"work#7",
			"work#8",
			"work#9",
			"work#10",
			"work#11",
		]);
		// 只有前 3 个真的启动过：排队的 7 个 handler 从未被调用，也没有 node_started
		expect(startedIds).toEqual(["work#2", "work#3", "work#4"]);
		expect(ofType(events, "node_started").map((e) => e.instanceId)).toEqual([
			"extract#1",
			"work#2",
			"work#3",
			"work#4",
		]);
		expect(ofType(events, "node_failed").map((e) => e.instanceId)).toEqual([
			"work#2",
		]);
	});

	it("run cancellation while instances are queued: queued never start, run rejects as cancelled", async () => {
		const events: RunEvent[] = [];
		const startedIds: string[] = [];
		const g = fanout(
			fnNode<S, { i: number }>(async (_input, ctx) => {
				startedIds.push(ctx.instanceId);
				// 尊重信号：run 取消时 reject AbortError（§7.4 的节点义务）
				return await new Promise<Partial<S>>((_resolve, reject) => {
					ctx.signal.addEventListener("abort", () => reject(abortError()), {
						once: true,
					});
				});
			}),
		);

		const handle = run(g, itemsState(10), {
			maxConcurrency: 3,
			onEvent: (e) => events.push(e),
		});
		await tick(); // 3 个在跑、7 个排队
		expect(startedIds).toEqual(["work#2", "work#3", "work#4"]);

		handle.cancel();

		const error = await captureRejection(handle);

		// run 取消不包 NodeExecutionError（taxonomy 冻结，§7.4）
		expect(error).toBeInstanceOf(WorkflowError);
		expect((error as Error).message).toBe("run cancelled");
		expect(error).not.toBeInstanceOf(NodeExecutionError);
		// 排队的 7 个从未启动：handler 没被调用、没有 node_started
		expect(startedIds).toEqual(["work#2", "work#3", "work#4"]);
		expect(ofType(events, "node_started")).toHaveLength(4); // extract#1 + 3 个 work
		expect(ofType(events, "superstep_aborted").map((e) => e.superstep)).toEqual(
			[2],
		);
		// 单条 run_finished 契约：取消路径同样恰好一条收尾事件
		expect(ofType(events, "run_finished")).toHaveLength(1);
		expect(ofType(events, "run_finished")[0]).toMatchObject({
			status: "failed",
			superstep: 2,
		});
	});
});
