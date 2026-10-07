/**
 * Task 11：三级信号、fail-fast 取消、重试/超时与 RunHandle（设计 §7.1–§7.4、§4.4、§8.1）。
 *
 * 契约：
 * - 信号层级（§7.4）：run signal（调用方 signal / RunHandle.cancel() / runTimeoutMs 到期）
 *   → instance signal（run 透传 + 同超步任一兄弟失败）→ attempt signal（每次重试新建；
 *   本尝试超时只 abort 它，不影响下一次尝试）；
 * - 兄弟失败 fail-fast（§7.1）：根因 = 实例序最小的失败（T10 的确定性选举）；被连带取消
 *   **且未完成**的实例进 `NodeExecutionError.collateral`；已完成的兄弟结果被丢弃（不提交）；
 * - 重试（§7.2）：`retry.maxAttempts` = **总尝试次数**（含首次）；退避
 *   `min(500 * 2^n * random(), 30_000)` 走注入的 sleep/random；每次重试前发 `node_retry`；
 *   取消/abort 类失败不重试；无 retry 配置 = 行为不变；
 * - 超时（§7.3/§7.4）：`node.timeoutMs` 到期 abort attempt signal；超时的尝试按可重试失败
 *   处理；handler 既不 settle 也不检查信号时引擎靠"handler vs 超时"竞速收尾（不永久挂起，
 *   被放弃的 promise 不留 unhandled rejection）；
 * - run 取消/超时 → `WorkflowError`（"run cancelled" / "run timed out after Xms"），事件流
 *   以 `run_finished{failed}` 收尾；开跑前就已 abort 的外部 signal → 立即拒绝且**零事件**。
 *
 * 全部用例确定性：没有真实计时器——挂起用受控 promise，sleep/random 全部注入。
 * `tick()` 是 0ms 宏任务屏障（只用来排空微任务、对齐阶段，不承担计时语义）。
 */

import { describe, expect, it } from "vitest";

import { NodeExecutionError, WorkflowError } from "../../src/core/errors.js";
import { StateGraph } from "../../src/core/graph.js";
import {
	END,
	type NodeContext,
	type NodeDefinition,
	type NodeHandler,
	type RunEvent,
	type RunHandle,
	type RunOptions,
	START,
} from "../../src/core/types.js";
import { fnNode } from "../../src/nodes/fn.js";

type S = { v?: number };

/** 任务 brief 的 `g.run(...)` 简写：编译后跑一次（返回 RunHandle，可 cancel）。 */
function run(
	graph: StateGraph<S>,
	initial: S,
	options?: RunOptions,
	services?: Parameters<StateGraph<S>["compile"]>[0],
): RunHandle<S> {
	return graph.compile(services).run(initial, options);
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

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** 0ms 宏任务屏障：排空微任务后再继续（受控 promise 用例的阶段对齐点）。 */
function tick(): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});
}

/**
 * 受控 sleep：记录请求时长，由测试显式 `flush(ms)` 放行（`auto: true` 则到达即放行）。
 * 返回值与默认 sleep 同形（非枚举 `cancel()`，R20）——引擎的能力探测路径由此覆盖。
 * 没有任何真实计时器——超时/退避的时序完全由测试掌握。
 */
function fakeSleep(opts?: { auto?: boolean }): {
	sleep: (ms: number) => Promise<void>;
	requested: number[];
	/** 被引擎 cancel 掉的睡眠句柄（R20）：证明引擎不持有已结束的定时器。 */
	cancelled: number[];
	flush: (ms?: number) => void;
} {
	const requested: number[] = [];
	const cancelled: number[] = [];
	const pending: { ms: number; resolve: () => void }[] = [];
	const sleep = (ms: number): Promise<void> => {
		requested.push(ms);
		const promise: Promise<void> =
			opts?.auto === true
				? Promise.resolve()
				: new Promise<void>((resolve) => {
						pending.push({ ms, resolve });
					});
		Object.defineProperty(promise, "cancel", {
			value: () => {
				cancelled.push(ms);
			},
			enumerable: false,
		});
		return promise;
	};
	/** 放行指定时长的待决 sleep（省略 ms = 全部放行）。 */
	const flush = (ms?: number): void => {
		for (let i = pending.length - 1; i >= 0; i -= 1) {
			const item = pending[i];
			if (ms !== undefined && item.ms !== ms) {
				continue;
			}
			pending.splice(i, 1);
			item.resolve();
		}
	};
	return { sleep, requested, cancelled, flush };
}

