/**
 * M5 T2：langgraph 差异黄金用例（设计 §11 十行 → 10 用例，D37）。
 *
 * 定位是**契约锁**（M3 D3 先例的扩展）：把 §11"与 langgraph 的语义/API 差异清单"
 * 十行逐行钉住 v1 现状，防止实现漂移——预期首跑即绿；某条红了先分清是
 * "§11 语义被读错"还是"实现漂移"。深度行为（去重/Send/recursionLimit/预算/
 * 冻结快照/stateSchema 校验）已在 engine.*.test.ts 套件覆盖，本文件每条深度行
 * 用例内注释指向对应文件；"功能缺席"行用 API 缺席或错误路径断言表达。
 *
 * 本文件只 import src/index.js 的导出（StateGraph/Send/START/END/fnNode/错误类…）——
 * 测试即消费者视角，与 tests/public-exports.test.ts 同一口径。
 */

import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import {
	append,
	END,
	fnNode,
	GraphRecursionError,
	GraphValidationError,
	RouterError,
	type RunOptions,
	type RunResult,
	Send,
	START,
	StateGraph,
} from "../../src/index.js";

/** `g.compile().run(...)` 简写。 */
function run<S extends object>(
	graph: StateGraph<S>,
	initial: S,
	options?: RunOptions,
): Promise<RunResult<S>> {
	return graph.compile().run(initial, options);
}

/** 跑一个 promise 并交出 rejection 的错误本体。 */
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

/** START → a → END 的最小图（a 写 { v: 1 }）。 */
function minimal(): StateGraph<BasicState> {
	return new StateGraph<BasicState>()
		.addNode(
			"a",
			fnNode<BasicState>(() => ({ v: 1 })),
		)
		.addEdge(START, "a")
		.addEdge("a", END);
}

