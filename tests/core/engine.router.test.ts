/**
 * Task 9：条件边与 Send（设计 §5.4 触发/去重、§4.2 `lastUpdate`、§7.5 RouterError、§5.1 超步算法）。
 *
 * 契约：
 * - router 每节点每超步**求值一次**（即使该节点有 N 个 Send 实例）；求值顺序按
 *   "该节点最早实例的 seq"升序（确定性，与完成顺序无关）；
 * - router 读**提交后**的合并 state 与 `lastUpdate`（该节点本超步自身写入的 fold，
 *   未写任何 key 时为 {}）；
 * - 普通边目标与 router 字符串结果共享同一去重表（按节点名，保留最早实例）；
 *   Send 实例**不去重**（同目标多个 Send = 多个实例，input = Send 载荷）；
 * - `null`/`undefined`/`[]`/`END` 等价于"该分支终止"；
 * - 未知节点 / START / 指向 END 的 Send / router 抛错 → `RouterError{nodeId, result}`。
 *
 * 本任务不含预算/取消/重试（T10–T12）。
 */

import { describe, expect, it } from "vitest";
import { NodeExecutionError, RouterError } from "../../src/core/errors.js";
import { StateGraph } from "../../src/core/graph.js";
import { Send } from "../../src/core/send.js";
import { append } from "../../src/core/state.js";
import {
	END,
	type Router,
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

describe("engine: Send fan-out (设计 §5.3/§5.4)", () => {
	it("router returning Send[] fans out one instance per Send, inputs are the Send payloads", async () => {
		type ClauseState = {
			clauses: { id: string }[];
			reviews: string[];
		};
		const clauses = [{ id: "c1" }, { id: "c2" }, { id: "c3" }];
		const payloads: { clause: { id: string } }[] = [];
		const seen: { clause: { id: string } }[] = [];
		const reviewIds: string[] = [];
		const events: RunEvent[] = [];

		const g = new StateGraph<ClauseState>({
			channels: { reviews: append },
		})
			.addNode(
				"extract",
				fnNode<ClauseState>(() => ({ clauses })),
			)
			// 完全由 router 驱动扇出：extract 没有普通边指向 review
			.addConditionalEdges("extract", (state) =>
				state.clauses.map((c) => {
					const payload = { clause: c };
					payloads.push(payload);
					return new Send("review", payload);
				}),
			)
			.addNode(
				"review",
				fnNode<ClauseState, { clause: { id: string } }>((input, ctx) => {
					seen.push(input);
					reviewIds.push(ctx.instanceId);
					return { reviews: [input.clause.id] };
				}),
			)
			.addEdge(START, "extract")
			.addEdge("review", END);

		const { state } = await run(
			g,
			{ clauses: [], reviews: [] },
			{ onEvent: (e) => events.push(e) },
		);

		// 3 个 Send → 3 个实例，每个实例的 input 就是对应的 Send 载荷（同一引用，
		// 无拷贝、无 state 快照替换）：三个实例的载荷彼此独立、逐条对应
		expect(seen).toHaveLength(3);
		expect(payloads).toHaveLength(3);
		expect(seen[0]).toBe(payloads[0]);
		expect(seen[1]).toBe(payloads[1]);
		expect(seen[2]).toBe(payloads[2]);
		expect(seen).toEqual(payloads);
		expect(seen.map((p) => p.clause.id)).toEqual(["c1", "c2", "c3"]);
		// 载荷里的 clause 就是提交后 state 里的那个对象（引用透传）
		expect(seen[0].clause).toBe(clauses[0]);
		// 实例序在 Send 间递增：extract#1 → review#2/#3/#4
		expect(reviewIds).toEqual(["review#2", "review#3", "review#4"]);
		// 写回经目标 key 的 reducer（append）汇入 state，按实例序折叠
		expect(state.reviews).toEqual(["c1", "c2", "c3"]);
		// 事件流：每个 Send 实例一个 node_started
		const reviewStarted = ofType(events, "node_started").filter(
			(e) => e.node === "review",
		);
		expect(reviewStarted.map((e) => e.instanceId).sort()).toEqual([
			"review#2",
			"review#3",
			"review#4",
		]);
		expect(
			ofType(events, "node_finished").filter((e) => e.node === "review"),
		).toHaveLength(3);
	});

	it("Send bypasses the dedup table: a Send target that is also a plain-edge target runs twice", async () => {
		type S = { fromPlain?: number; fromSend?: number };
		const inputs: unknown[] = [];

		const g = new StateGraph<S>()
			.addNode(
				"a",
				fnNode<S>(() => ({})),
			)
			.addNode(
				"b",
				fnNode<S>(() => ({})),
			)
			.addConditionalEdges("a", () => new Send("x", { via: "send" }))
			.addNode(
				"x",
				fnNode<S, { via?: string }>((input) => {
					inputs.push(input);
					return input.via === "send" ? { fromSend: 1 } : { fromPlain: 1 };
				}),
			)
			.addEdge(START, "a")
			.addEdge(START, "b")
			.addEdge("b", "x")
			.addEdge("x", END);

		const { state } = await run(g, {});

		// 普通触发（b 的边）去重后一个实例；Send 不去重，追加第二个实例
		expect(inputs).toHaveLength(2);
		expect(inputs).toContainEqual({});
		expect(inputs).toContainEqual({ via: "send" });
		expect(state).toMatchObject({ fromPlain: 1, fromSend: 1 });
	});
});

describe("engine: router activation (设计 §5.4)", () => {
	it("router string results dedup by node name; duplicate names collapse to one instance", async () => {
		type S = { xRuns?: number };
		let xRuns = 0;

		const g = new StateGraph<S>()
			.addNode(
				"a",
				fnNode<S>(() => ({})),
			)
			.addConditionalEdges("a", () => ["x", "x"])
			.addNode(
				"x",
				fnNode<S>(() => {
					xRuns += 1;
					return { xRuns: 1 };
				}),
			)
			.addEdge(START, "a")
			.addEdge("x", END);

		const { state } = await run(g, {});

		expect(xRuns).toBe(1);
		expect(state.xRuns).toBe(1);
	});

	it("a router string and a plain edge to the same node collapse into one activation", async () => {
		type S = { log: string[] };
		const zInputs: S[] = [];
		const zIds: string[] = [];
		let wRuns = 0;

		const g = new StateGraph<S>({ channels: { log: append } })
			.addNode(
				"a",
				fnNode<S>(() => ({ log: ["a"] })),
			)
			.addNode(
				"b",
				fnNode<S>(() => ({ log: ["b"] })),
			)
			// z 同时是 b 的普通边目标（共享去重表）；w 只由 router 触达
			.addConditionalEdges("a", () => ["z", "w"])
			.addNode(
				"z",
				fnNode<S>((input, ctx) => {
					zInputs.push(input as S);
					zIds.push(ctx.instanceId);
					return { log: ["z"] };
				}),
			)
			.addNode(
				"w",
				fnNode<S>(() => {
					wRuns += 1;
					return { log: ["w"] };
				}),
			)
			.addEdge(START, "a")
			.addEdge(START, "b")
			.addEdge("b", "z")
			.addEdge("z", END)
			.addEdge("w", END);

		const { state } = await run(g, { log: [] });

		// 共享去重表：两个来源只产生一个 z 实例
		expect(zIds).toEqual(["z#3"]);
		// 普通触发的输入 = 提交后 state 的只读快照
		expect(zInputs[0].log).toEqual(["a", "b"]);
		// router 触达的 w 照常激活
		expect(wRuns).toBe(1);
		expect(state.log).toEqual(["a", "b", "z", "w"]);
	});

	it("handles mixed router results: string dedups, Send fans out, END terminates only that item", async () => {
		type S = { log: string[] };
		let xRuns = 0;
		let yRuns = 0;

		const graph = new StateGraph<S>({ channels: { log: append } })
			.addNode(
				"a",
				fnNode<S>(() => ({})),
			)
			.addConditionalEdges("a", () => [
				"x",
				END,
				new Send("y", { via: "send" }),
				"x",
			])
			.addNode(
				"x",
				fnNode<S>(() => {
					xRuns += 1;
					return { log: ["x"] };
				}),
			)
			.addNode(
				"y",
				fnNode<S, { via: string }>((input) => {
					yRuns += 1;
					return { log: [`y:${input.via}`] };
				}),
			)
			.addEdge(START, "a")
			.addEdge("x", END)
			.addEdge("y", END);

		const { state } = await run(graph, { log: [] });

		expect(xRuns).toBe(1); // ["x", ..., "x"] 去重
		expect(yRuns).toBe(1); // Send 不去重，但这里只有一个
		expect(state.log).toEqual(["x", "y:send"]); // END 项不激活任何节点
	});

	it("treats null / undefined / [] / END results as END (branch terminates, run completes)", async () => {
		type S = { ran?: number };
		const results: unknown[] = [null, undefined, [], END];

		for (const result of results) {
			let targetRuns = 0;
			let routerCalls = 0;
			const g = new StateGraph<S>()
				.addNode(
					"a",
					fnNode<S>(() => ({ ran: 1 })),
				)
				// RouterResult 类型（Task 5 冻结）不含 null/undefined，而设计 §4.2 声明
				// 二者合法——JS 调用方与 `as` 之后的 TS 调用方都走运行期归一化。
				.addConditionalEdges("a", (() => {
					routerCalls += 1;
					return result;
				}) as unknown as Router<S>)
				.addNode(
					"target",
					fnNode<S>(() => {
						targetRuns += 1;
						return {};
					}),
				)
				.addEdge(START, "a")
				.addEdge("target", END);

			const { state } = await run(g, {});

			// router 求值了（结果是 END 语义），但没有激活任何节点
			expect(routerCalls).toBe(1);
			expect(targetRuns).toBe(0);
			expect(state.ran).toBe(1);
		}
	});
});

describe("engine: router evaluation (设计 §4.2/§5.1)", () => {
	it("evaluates the router ONCE per node per superstep even when the node had N Send instances", async () => {
		type S = { clauses: { id: string }[] };
		let routerCalls = 0;
		let reviewRuns = 0;

		const g = new StateGraph<S>({ channels: { clauses: append } })
			.addNode(
				"extract",
				fnNode<S>(() => ({
					clauses: [{ id: "c1" }, { id: "c2" }, { id: "c3" }],
				})),
			)
			.addConditionalEdges("extract", (state) =>
				state.clauses.map((c) => new Send("review", { clause: c })),
			)
			.addNode(
				"review",
				fnNode<S>(() => {
					reviewRuns += 1;
					return {};
				}),
			)
			.addConditionalEdges("review", () => {
				routerCalls += 1;
				return END;
			})
			.addEdge(START, "extract");

		await run(g, { clauses: [] });

		expect(reviewRuns).toBe(3);
		expect(routerCalls).toBe(1);
	});

	it("reads the state committed by the whole superstep, including other nodes' writes", async () => {
		type S = { log: string[] };
		let observed: string[] | undefined;
		let releaseA: () => void = () => {};
		const bDone = new Promise<void>((resolve) => {
			releaseA = resolve;
		});

		const g = new StateGraph<S>({ channels: { log: append } })
			.addNode(
				// a 后完成：router 仍在整个超步提交之后求值
				"a",
				fnNode<S>(async () => {
					await bDone;
					return { log: ["a"] };
				}),
			)
			.addNode(
				"b",
				fnNode<S>(() => {
					releaseA();
					return { log: ["b"] };
				}),
			)
			.addConditionalEdges("a", (state) => {
				observed = [...state.log];
				return END;
			})
			.addEdge(START, "a")
			.addEdge(START, "b")
			.addEdge("b", END);

		await run(g, { log: [] });

		// 合并按实例 seq（a#1 在前），与完成顺序无关
		expect(observed).toEqual(["a", "b"]);
	});

	it("evaluates routers in ascending order of each node's earliest instance seq, not completion order", async () => {
		type S = { done?: boolean };
		const evalOrder: string[] = [];
		const startedOrder: string[] = [];
		let releaseA: () => void = () => {};
		const aGate = new Promise<void>((resolve) => {
			releaseA = resolve;
		});

		const g = new StateGraph<S>()
			.addNode(
				"hub",
				fnNode<S>(() => ({})),
			)
			.addConditionalEdges("hub", () => [new Send("a", {}), new Send("b", {})])
			.addNode(
				"a",
				fnNode<S>(async (_input, ctx) => {
					startedOrder.push(ctx.instanceId);
					await aGate;
					return {};
				}),
			)
			.addNode(
				"b",
				fnNode<S>((_input, ctx) => {
					startedOrder.push(ctx.instanceId);
					releaseA(); // b 先完成，a 后完成
					return {};
				}),
			)
			.addConditionalEdges("a", () => {
				evalOrder.push("a");
				return END;
			})
			.addConditionalEdges("b", () => {
				evalOrder.push("b");
				return END;
			})
			.addEdge(START, "hub");

		await run(g, {});

		expect(startedOrder).toEqual(["a#2", "b#3"]);
		// b 先跑完（releaseA 在 b 内），但求值序按最早实例 seq：a#2 → b#3
		expect(evalOrder).toEqual(["a", "b"]);
	});

	it("passes lastUpdate = the node's own writes only ({} when it wrote nothing)", async () => {
		type S = { log: string[] };
		const seen: { state: S; lastUpdate: Partial<S> }[] = [];

		const g = new StateGraph<S>({ channels: { log: append } })
			.addNode(
				"a",
				fnNode<S>(() => ({ log: ["a"] })),
			)
			.addNode(
				"b",
				fnNode<S>(() => ({ log: ["b"] })),
			)
			.addConditionalEdges("a", (state, lastUpdate) => {
				seen.push({ state, lastUpdate });
				return END;
			})
			.addEdge(START, "a")
			.addEdge(START, "b")
			.addEdge("b", END);

		await run(g, { log: [] });

		expect(seen).toHaveLength(1);
		// 第一参数：提交后的合并 state（a、b 的写入都在）
		expect(seen[0].state.log).toEqual(["a", "b"]);
		// 第二参数：只含 a 自己的写入（不含 b 的）
		expect(seen[0].lastUpdate).toEqual({ log: ["a"] });
		expect(Object.keys(seen[0].lastUpdate)).toEqual(["log"]);
	});

	it("folds the node's own instances by seq order into lastUpdate (Send fan-in)", async () => {
		type S = { log: string[] };
		let routerSaw: Partial<S> | undefined;

		const g = new StateGraph<S>({ channels: { log: append } })
			.addNode(
				"hub",
				fnNode<S>(() => ({})),
			)
			.addConditionalEdges("hub", () => [
				new Send("fan", { tag: "x1" }),
				new Send("fan", { tag: "x2" }),
				new Send("fan", { tag: "x3" }),
			])
			.addNode(
				"fan",
				fnNode<S, { tag: string }>((input) => ({ log: [input.tag] })),
			)
			.addConditionalEdges("fan", (_state, lastUpdate) => {
				routerSaw = lastUpdate;
				return END;
			})
			.addEdge(START, "hub");

		const { state } = await run(g, { log: [] });

		expect(routerSaw).toEqual({ log: ["x1", "x2", "x3"] });
		// 全局 state 也一样（同一 fold 路径），但 lastUpdate 只含本节点写入
		expect(state.log).toEqual(["x1", "x2", "x3"]);
	});

	it("lastUpdate carries only this superstep's new writes, not accumulated state (loop fan-out)", async () => {
		type S = { clauses: string[] };
		const fannedOut: string[] = [];
		let round = 0;

		const g = new StateGraph<S>({ channels: { clauses: append } })
			.addNode(
				"add",
				fnNode<S>(() => {
					round += 1;
					if (round === 1) {
						return { clauses: ["c1"] };
					}
					if (round === 2) {
						return { clauses: ["c2"] };
					}
					return {};
				}),
			)
			.addConditionalEdges("add", (_state, lastUpdate) => {
				// §5.5：只对本次新写入扇出（读累积 state 会重复扇出 c1）
				const fresh = lastUpdate.clauses ?? [];
				fannedOut.push(...fresh);
				return fresh.map((clause) => new Send("check", { clause }));
			})
			.addNode(
				"check",
				fnNode<S, { clause: string }>(() => ({})),
			)
			.addEdge(START, "add")
			.addEdge("check", "add");

		const { state } = await run(g, { clauses: [] });

		expect(fannedOut).toEqual(["c1", "c2"]);
		// 累积 state 里两份都在（lastUpdate ≠ state.clauses）
		expect(state.clauses).toEqual(["c1", "c2"]);
	});
});

describe("engine: RouterError (设计 §7.5)", () => {
	/** 跑一个"router 结果由 `result()` 给出"的图，返回 rejection 的错误与事件流。 */
	async function rejectWith(
		result: () => unknown,
	): Promise<{ error: unknown; events: RunEvent[] }> {
		const events: RunEvent[] = [];
		const g = new StateGraph<{ v?: number }>()
			.addNode(
				"a",
				fnNode<{ v?: number }>(() => ({ v: 1 })),
			)
			// a 的 router 返回的合法目标之一（用于"数组里前面的合法项不放行"用例）
			.addNode(
				"x",
				fnNode<{ v?: number }>(() => ({})),
			)
			.addConditionalEdges("a", result as unknown as Router<{ v?: number }>)
			.addEdge(START, "a")
			.addEdge("x", END);
		const error = await captureRejection(
			run(g, {}, { onEvent: (e) => events.push(e) }),
		);
		return { error, events };
	}

	it("throws RouterError for a string result naming an unregistered node", async () => {
		const { error, events } = await rejectWith(() => "nope");

		expect(error).toBeInstanceOf(RouterError);
		const routerError = error as RouterError;
		expect(routerError.nodeId).toBe("a");
		expect(routerError.result).toBe("nope");
		// router 不是节点：不包装成 NodeExecutionError
		expect(error).not.toBeInstanceOf(NodeExecutionError);
		// 本超步已提交（superstep_committed 在路由之前），之后 run 失败且无后续超步
		expect(events.map((e) => e.type)).toEqual([
			"run_started",
			"node_started",
			"node_finished",
			"superstep_committed",
			"run_finished",
		]);
		expect(ofType(events, "run_finished")[0].status).toBe("failed");
	});

	it("throws RouterError for the START sentinel", async () => {
		const { error } = await rejectWith(() => START);

		expect(error).toBeInstanceOf(RouterError);
		expect((error as RouterError).nodeId).toBe("a");
		expect((error as RouterError).result).toBe(START);
	});

	it("throws RouterError for a Send targeting END (result = the offending Send)", async () => {
		const send = new Send(END, {});
		const { error } = await rejectWith(() => send);

		expect(error).toBeInstanceOf(RouterError);
		expect((error as RouterError).nodeId).toBe("a");
		expect((error as RouterError).result).toBe(send);
	});

	it("throws RouterError for a Send targeting an unregistered node", async () => {
		const send = new Send("ghost", {});
		const { error } = await rejectWith(() => send);

		expect(error).toBeInstanceOf(RouterError);
		expect((error as RouterError).nodeId).toBe("a");
		expect((error as RouterError).result).toBe(send);
	});

	it("throws RouterError for an offending item inside an array result (others do not run)", async () => {
		const { error, events } = await rejectWith(() => ["x", "nope"]);

		expect(error).toBeInstanceOf(RouterError);
		expect((error as RouterError).result).toBe("nope");
		// 数组前面的合法项也不放行：路由失败即整次 run 失败
		expect(ofType(events, "node_started").map((e) => e.node)).toEqual(["a"]);
	});

	it("throws RouterError (not a bare TypeError) for a result item outside the type", async () => {
		// 防御路径：TS 调用方到不了这里，JS 调用方不该拿到裸 TypeError
		const { error } = await rejectWith(() => 42);

		expect(error).toBeInstanceOf(RouterError);
		expect((error as RouterError).nodeId).toBe("a");
		expect((error as RouterError).result).toBe(42);
	});

	it("wraps a router throw in RouterError and keeps the original as cause", async () => {
		const boom = new Error("router boom");
		const { error } = await rejectWith(() => {
			throw boom;
		});

		expect(error).toBeInstanceOf(RouterError);
		const routerError = error as RouterError;
		expect(routerError.nodeId).toBe("a");
		expect(routerError.cause).toBe(boom);
		expect(routerError.message).toContain("router boom");
	});
});