/** 节点被取消时的标准 rejection（AbortError 形态，DOMException / Error 皆可）。 */
function abortError(): Error {
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}

/**
 * 尊重 ctx.signal 的挂起节点（§7.4 的节点义务）：永不自行 settle，
 * 只在信号 abort 时 reject AbortError；记录启动/被取消次数与信号本体。
 */
function hangingHandler(
	stats: { starts: number; aborts: number; signals: AbortSignal[] },
	started?: Deferred,
): NodeHandler<S, S> {
	return async (_input, ctx: NodeContext) => {
		stats.starts += 1;
		stats.signals.push(ctx.signal);
		started?.resolve();
		return await new Promise<Partial<S>>((_resolve, reject) => {
			ctx.signal.addEventListener(
				"abort",
				() => {
					stats.aborts += 1;
					reject(abortError());
				},
				{ once: true },
			);
		});
	};
}

/**
 * 带 retry/timeout 的 fn 定义（fnNode 不暴露 retry——§7.1 说 fn 不自动重试；
 * 这里手搓定义对象，直接观察引擎的重试/超时机制本身）。
 */
function configuredFn(cfg: {
	handler: NodeHandler<S, S>;
	maxAttempts?: number;
	timeoutMs?: number;
}): NodeDefinition<S, S> {
	return {
		kind: "fn",
		name: "",
		handler: cfg.handler,
		retry:
			cfg.maxAttempts === undefined
				? undefined
				: { maxAttempts: cfg.maxAttempts },
		timeoutMs: cfg.timeoutMs,
	};
}

/** START → a、START → b 的并联图（实例序：a#1、b#2）。 */
function parallel(
	a: NodeDefinition<S, S>,
	b: NodeDefinition<S, S>,
): StateGraph<S> {
	return new StateGraph<S>()
		.addNode("a", a)
		.addNode("b", b)
		.addEdge(START, "a")
		.addEdge(START, "b")
		.addEdge("a", END)
		.addEdge("b", END);
}