describe("langgraph 差异黄金用例（设计 §11 十行，D37）", () => {
	it("diff 1: run() 返回 { state, runId }，不是 langgraph invoke 的裸 state", async () => {
		// 深度覆盖：tests/core/engine.determinism.test.ts（golden #1）、
		// tests/core/engine.basic.test.ts（engine: wiring）。
		const result = await run(minimal(), { v: 0 });

		// 解构出来的是 RunResult 两字段；把 result 当裸 state 用（langgraph 习惯）拿不到通道值
		expect(Object.keys(result).sort()).toEqual(["runId", "state"]);
		expect(typeof result.runId).toBe("string");
		expect(result.runId.length).toBeGreaterThan(0);
		expect(result.state.v).toBe(1);
		expect((result as unknown as BasicState).v).toBeUndefined();
	});

	it("diff 2: 同超步普通触发按节点名去重，Send 触发不去重（与 langgraph 一致）", async () => {
		// 深度覆盖：tests/core/engine.basic.test.ts（engine: plain-edge dedup §5.4）、
		// tests/core/engine.scale.test.ts（golden #2/#3）、tests/core/send.test.ts。
		type S = { v?: number };
		let cRuns = 0;
		let dRuns = 0;
		const dPayloads: { i: number }[] = [];

		const g = new StateGraph<S>()
			.addNode(
				"a",
				fnNode<S>(() => ({})),
			)
			.addNode(
				"b",
				fnNode<S>(() => ({})),
			)
			.addNode(
				"c",
				fnNode<S>(() => {
					cRuns += 1;
					return {};
				}),
			)
			.addConditionalEdges("c", () => [
				new Send("d", { i: 1 }),
				new Send("d", { i: 2 }),
			])
			.addNode(
				"d",
				fnNode<S>((input) => {
					dRuns += 1;
					dPayloads.push(input as { i: number });
					return {};
				}),
			)
			.addEdge(START, "a")
			.addEdge(START, "b")
			.addEdge("a", "c")
			.addEdge("b", "c")
			.addEdge("d", END);

		await run(g, {});

		// a、b 两条普通边都指向 c：同超步按节点名去重，c 只跑 1 次；
		// c 的 router 发出 2 个同名 Send：Send 不去重，d 跑 2 次、各拿各的载荷
		expect(cRuns).toBe(1);
		expect(dRuns).toBe(2);
		expect(dPayloads).toEqual([{ i: 1 }, { i: 2 }]);
	});

	it("diff 3: router 有第二参数 lastUpdate（langgraph branch 只收 state；超集，可忽略）", async () => {
		// 深度覆盖：tests/core/engine.router.test.ts（engine: router evaluation——
		// "passes lastUpdate = the node's own writes only"）。
		type S = { log: string[] };
		const seenLastUpdates: Partial<S>[] = [];

		const g = new StateGraph<S>({ channels: { log: append } })
			.addNode(
				"a",
				fnNode<S>(() => ({ log: ["a"] })),
			)
			.addConditionalEdges("a", (state, lastUpdate) => {
				seenLastUpdates.push(lastUpdate);
				// 第二参数是"该节点本超步自身写入"；不需要时可以整个忽略
				expect(state.log).toEqual(["a"]);
				return END;
			})
			.addEdge(START, "a");

		await run(g, { log: [] });

		expect(seenLastUpdates).toEqual([{ log: ["a"] }]);
	});

	it("diff 4: recursionLimit = 超步数上限（langgraph recursion_limit 的同义计数）", async () => {
		// 深度覆盖：tests/core/engine.basic.test.ts（engine: recursion limit §5.5）。
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

		const error = await captureRejection(run(g, {}, { recursionLimit: 2 }));

		expect(error).toBeInstanceOf(GraphRecursionError);
		const recursion = error as GraphRecursionError;
		// limit 内正好跑 2 个超步；错误里的 superstep 是被拒绝的"尝试超步"（limit + 1）
		expect(runs).toBe(2);
		expect(recursion.limit).toBe(2);
		expect(recursion.superstep).toBe(3);
	});

	it("diff 5: 无 checkpoint / interrupt / store（v1 没有；需人工停等请勿用 v1）", () => {
		const g = minimal();
		const app = g.compile();
		const probe = app as unknown as Record<string, unknown>;

		// 编译产物公开面只有 name/run/invoke/data——没有 checkpoint/interrupt/store 挂点
		expect(Object.keys(app).sort()).toEqual(["data", "invoke", "name", "run"]);
		expect(probe.checkpoint).toBeUndefined();
		expect(probe.interrupt).toBeUndefined();
		expect(probe.store).toBeUndefined();
		// 构建器同样没有任何停等/持久化 API
		const builder = g as unknown as Record<string, unknown>;
		expect(builder.checkpoint).toBeUndefined();
		expect(builder.interrupt).toBeUndefined();
		expect(builder.store).toBeUndefined();
		// 顺带钉住：这里的 invoke 只是 run 的别名（返回 RunResult，不是 langgraph 的裸 state invoke）
		expect(app.invoke).toBe(app.run);
	});

	it("diff 6: 无 path_map——router 直接返回节点名，逻辑标签即未注册目标", async () => {
		// 深度覆盖：tests/core/engine.router.test.ts（engine: RouterError §7.5）。
		type S = { v?: number };
		let reviewRuns = 0;

		// 正面：router 返回的就是节点名——注册了就能走（没有"逻辑标签 → 节点"的映射层）
		const direct = new StateGraph<S>()
			.addNode(
				"a",
				fnNode<S>(() => ({ v: 1 })),
			)
			.addNode(
				"review",
				fnNode<S>(() => {
					reviewRuns += 1;
					return {};
				}),
			)
			.addConditionalEdges("a", () => "review")
			.addEdge(START, "a")
			.addEdge("review", END);
		await run(direct, {});
		expect(reviewRuns).toBe(1);

		// 反面：返回未注册的逻辑标签（langgraph 里可用 path_map 映射的写法）→ RouterError
		const labeled = new StateGraph<S>()
			.addNode(
				"a",
				fnNode<S>(() => ({ v: 1 })),
			)
			.addNode(
				"review",
				fnNode<S>(() => ({})),
			)
			.addConditionalEdges("a", () => "HIGH_RISK")
			.addEdge(START, "a")
			.addEdge("review", END);
		const error = await captureRejection(run(labeled, {}));

		expect(error).toBeInstanceOf(RouterError);
		expect((error as RouterError).nodeId).toBe("a");
		expect((error as RouterError).result).toBe("HIGH_RISK");
		expect((error as RouterError).message).toContain(
			'returned unregistered node "HIGH_RISK"',
		);
		// 注册面只有 (from, router) 两个位置参数——没有 path_map/options 之类的第三参
		expect(direct.addConditionalEdges.length).toBe(2);
	});

	it("diff 7: 无静态 Send 边——Send 只能出现在 router 返回值中", async () => {
		// 深度覆盖（动态 Send 扇出）：tests/core/send.test.ts、
		// tests/core/engine.router.test.ts（engine: Send fan-out §5.3/§5.4）。
		type S = { v?: number };
		const g = new StateGraph<S>()
			.addNode(
				"a",
				fnNode<S>(() => ({ v: 1 })),
			)
			.addNode(
				"d",
				fnNode<S>(() => ({})),
			)
			.addEdge(START, "a")
			.addEdge("d", END);

		// 构建器没有任何"图里声明 Send 边"的 API
		const probe = g as unknown as Record<string, unknown>;
		expect(probe.addSendEdge).toBeUndefined();
		expect(probe.addSend).toBeUndefined();

		// 错误路径：把 Send 塞进静态边目标（JS 调用方才到得了）→ compile 校验拒绝
		const send = new Send("d", { i: 1 });
		g.addEdge("a", send as unknown as string);
		const error = captureRejectionSync(() => g.compile());

		expect(error).toBeInstanceOf(GraphValidationError);
		const invalid = error as GraphValidationError;
		expect(invalid.issues).toHaveLength(1);
		expect(invalid.issues[0]).toContain("not a registered node");
	});

	it("diff 8: 无 per-node concurrencyKey——并发只有一个全局 maxConcurrency", async () => {
		// 深度覆盖（全局并发上限行为）：tests/core/engine.budget.test.ts
		// （I/O concurrency cap: maxConcurrency）。
		const def = fnNode<BasicState>(() => ({}));

		// 节点定义面没有 per-node 并发键（fnNode 产出的就是这四个字段）
		expect(Object.keys(def).sort()).toEqual([
			"handler",
			"kind",
			"name",
			"timeoutMs",
		]);
		expect(def).not.toHaveProperty("concurrencyKey");

		// 并发控制在 run 侧、全局一个旋钮：maxConcurrency: 1 时实例串行执行
		type S = { v?: number };
		let cur = 0;
		let maxCur = 0;
		const g = new StateGraph<S>()
			.addNode(
				"a",
				fnNode<S>(async () => {
					cur += 1;
					maxCur = Math.max(maxCur, cur);
					await Promise.resolve();
					cur -= 1;
					return {};
				}),
			)
			.addNode(
				"b",
				fnNode<S>(async () => {
					cur += 1;
					maxCur = Math.max(maxCur, cur);
					await Promise.resolve();
					cur -= 1;
					return {};
				}),
			)
			.addEdge(START, "a")
			.addEdge(START, "b");

		await run(g, {}, { maxConcurrency: 1 });
		expect(maxCur).toBe(1);
	});

	it("diff 9: 节点输入是只读快照——修改属未定义行为，变更请返回 partial state", async () => {
		// 深度覆盖：tests/core/engine.basic.test.ts（engine: BSP snapshot §5.1）、
		// tests/core/engine.atomicity.test.ts（dev-mode input freeze §5.1:352）。
		// 引擎在开发模式（NODE_ENV !== "production"，vitest 默认 test）深冻结实例输入。
		type S = { v?: number; nested?: { w: number }; out?: string };
		let frozenInput = false;
		let frozenNested = false;
		let mutationError: unknown;

		const g = new StateGraph<S>()
			.addNode(
				"a",
				fnNode<S>((input) => {
					frozenInput = Object.isFrozen(input);
					frozenNested = Object.isFrozen(input.nested);
					try {
						// 未定义行为：dev 模式下 strict mode 直接 TypeError（JS 侧才到得了的写法）
						(input as { v?: number }).v = 99;
					} catch (error) {
						mutationError = error;
					}
					// 需要变更请返回 partial state（受支持的方式）
					return { v: 42, out: "returned" };
				}),
			)
			.addEdge(START, "a")
			.addEdge("a", END);

		const initial: S = { v: 1, nested: { w: 1 } };
		const { state } = await run(g, initial);

		expect(frozenInput).toBe(true);
		expect(frozenNested).toBe(true);
		expect(mutationError).toBeInstanceOf(TypeError);
		// 提交的只有返回的 partial：初始值与快照均未被就地修改
		expect(state.v).toBe(42);
		expect(state.out).toBe("returned");
		expect(initial.v).toBe(1);
		expect(initial.nested?.w).toBe(1);
	});

	it("diff 10: stateSchema 可选——不提供也能构建运行；提供了才做初始/写入校验", async () => {
		// 深度覆盖：tests/core/engine.atomicity.test.ts（runtime stateSchema obligations
		// §6.7）、tests/core/graph.compile.test.ts（writeTo 的 key 宇宙 §6.5）。
		// 不提供 schema：照常构建、运行、合并（§11 使用者注意：不提供则只做合并冲突检查，
		// 冲突面深度覆盖在 tests/core/state.test.ts 的 foldUpdates 与 engine 套件）。
		const bare = new StateGraph<BasicState>()
			.addNode(
				"a",
				fnNode<BasicState>(() => ({ v: 1 })),
			)
			.addEdge(START, "a")
			.addEdge("a", END);
		const bareApp = bare.compile();

		expect(
			(bareApp as unknown as { data: { stateSchema?: unknown } }).data
				.stateSchema,
		).toBeUndefined();
		const { state } = await bareApp.run({ v: 0 });
		expect(state.v).toBe(1);

		// 提供了 schema：初始 state 不匹配 → run 前即拒（GraphValidationError）
		const strict = new StateGraph<{ x?: number }>({
			stateSchema: Type.Object({ x: Type.Number() }),
		})
			.addNode(
				"a",
				fnNode<{ x?: number }>(() => ({ x: 1 })),
			)
			.addEdge(START, "a")
			.addEdge("a", END);

		const error = await captureRejection(
			strict.compile().run({ y: 2 } as unknown as { x?: number }),
		);

		expect(error).toBeInstanceOf(GraphValidationError);
		expect((error as GraphValidationError).message).toBe(
			"initial state does not match stateSchema",
		);
	});
});

/** 同步版本的"捕获抛出值"（compile 期校验是同步 throw）。 */
function captureRejectionSync(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error("expected the function to throw, but it returned normally");
}