describe("fail-fast cancellation and collateral (设计 §7.1/§7.4)", () => {
	it("sibling failure reports root cause and collateral, cancels siblings", async () => {
		const events: RunEvent[] = [];
		const boom = new Error("b blew up");
		const aStats = { starts: 0, aborts: 0, signals: [] as AbortSignal[] };
		const started = deferred();

		// a 挂起并尊重信号（收到 abort 时 reject AbortError）；b 立即抛错。
		// a 带 retry 配置：被取消的尝试**不得**重试（取消不是失败）。
		const g = parallel(
			configuredFn({
				handler: hangingHandler(aStats, started),
				maxAttempts: 3,
			}),
			fnNode<S>(() => {
				throw boom;
			}),
		);

		const error = await captureRejection(
			run(g, {}, { onEvent: (e) => events.push(e) }),
		);

		await started.promise;
		expect(error).toBeInstanceOf(NodeExecutionError);
		const nodeError = error as NodeExecutionError;
		// 根因 = 唯一真正失败的实例（b#2）
		expect(nodeError.node).toBe("b");
		expect(nodeError.instanceId).toBe("b#2");
		expect(nodeError.cause).toBe(boom);
		// collateral = 被连带取消、未完成的兄弟实例（a#1）
		expect(nodeError.collateral).toEqual(["a#1"]);
		// 取消确实经信号到达节点（§7.4：节点靠 ctx.signal 退出）
		expect(aStats.aborts).toBe(1);
		expect(aStats.starts).toBe(1); // 取消的尝试不重试
		expect(aStats.signals[0].aborted).toBe(true);
		// 取消理由点名失败的兄弟实例（节点可据此区分取消与自身失败）
		expect((aStats.signals[0].reason as Error).message).toContain("b#2");
		// 被取消的实例不是失败：不发 node_failed / node_finished / node_retry
		expect(ofType(events, "node_failed").map((e) => e.node)).toEqual(["b"]);
		expect(ofType(events, "node_finished")).toHaveLength(0);
		expect(ofType(events, "node_retry")).toHaveLength(0);
		expect(ofType(events, "superstep_aborted")).toHaveLength(1);
		expect(ofType(events, "run_finished")[0].status).toBe("failed");
	});

	it("cancels every still-running sibling and lists them in instance order", async () => {
		const events: RunEvent[] = [];
		const boom = new Error("a blew up");
		const bStats = { starts: 0, aborts: 0, signals: [] as AbortSignal[] };
		const cStats = { starts: 0, aborts: 0, signals: [] as AbortSignal[] };

		// 实例序 a#1（失败）< b#2（挂起）< c#3（挂起）：根因是最早失败的那个，
		// collateral 按实例序列出两个被取消的兄弟。
		const g = new StateGraph<S>()
			.addNode(
				"a",
				fnNode<S>(() => {
					throw boom;
				}),
			)
			.addNode("b", fnNode<S>(hangingHandler(bStats)))
			.addNode("c", fnNode<S>(hangingHandler(cStats)))
			.addEdge(START, "a")
			.addEdge(START, "b")
			.addEdge(START, "c")
			.addEdge("a", END)
			.addEdge("b", END)
			.addEdge("c", END);

		const error = await captureRejection(
			run(g, {}, { onEvent: (e) => events.push(e) }),
		);

		expect(error).toBeInstanceOf(NodeExecutionError);
		const nodeError = error as NodeExecutionError;
		expect(nodeError.node).toBe("a");
		expect(nodeError.instanceId).toBe("a#1");
		expect(nodeError.cause).toBe(boom);
		expect(nodeError.collateral).toEqual(["b#2", "c#3"]);
		expect(bStats.aborts).toBe(1);
		expect(cStats.aborts).toBe(1);
		expect(ofType(events, "node_failed").map((e) => e.node)).toEqual(["a"]);
	});

	it("classifies a plain-error failure of a cancelled sibling as collateral, not as root (R20a)", async () => {
		const events: RunEvent[] = [];
		const boom = new Error("b blew up");
		const started = deferred();
		const aRuns: { count: number } = { count: 0 };

		// a 被取消后 reject 的是**普通 Error**（ECONNRESET 这类真实瞬态错误，不是 AbortError）：
		// R20a 的判定与错误形状无关——它仍是 collateral，不得当根因。
		const g = parallel(
			configuredFn({
				maxAttempts: 1,
				handler: async (_input, ctx) => {
					aRuns.count += 1;
					started.resolve();
					return await new Promise<Partial<S>>((_resolve, reject) => {
						ctx.signal.addEventListener(
							"abort",
							() => {
								reject(new Error("ECONNRESET"));
							},
							{ once: true },
						);
					});
				},
			}),
			fnNode<S>(() => {
				throw boom;
			}),
		);

		const error = await captureRejection(
			run(g, {}, { onEvent: (e) => events.push(e) }),
		);

		await started.promise;
		expect(error).toBeInstanceOf(NodeExecutionError);
		const nodeError = error as NodeExecutionError;
		// 根因 = 真正确认过的失败（b#2），不是被取消时才抛错的 a#1
		expect(nodeError.node).toBe("b");
		expect(nodeError.instanceId).toBe("b#2");
		expect(nodeError.cause).toBe(boom);
		expect(nodeError.collateral).toEqual(["a#1"]);
		expect(ofType(events, "node_failed").map((e) => e.node)).toEqual(["b"]);
		expect(aRuns.count).toBe(1);
	});

	it("classifies a shape-invalid fulfilment of a cancelled instance as collateral, not as root (R20a)", async () => {
		const events: RunEvent[] = [];
		const boom = new Error("b blew up");
		const gate = deferred();

		// a 的 handler 无视 ctx.signal：被取消之后才 fulfil，且返回数组（形状非法）。
		// R20a 的取消判定先于形状判定——否则 a#1（seq 更小）会被形状错误推上根因，
		// 掩盖真正触发的 b#2。
		const g = parallel(
			fnNode<S>(async () => {
				await gate.promise;
				return [] as unknown as Partial<S>;
			}),
			fnNode<S>(() => {
				throw boom;
			}),
		);

		const handle = run(g, {}, { onEvent: (e) => events.push(e) });
		await tick(); // b#2 已失败并 abort 了 a#1（a 仍挂在 gate 上）
		gate.resolve();

		const error = await captureRejection(handle);

		expect(error).toBeInstanceOf(NodeExecutionError);
		const nodeError = error as NodeExecutionError;
		// 根因 = b#2（真正的失败），不是被取消后才返回非法形状的 a#1
		expect(nodeError.node).toBe("b");
		expect(nodeError.instanceId).toBe("b#2");
		expect(nodeError.cause).toBe(boom);
		expect(nodeError.collateral).toEqual(["a#1"]);
		expect(ofType(events, "node_failed").map((e) => e.node)).toEqual(["b"]);
		expect(ofType(events, "node_finished")).toHaveLength(0);
	});

	it("emits no node_retry for a cancelled instance that fails with a plain error (R20a)", async () => {
		const events: RunEvent[] = [];
		const boom = new Error("b blew up");
		const started = deferred();
		let aRuns = 0;

		// 取消后到达的普通错误也不得产生"幻觉 node_retry"（重试根本不会发生）。
		const g = parallel(
			configuredFn({
				maxAttempts: 3,
				handler: async (_input, ctx) => {
					aRuns += 1;
					started.resolve();
					return await new Promise<Partial<S>>((_resolve, reject) => {
						ctx.signal.addEventListener(
							"abort",
							() => {
								reject(new Error("client canceled"));
							},
							{ once: true },
						);
					});
				},
			}),
			fnNode<S>(() => {
				throw boom;
			}),
		);

		const error = await captureRejection(
			run(g, {}, { onEvent: (e) => events.push(e) }),
		);

		await started.promise;
		expect(aRuns).toBe(1); // 取消不重试
		expect(ofType(events, "node_retry")).toHaveLength(0);
		expect(ofType(events, "node_failed").map((e) => e.node)).toEqual(["b"]);
		expect(error).toBeInstanceOf(NodeExecutionError);
		expect((error as NodeExecutionError).collateral).toEqual(["a#1"]);
	});

	it("does not list an already-completed sibling as collateral (its result is discarded)", async () => {
		const events: RunEvent[] = [];
		const boom = new Error("b blew up");
		const gate = deferred();

		const g = parallel(
			fnNode<S>(() => ({ v: 1 })),
			configuredFn({
				handler: async () => {
					await gate.promise;
					throw boom;
				},
			}),
		);

		const handle = run(g, {}, { onEvent: (e) => events.push(e) });
		await tick(); // a#1 已完成（node_finished 已发）
		gate.resolve();

		const error = await captureRejection(handle);

		expect(error).toBeInstanceOf(NodeExecutionError);
		const nodeError = error as NodeExecutionError;
		expect(nodeError.instanceId).toBe("b#2");
		// 已完成的兄弟不是"被取消"：collateral 为空，结果按超步原子性丢弃（不提交）
		expect(nodeError.collateral).toEqual([]);
		expect(ofType(events, "node_finished").map((e) => e.node)).toEqual(["a"]);
		expect(ofType(events, "superstep_committed")).toHaveLength(0);
	});
});

describe("run-level cancellation (设计 §4.4/§7.4)", () => {
	it("external signal cancels the run", async () => {
		const controller = new AbortController();
		const events: RunEvent[] = [];
		const stats = { starts: 0, aborts: 0, signals: [] as AbortSignal[] };
		const started = deferred();

		const g = new StateGraph<S>()
			.addNode("a", fnNode<S>(hangingHandler(stats, started)))
			.addEdge(START, "a")
			.addEdge("a", END);

		const handle = run(
			g,
			{},
			{ signal: controller.signal, onEvent: (e) => events.push(e) },
		);
		await started.promise;
		controller.abort();

		const error = await captureRejection(handle);

		// WorkflowError 基类（taxonomy 冻结，不新增类）
		expect(error).toBeInstanceOf(WorkflowError);
		expect(error).not.toBeInstanceOf(NodeExecutionError);
		expect((error as Error).message).toBe("run cancelled");
		expect(stats.aborts).toBe(1); // run 取消经 instance → attempt 传到节点
		expect(ofType(events, "run_finished")[0]).toMatchObject({
			status: "failed",
		});
		expect(events[events.length - 1].type).toBe("run_finished");
		expect(ofType(events, "node_failed")).toHaveLength(0);
	});

	it("rejects an already-aborted external signal before starting, emitting no events", async () => {
		const controller = new AbortController();
		controller.abort();
		const events: RunEvent[] = [];
		const stats = { starts: 0, aborts: 0, signals: [] as AbortSignal[] };

		const g = new StateGraph<S>()
			.addNode("a", fnNode<S>(hangingHandler(stats)))
			.addEdge(START, "a")
			.addEdge("a", END);

		const error = await captureRejection(
			run(g, {}, { signal: controller.signal, onEvent: (e) => events.push(e) }),
		);

		expect(error).toBeInstanceOf(WorkflowError);
		expect((error as Error).message).toBe("run cancelled");
		// 什么都没开始：零事件（run_started 都没有）
		expect(events).toEqual([]);
		expect(stats.starts).toBe(0);
	});

	it("cancel between supersteps: no superstep boundary, run_finished reports executed supersteps", async () => {
		const controller = new AbortController();
		const events: RunEvent[] = [];
		const seen: string[] = [];

		const g = new StateGraph<S>()
			.addNode(
				"a",
				fnNode<S>(() => ({ v: 1 })),
			)
			.addNode(
				"b",
				fnNode<S>(() => ({ v: 2 })),
			)
			.addEdge(START, "a")
			.addEdge("a", "b")
			.addEdge("b", END);

		const error = await captureRejection(
			run(
				g,
				{},
				{
					signal: controller.signal,
					onEvent: (e) => {
						events.push(e);
						seen.push(e.type);
						// 提交边界上同步取消：下一个超步不该再开始
						if (e.type === "superstep_committed") {
							controller.abort();
						}
					},
				},
			),
		);

		expect(error).toBeInstanceOf(WorkflowError);
		expect((error as Error).message).toBe("run cancelled");
		// 取消落在超步之间：没有超步被中途打断 → 没有 superstep_aborted 边界；
		// run_finished.superstep = 已执行的超步数（a 的那一步）
		expect(seen).toEqual([
			"run_started",
			"node_started",
			"node_finished",
			"superstep_committed",
			"run_finished",
		]);
		expect(ofType(events, "run_finished")[0]).toMatchObject({
			status: "failed",
			superstep: 1,
		});
		expect(ofType(events, "node_started").map((e) => e.node)).toEqual(["a"]);
	});

	it("runTimeoutMs aborts the run and rejects with a WorkflowError naming the timeout", async () => {
		const clock = fakeSleep();
		const events: RunEvent[] = [];
		const stats = { starts: 0, aborts: 0, signals: [] as AbortSignal[] };
		const started = deferred();

		const g = new StateGraph<S>()
			.addNode("a", fnNode<S>(hangingHandler(stats, started)))
			.addEdge(START, "a")
			.addEdge("a", END);

		const handle = run(
			g,
			{},
			{ runTimeoutMs: 1000, onEvent: (e) => events.push(e) },
			{ services: { sleep: clock.sleep } },
		);

		// run 级定时器在引擎的第一个 await 之前就已武装
		expect(clock.requested).toEqual([1000]);
		await started.promise;
		clock.flush(1000);

		const error = await captureRejection(handle);

		expect(error).toBeInstanceOf(WorkflowError);
		expect(error).not.toBeInstanceOf(NodeExecutionError);
		expect((error as Error).message).toContain("timed out");
		expect((error as Error).message).toContain("1000");
		expect(stats.aborts).toBe(1);
		// run_finished.superstep = 超时那一刻正在执行的超步
		expect(ofType(events, "run_finished")[0]).toMatchObject({
			status: "failed",
			superstep: 1,
		});
		expect(ofType(events, "superstep_aborted")).toHaveLength(1);
	});

	it("cancels the run-level deadline handle when the run finishes (R20)", async () => {
		const clock = fakeSleep();

		const g = new StateGraph<S>()
			.addNode(
				"a",
				fnNode<S>(() => ({ v: 1 })),
			)
			.addEdge(START, "a")
			.addEdge("a", END);

		const { state } = await run(
			g,
			{},
			{ runTimeoutMs: 600_000 },
			{ services: { sleep: clock.sleep } },
		);

		expect(state.v).toBe(1);
		expect(clock.requested).toEqual([600_000]);
		// run 正常结束 → 未到期的 run 级定时器被清掉：没有引擎持有的挂起计时器
		expect(clock.cancelled).toEqual([600_000]);
	});

	it("fn handler receives ctx.signal; RunHandle.cancel() aborts the run (idempotent, post-settle no-op)", async () => {
		const events: RunEvent[] = [];
		const stats = { starts: 0, aborts: 0, signals: [] as AbortSignal[] };
		const started = deferred();

		const g = new StateGraph<S>()
			.addNode("a", fnNode<S>(hangingHandler(stats, started)))
			.addEdge(START, "a")
			.addEdge("a", END);

		const handle = run(g, {}, { onEvent: (e) => events.push(e) });

		// RunHandle 形态：Promise + cancel()
		expect(typeof handle.then).toBe("function");
		expect(typeof handle.cancel).toBe("function");

		await started.promise;
		expect(stats.signals[0]).toBeInstanceOf(AbortSignal);
		expect(stats.signals[0].aborted).toBe(false);

		handle.cancel();
		handle.cancel(); // 幂等：重复调用无害（节点只观察到一次 abort）

		const error = await captureRejection(handle);

		expect(error).toBeInstanceOf(WorkflowError);
		expect((error as Error).message).toBe("run cancelled");
		expect(stats.aborts).toBe(1);
		expect(ofType(events, "run_finished")[0].status).toBe("failed");

		// settle 之后 cancel() 是 no-op：不抛错、不发事件
		const seen = events.length;
		expect(() => handle.cancel()).not.toThrow();
		expect(events).toHaveLength(seen);
	});
});

describe("retry with backoff (设计 §7.2)", () => {
	it("retries a failed attempt, emits node_retry and sleeps the jittered backoff", async () => {
		const clock = fakeSleep({ auto: true });
		const events: RunEvent[] = [];
		const flaky = new Error("429 rate limit");
		let runs = 0;

		const g = new StateGraph<S>()
			.addNode(
				"flaky",
				configuredFn({
					maxAttempts: 3,
					handler: () => {
						runs += 1;
						if (runs === 1) {
							throw flaky;
						}
						return { v: runs };
					},
				}),
			)
			.addEdge(START, "flaky")
			.addEdge("flaky", END);

		const { state } = await run(
			g,
			{},
			{ onEvent: (e) => events.push(e) },
			{ services: { sleep: clock.sleep, random: () => 0.5 } },
		);

		expect(state.v).toBe(2);
		expect(runs).toBe(2);
		// 首次重试的抖动退避：500 * 2^0 * 0.5 = 250（full jitter 走注入的 random）
		expect(clock.requested).toEqual([250]);
		const retries = ofType(events, "node_retry");
		expect(retries).toHaveLength(1);
		expect(retries[0]).toMatchObject({
			node: "flaky",
			instanceId: "flaky#1",
			attempt: 1, // 刚失败的那次尝试编号（1 起）
			error: "429 rate limit",
			superstep: 1,
		});
		expect(ofType(events, "node_finished")).toHaveLength(1);
		expect(ofType(events, "node_failed")).toHaveLength(0);
	});

	it("treats maxAttempts as the total attempt count, backing off exponentially", async () => {
		const clock = fakeSleep({ auto: true });
		const events: RunEvent[] = [];
		const boom = new Error("transient 503");
		let runs = 0;

		const g = new StateGraph<S>()
			.addNode(
				"always",
				configuredFn({
					maxAttempts: 3,
					handler: () => {
						runs += 1;
						throw boom;
					},
				}),
			)
			.addEdge(START, "always")
			.addEdge("always", END);

		const error = await captureRejection(
			run(
				g,
				{},
				{ onEvent: (e) => events.push(e) },
				{ services: { sleep: clock.sleep, random: () => 0.5 } },
			),
		);

		// 总尝试 3 次（首次 + 2 次重试），不是 3 次重试
		expect(runs).toBe(3);
		// 退避指数用"已重试次数"（0 起）：500*2^0*0.5、500*2^1*0.5
		expect(clock.requested).toEqual([250, 500]);
		expect(ofType(events, "node_retry").map((e) => e.attempt)).toEqual([1, 2]);
		expect(error).toBeInstanceOf(NodeExecutionError);
		// 重试耗尽后抛出的根因 = 最后一次尝试的错误
		expect((error as NodeExecutionError).cause).toBe(boom);
		expect(ofType(events, "node_failed")).toHaveLength(1);
	});

	it("caps the backoff at 30s", async () => {
		const clock = fakeSleep({ auto: true });

		const g = new StateGraph<S>()
			.addNode(
				"always",
				configuredFn({
					maxAttempts: 8,
					handler: () => {
						throw new Error("transient");
					},
				}),
			)
			.addEdge(START, "always")
			.addEdge("always", END);

		await captureRejection(
			run(g, {}, {}, { services: { sleep: clock.sleep, random: () => 1 } }),
		);

		// 500,1000,2000,4000,8000,16000,32000→30000（上限截断）
		expect(clock.requested).toEqual([
			500, 1000, 2000, 4000, 8000, 16000, 30_000,
		]);
	});

	it("does not retry an fn node without retry config (zero behavior change)", async () => {
		const events: RunEvent[] = [];
		const boom = new Error("boom");
		let runs = 0;

		const g = new StateGraph<S>()
			.addNode(
				"bad",
				fnNode<S>(() => {
					runs += 1;
					throw boom;
				}),
			)
			.addEdge(START, "bad")
			.addEdge("bad", END);

		const error = await captureRejection(
			run(
				g,
				{},
				{ onEvent: (e) => events.push(e) },
				{
					services: {
						sleep: () => {
							throw new Error("sleep must not be called without retry config");
						},
					},
				},
			),
		);

		expect(runs).toBe(1);
		expect(ofType(events, "node_retry")).toHaveLength(0);
		expect(error).toBeInstanceOf(NodeExecutionError);
		expect((error as NodeExecutionError).cause).toBe(boom);
	});

	it("stops retrying when the run is cancelled during the backoff sleep", async () => {
		const clock = fakeSleep();
		const events: RunEvent[] = [];
		let runs = 0;

		const g = new StateGraph<S>()
			.addNode(
				"always",
				configuredFn({
					maxAttempts: 3,
					handler: () => {
						runs += 1;
						throw new Error("transient");
					},
				}),
			)
			.addEdge(START, "always")
			.addEdge("always", END);

		const handle = run(
			g,
			{},
			{ onEvent: (e) => events.push(e) },
			{ services: { sleep: clock.sleep, random: () => 0.5 } },
		);

		await tick(); // 首次尝试失败并进入退避（sleep 未放行 = 一直睡着）
		expect(clock.requested).toEqual([250]);

		handle.cancel();

		// 取消不等满退避窗口：手动 sleep 从未放行，run 仍然立即收尾
		const error = await captureRejection(handle);

		expect(error).toBeInstanceOf(WorkflowError);
		expect(error).not.toBeInstanceOf(NodeExecutionError);
		expect((error as Error).message).toBe("run cancelled");
		expect(runs).toBe(1); // 不再重试
		expect(ofType(events, "node_retry")).toHaveLength(1); // 第一次失败时已发
		expect(ofType(events, "node_failed")).toHaveLength(0); // 取消不是失败
		// R20：取消赢得竞速 → 这个不再被等待的退避定时器被清掉
		expect(clock.cancelled).toEqual([250]);
	});
});

describe("attempt timeouts (设计 §7.3/§7.4)", () => {
	it("aborts the attempt signal on timeoutMs expiry and fails the attempt", async () => {
		const clock = fakeSleep();
		const events: RunEvent[] = [];
		const stats = { starts: 0, aborts: 0, signals: [] as AbortSignal[] };

		const g = new StateGraph<S>()
			.addNode(
				"slow",
				configuredFn({
					timeoutMs: 100,
					// 既不 settle 也不检查信号：引擎靠竞速收尾，不永久挂起
					handler: () => new Promise<Partial<S>>(() => {}),
				}),
			)
			.addEdge(START, "slow")
			.addEdge("slow", END);

		const handle = run(
			g,
			{},
			{ onEvent: (e) => events.push(e) },
			{ services: { sleep: clock.sleep } },
		);
		expect(clock.requested).toEqual([100]);
		clock.flush(100);

		const error = await captureRejection(handle);

		expect(error).toBeInstanceOf(NodeExecutionError);
		const nodeError = error as NodeExecutionError;
		expect(nodeError.message).toContain("timed out");
		expect(nodeError.collateral).toEqual([]);
		expect(ofType(events, "node_failed")[0].error).toContain("timed out");
		expect(stats.aborts).toBe(0); // handler 没参与，超时靠引擎判定
	});

	it("derives a fresh attempt signal per retry; a timeout abort does not leak into the next attempt", async () => {
		const clock = fakeSleep();
		const events: RunEvent[] = [];
		let runs = 0;
		const signals: AbortSignal[] = [];

		const g = new StateGraph<S>()
			.addNode(
				"flaky",
				configuredFn({
					maxAttempts: 2,
					timeoutMs: 100,
					handler: (_input, ctx) => {
						runs += 1;
						signals.push(ctx.signal);
						if (runs === 1) {
							return new Promise<Partial<S>>(() => {}); // 第一次尝试超时
						}
						return { v: runs };
					},
				}),
			)
			.addEdge(START, "flaky")
			.addEdge("flaky", END);

		const handle = run(
			g,
			{},
			{ onEvent: (e) => events.push(e) },
			{ services: { sleep: clock.sleep, random: () => 0.5 } },
		);
		expect(clock.requested).toEqual([100]);

		clock.flush(100); // attempt 1 超时 → 可重试失败
		await tick();
		expect(clock.requested).toEqual([100, 250]); // 退避 500*2^0*0.5
		clock.flush(250);

		const { state } = await handle;

		expect(state.v).toBe(2);
		expect(signals).toHaveLength(2);
		// 每次尝试一个信号：attempt 1 被超时 abort，attempt 2 不受影响
		expect(signals[0]).not.toBe(signals[1]);
		expect(signals[0].aborted).toBe(true);
		expect(signals[1].aborted).toBe(false);
		expect(ofType(events, "node_retry")).toHaveLength(1);
		expect(ofType(events, "node_finished")).toHaveLength(1);
	});

	it("cancels the attempt deadline handle when the attempt settles first (R20)", async () => {
		const clock = fakeSleep();

		const g = new StateGraph<S>()
			.addNode(
				"fast",
				configuredFn({
					timeoutMs: 100,
					handler: () => ({ v: 1 }),
				}),
			)
			.addEdge(START, "fast")
			.addEdge("fast", END);

		const { state } = await run(
			g,
			{},
			{},
			{ services: { sleep: clock.sleep } },
		);

		expect(state.v).toBe(1);
		expect(clock.requested).toEqual([100]); // 超时定时器已武装
		expect(clock.cancelled).toEqual([100]); // 尝试先 settle → 定时器被清掉（不留悬挂计时器）
	});

	it("tolerates injected sleeps without cancel (capability detection, R20)", async () => {
		const events: RunEvent[] = [];
		let runs = 0;

		const g = new StateGraph<S>()
			.addNode(
				"flaky",
				configuredFn({
					maxAttempts: 2,
					handler: () => {
						runs += 1;
						if (runs === 1) {
							throw new Error("transient");
						}
						return { v: runs };
					},
				}),
			)
			.addEdge(START, "flaky")
			.addEdge("flaky", END);

		// 普通注入 sleep（没有 cancel 方法）：能力探测必须放过它，重试照常
		const { state } = await run(
			g,
			{},
			{ onEvent: (e) => events.push(e) },
			{ services: { sleep: () => Promise.resolve(), random: () => 0.5 } },
		);

		expect(state.v).toBe(2);
		expect(runs).toBe(2);
		expect(ofType(events, "node_retry")).toHaveLength(1);
	});

	it("does not leak an unhandled rejection when an abandoned attempt rejects later", async () => {
		const clock = fakeSleep();
		let rejectLate: (error: unknown) => void = () => {};

		const g = new StateGraph<S>()
			.addNode(
				"zombie",
				configuredFn({
					timeoutMs: 100,
					handler: () =>
						new Promise<Partial<S>>((_resolve, reject) => {
							rejectLate = reject;
						}),
				}),
			)
			.addEdge(START, "zombie")
			.addEdge("zombie", END);

		const handle = run(g, {}, {}, { services: { sleep: clock.sleep } });
		clock.flush(100);

		await captureRejection(handle);

		// 被放弃的 handler 日后 reject：不得变成 unhandled rejection（vitest 会报）
		rejectLate(new Error("late failure after abandonment"));
		await tick();
	});
});
