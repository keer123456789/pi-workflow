/**
 * Task 6：compile 期全量校验（设计 §6.1/§6.2/§6.3/§6.5）与封印（§6.8）。
 *
 * 契约（裁定 R4/R10/R11/R12/R13/R14/R22/R23/R24/R25）：
 * - 错误一次聚合报完：issues 非空 → 单次 `GraphValidationError("graph invalid")`，绝不 fail-fast；
 * - 警告永不抛：挂在 `CompiledGraphData.warnings`，消息是纯文本（无 "warning:" 前缀，R12）；
 * - 只要图里有 router，可达性检查整体放弃（router/Send 目标静态不可知，宁漏勿误报，R13）；
 * - writeTo 的 key 宇宙只来自 `stateSchema.properties`；channels 不是 key 全集（R14）；
 * - 哨兵位置的死边（END 源 / START 目标）与 START router 都是 compile 期错误（R22/R23）；
 * - `"__proto__"` 不得作 writeTo（R24；foldUpdates 的写入侧同样拒）；
 * - compile 成功后 builder 封印：addNode/addEdge/addConditionalEdges 抛 `GraphSealedError`。
 */

import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import {
	GraphSealedError,
	GraphValidationError,
} from "../../src/core/errors.js";
import { StateGraph } from "../../src/core/graph.js";
import { Send } from "../../src/core/send.js";
import { append, type StateSchema } from "../../src/core/state.js";
import {
	type CompiledGraph,
	type CompiledGraphData,
	type CompileOptions,
	END,
	type GraphCfg,
	type RunEvent,
	START,
} from "../../src/core/types.js";
import { agentNode } from "../../src/nodes/agent.js";
import { fnNode } from "../../src/nodes/fn.js";
import { llmNode } from "../../src/nodes/llm.js";
import type { AgentExecutor, CompleteFn } from "../../src/runtime/executor.js";
import { defaultPiAiComplete } from "../../src/runtime/llm-pi-ai.js";

type State = { count: number; log: string[] };

const noop = (_input: Readonly<State>) => ({ count: 0 });

/** compile() 产物额外携带装配好的图数据；用它观测 CompiledGraphData。 */
function dataOf(graph: StateGraph<State>): CompiledGraphData<State> {
	const compiled = graph.compile() as CompiledGraph<State> & {
		readonly data: CompiledGraphData<State>;
	};
	return compiled.data;
}

/** 捕获 compile 的校验错误（必须是 GraphValidationError）。 */
function captureIssues(fn: () => unknown): GraphValidationError {
	let thrown: unknown;
	try {
		fn();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(GraphValidationError);
	return thrown as GraphValidationError;
}

/** START → a → END 的最小合法图。 */
function minimal(cfg?: GraphCfg<State>): StateGraph<State> {
	return new StateGraph<State>(cfg)
		.addNode("a", fnNode<State>(noop))
		.addEdge(START, "a")
		.addEdge("a", END);
}

/** START → names… → END 的合法链。 */
function chained(names: string[], cfg?: GraphCfg<State>): StateGraph<State> {
	const graph = new StateGraph<State>(cfg);
	let from: string = START;
	for (const name of names) {
		graph.addNode(name, fnNode<State>(noop));
		graph.addEdge(from, name);
		from = name;
	}
	if (names.length > 0) {
		graph.addEdge(from, END);
	}
	return graph;
}

describe("compile validation: aggregation (设计 §6 一次报完)", () => {
	it("throws a single GraphValidationError carrying every problem", () => {
		const graph = new StateGraph<State>({
			name: "broken",
			// R14：writeTo 的 key 宇宙只来自 stateSchema（channels 不算）
			stateSchema: Type.Object({ count: Type.Number() }),
		})
			.addNode("orphan", fnNode<State>(noop))
			.addNode("sink", { kind: "llm", name: "", handler: noop })
			.addNode("writer", {
				kind: "agent",
				name: "",
				handler: noop,
				writeTo: "missing",
			})
			.addEdge("ghost", "orphan")
			.addEdge("orphan", "nowhere")
			.addConditionalEdges("phantom", () => END);

		const error = captureIssues(() => graph.compile());

		expect(error.message).toBe("graph invalid");
		// 7 条问题：ghost 起点 / nowhere 终点 / phantom router 起点 /
		// START 无出边 / sink 缺 writeTo / writer 的 writeTo 越界 /
		// writer（手工 agent 定义）无 executor 实现——M3/T2 D20：kind 即契约，
		// executor 不是 NodeDefinition 字段，手写 agent 定义无从声明（既有用例的
		// 计数断言随该冻结裁定同步，本任务报告已披露）。
		expect(error.issues).toHaveLength(7);
		const expected = [
			'edge source "ghost" is not a registered node',
			'edge target "nowhere" (from "orphan") is not a registered node',
			'router source "phantom" is not a registered node',
			"START has no outgoing edge",
			'node "sink" (kind "llm") must declare writeTo',
			'node "writer" writeTo key "missing" is not in the state key universe',
			'node "writer" (kind "agent") has no executor implementation',
		];
		for (const fragment of expected) {
			expect(error.issues.some((issue) => issue.includes(fragment))).toBe(true);
		}
	});

	it("keeps the builder editable after a rejected compile (no artifact to seal)", () => {
		const graph = new StateGraph<State>().addNode("a", fnNode<State>(noop));
		expect(() => graph.compile()).toThrow(GraphValidationError);

		graph.addEdge(START, "a").addEdge("a", END);

		expect(dataOf(graph).nodes.size).toBe(1);
	});
});

describe("compile validation: reference existence (设计 §6.1)", () => {
	it("reports an unregistered edge target", () => {
		const graph = minimal().addEdge("a", "ghost");

		const error = captureIssues(() => graph.compile());

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toContain('"ghost"');
	});

	it("reports an unregistered edge source", () => {
		const graph = minimal().addEdge("ghost", "a");

		const error = captureIssues(() => graph.compile());

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toContain('edge source "ghost"');
	});

	it("reports an unregistered source of an END edge (R2)", () => {
		// END 边不在 plainEdges 里，只登记在 endEdgeSources——漏扫它会放过这类悬空引用
		const graph = new StateGraph<State>()
			.addNode("load_doc", fnNode<State>(noop))
			.addEdge(START, "load_doc")
			.addEdge("load_doc", END)
			.addEdge("load_docs", END);

		const error = captureIssues(() => graph.compile());

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toContain('edge source "load_docs"');
	});

	it("reports an unregistered router source", () => {
		const graph = minimal().addConditionalEdges("ghost", () => END);

		const error = captureIssues(() => graph.compile());

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toContain('router source "ghost"');
	});

	it("reports a router whose source is END (not a node)", () => {
		const graph = minimal().addConditionalEdges(END, () => END);

		const error = captureIssues(() => graph.compile());

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toContain("router source");
	});

	it("reports a router registered from START (never evaluated in M1, R22)", () => {
		const graph = new StateGraph<State>()
			.addNode("a", fnNode<State>(noop))
			.addConditionalEdges(START, () => "a")
			.addEdge("a", END);

		const error = captureIssues(() => graph.compile());
		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toContain('router source "START" is not allowed');
	});

	it("reports exactly one issue when START has both a plain edge and a router (R22)", () => {
		// router 已单报 R22 错误：START 出边判定不再叠加第二条（routers.has(START) 仍计入）
		const graph = minimal().addConditionalEdges(START, () => "a");

		const error = captureIssues(() => graph.compile());

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toContain('router source "START" is not allowed');
	});

	it("accepts references registered after the edge/router (order is irrelevant)", () => {
		const graph = new StateGraph<State>()
			.addEdge("a", "b")
			.addConditionalEdges("b", () => END)
			.addEdge(START, "a")
			.addNode("a", fnNode<State>(noop))
			.addNode("b", fnNode<State>(noop));

		expect(dataOf(graph).nodes.size).toBe(2);
	});
});

describe("compile validation: sentinel positions (设计 §6.1, R23)", () => {
	it("reports an edge from END (the exit sentinel has no instances)", () => {
		const graph = minimal().addEdge(END, "a");

		const error = captureIssues(() => graph.compile());

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toBe(
			'edge source "END" is the exit sentinel and cannot have outgoing edges',
		);
	});

	it("reports an END → END edge through the endEdgeSources path (R23)", () => {
		const graph = minimal().addEdge(END, END);

		const error = captureIssues(() => graph.compile());

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toBe(
			'edge source "END" is the exit sentinel and cannot have outgoing edges',
		);
	});

	it("reports an edge targeting START (the entry sentinel is not a node)", () => {
		const graph = minimal().addEdge("a", START);

		const error = captureIssues(() => graph.compile());

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toBe(
			'edge target "START" (from "a") is the entry sentinel and cannot be an edge target',
		);
	});

	it("reports a START → START self-edge (R23)", () => {
		const graph = minimal().addEdge(START, START);

		const error = captureIssues(() => graph.compile());

		expect(error.issues).toHaveLength(1);
		// 消息里的目标名固定显示为 "START"；`from` 是 map 键原值（START 的内部键 "__start__"）
		expect(error.issues[0]).toBe(
			`edge target "START" (from "${START}") is the entry sentinel and cannot be an edge target`,
		);
	});
});

describe("compile validation: unregistered-source dedup (Minor 6/R25)", () => {
	it("reports one issue when a source has both a plain edge and an END edge", () => {
		// plainEdges 循环报过的未注册源记入集合，endEdgeSources 循环跳过——只报 1 条
		const graph = minimal().addEdge("ghost", "a").addEdge("ghost", END);

		const error = captureIssues(() => graph.compile());

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toContain('edge source "ghost"');
	});
});

describe("compile validation: START out-edge (设计 §6.2)", () => {
	it("reports START with no outgoing edge", () => {
		const graph = new StateGraph<State>()
			.addNode("a", fnNode<State>(noop))
			.addEdge("a", END);

		const error = captureIssues(() => graph.compile());

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toContain("START");
		expect(error.issues[0]).toContain("outgoing");
	});

	it("counts an explicit START → END edge as an out-edge (not an error)", () => {
		const graph = new StateGraph<State>().addEdge(START, END);

		expect(dataOf(graph).warnings).toEqual([]);
	});

	it("counts a plain edge from START to a registered node as an out-edge", () => {
		expect(() => minimal().compile()).not.toThrow();
	});
});

describe("compile validation: writeTo (设计 §6.5)", () => {
	it("reports a non-fn node that does not declare writeTo", () => {
		for (const kind of ["llm", "agent"] as const) {
			const graph = minimal().addNode("summary", {
				kind,
				name: "",
				handler: noop,
			});

			const error = captureIssues(() => graph.compile());

			// M3/T2（D20）：手工 agent 定义额外报 "has no executor implementation"
			//（executor 不是 NodeDefinition 字段，手写定义无从声明）——llm 1 条、agent 2 条。
			expect(error.issues).toHaveLength(kind === "agent" ? 2 : 1);
			expect(error.issues[0]).toContain('"summary"');
			expect(error.issues[0]).toContain(kind);
			expect(error.issues[0]).toContain("writeTo");
			if (kind === "agent") {
				expect(error.issues[1]).toContain("has no executor implementation");
			}
		}
	});

	it("never uses channels as the writeTo key universe (R14)", () => {
		// channels 只列"有自定义 reducer"的 key，不是 State key 全集：无 reducer 的 key
		// 合法可写（§5.1 直接写入）——channels-only 时宇宙未知，一律跳过校验。
		const channels: StateSchema<State> = { log: append };
		for (const writeTo of ["count", "log"]) {
			const graph = minimal({ channels }).addNode("summary", {
				kind: "llm",
				name: "",
				handler: noop,
				writeTo,
			});

			expect(() => graph.compile()).not.toThrow();
		}
	});

	it("accepts a writeTo key present in the stateSchema properties", () => {
		const stateSchema = Type.Object({
			count: Type.Number(),
			log: Type.Array(Type.String()),
		});
		const graph = minimal({ stateSchema }).addNode("summary", {
			kind: "llm",
			name: "",
			handler: noop,
			writeTo: "log",
		});

		expect(() => graph.compile()).not.toThrow();
	});

	it("reports a writeTo key absent from the stateSchema properties", () => {
		const stateSchema = Type.Object({ count: Type.Number() });
		const graph = minimal({ stateSchema }).addNode("summary", {
			kind: "llm",
			name: "",
			handler: noop,
			writeTo: "nope",
		});

		const error = captureIssues(() => graph.compile());

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toContain('"nope"');
	});

	it('reports writeTo "__proto__" as forbidden, without a second universe issue (R24)', () => {
		// R24：__proto__ 是原型污染面（foldUpdates 写入侧同样拒）；此处单独报并
		// 跳过宇宙校验——恰好 1 条，不是 2 条
		const stateSchema = Type.Object({ count: Type.Number() });
		const graph = minimal({ stateSchema }).addNode("summary", {
			kind: "llm",
			name: "",
			handler: noop,
			writeTo: "__proto__",
		});

		const error = captureIssues(() => graph.compile());

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toBe(
			'node "summary" writeTo key "__proto__" is forbidden',
		);
	});

	it("uses the stateSchema universe even when channels list other keys (R14)", () => {
		const channels: StateSchema<State> = { log: (_current, update) => update };
		const stateSchema = Type.Object({ count: Type.Number() });
		const graph = minimal({ channels, stateSchema }).addNode("summary", {
			kind: "llm",
			name: "",
			handler: noop,
			writeTo: "log",
		});

		const error = captureIssues(() => graph.compile());

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toContain('"log"');
	});

	it("skips the writeTo key check when neither channels nor stateSchema is given", () => {
		const graph = minimal().addNode("summary", {
			kind: "llm",
			name: "",
			handler: noop,
			writeTo: "anything",
		});

		// 宇宙未知：宁可漏报，不可误报
		expect(() => graph.compile()).not.toThrow();
	});

	it("skips the writeTo key check when channels default to an empty schema", () => {
		const graph = minimal({ channels: {} }).addNode("summary", {
			kind: "llm",
			name: "",
			handler: noop,
			writeTo: "anything",
		});

		expect(() => graph.compile()).not.toThrow();
	});

	it("skips the writeTo key check when only channels are given (R14)", () => {
		// channels: { log } 而 writeTo: "count"——count 无自定义 reducer，合法（§5.1）
		const channels: StateSchema<State> = { log: append };
		const graph = minimal({ channels }).addNode("summary", {
			kind: "llm",
			name: "",
			handler: noop,
			writeTo: "count",
		});

		expect(() => graph.compile()).not.toThrow();
	});

	it("treats a null stateSchema as an unknown universe (R2)", () => {
		// 未经检查的 JS 调用方：不能从 compile 里抛裸 TypeError
		const cfg = { stateSchema: null } as unknown as GraphCfg<State>;
		const graph = minimal(cfg).addNode("summary", {
			kind: "llm",
			name: "",
			handler: noop,
			writeTo: "anything",
		});

		expect(() => graph.compile()).not.toThrow();
	});

	it("checks the key of an fn node that declares writeTo", () => {
		const stateSchema = Type.Object({ count: Type.Number() });
		const graph = minimal({ stateSchema }).addNode("worker", {
			kind: "fn",
			name: "",
			handler: noop,
			writeTo: "log",
		});

		const error = captureIssues(() => graph.compile());

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toContain('"worker"');
		expect(error.issues[0]).toContain('"log"');
	});
});

describe("compile warnings: unreachable nodes (设计 §6.2, R13)", () => {
	it("warns for each node unreachable from START in a router-free graph", () => {
		const graph = new StateGraph<State>()
			.addNode("a", fnNode<State>(noop))
			.addNode("b", fnNode<State>(noop))
			.addNode("orphan", fnNode<State>(noop))
			.addNode("orphan2", fnNode<State>(noop))
			.addEdge(START, "a")
			.addEdge("a", "b")
			.addEdge("b", END)
			.addEdge("orphan", "orphan2")
			.addEdge("orphan2", END);

		const data = dataOf(graph);

		expect(data.warnings).toHaveLength(2);
		// 逐字固定一条警告（R12：纯文本，无 "warning:" 前缀等任何前缀）
		expect(data.warnings).toContain(
			'node "orphan" is not reachable from START',
		);
		for (const name of ["orphan", "orphan2"]) {
			expect(data.warnings.some((w) => w.includes(`"${name}"`))).toBe(true);
		}
	});

	it("does not warn when every node is reachable from START", () => {
		expect(dataOf(chained(["a", "b", "c"])).warnings).toEqual([]);
	});

	it("suppresses the whole unreachable check when the graph has any router (R13)", () => {
		// 设计 §4.2 旗舰示例骨架：extract / gate 的 router 以 Send 动态扇出到
		// review / precedent_check——router/Send 目标静态不可知，有 router 就放弃可达性检查。
		// 只给 channels（不给 stateSchema）：writeTo 的 key 校验随之跳过（R14），图的合法性不依赖它。
		const channels: StateSchema<State> = { log: append };
		const graph = new StateGraph<State>({ name: "legal-review", channels })
			.addNode("load_doc", fnNode<State>(noop))
			.addNode("extract", fnNode<State>(noop))
			.addNode("review", {
				kind: "llm",
				name: "",
				handler: noop,
				writeTo: "log",
			})
			.addNode("gate", fnNode<State>(noop))
			// M3/T2（D20）：手工 agent 定义在 compile 期报 "has no executor implementation"
			//（kind 即契约）——fixture 改用 agentNode 工厂产物（自定义 executor 免配置），
			// 本用例断言的 R13 语义（有 router 即放弃可达性检查）不变。
			.addNode(
				"precedent_check",
				agentNode<State, "log">({
					task: "precedent",
					writeTo: "log",
					executor: async () => ({ output: "[]" }),
				}),
			)
			.addNode("aggregate", {
				kind: "llm",
				name: "",
				handler: noop,
				writeTo: "log",
			})
			.addEdge(START, "load_doc")
			.addEdge("load_doc", "extract")
			.addConditionalEdges("extract", (state) =>
				state.log.map((clause) => new Send("review", { clause })),
			)
			.addEdge("review", "gate")
			.addConditionalEdges("gate", (state) =>
				state.log.length > 0
					? state.log.map((clause) => new Send("precedent_check", { clause }))
					: "aggregate",
			)
			.addEdge("precedent_check", "aggregate")
			.addEdge("aggregate", END);

		expect(dataOf(graph).warnings).toEqual([]);
	});
});

describe("compile warnings: terminal nodes (设计 §6.3)", () => {
	it("warns for a node with neither an out-edge nor a router", () => {
		const graph = new StateGraph<State>()
			.addNode("a", fnNode<State>(noop))
			.addEdge(START, "a");

		const data = dataOf(graph);

		expect(data.warnings).toHaveLength(1);
		// 逐字固定终态警告文案（R12：无 "warning:" 前缀）
		expect(data.warnings[0]).toBe(
			'node "a" has no outgoing edge and no router: it is a terminal state — connect it to END explicitly with addEdge("a", END)',
		);
	});

	it("does not warn for a node explicitly wired to END", () => {
		expect(dataOf(minimal()).warnings).toEqual([]);
	});

	it("does not warn for a node that has a router", () => {
		const graph = minimal().addConditionalEdges("a", () => END);

		expect(dataOf(graph).warnings).toEqual([]);
	});

	it("reports both facts for a node that is terminal AND unreachable", () => {
		const graph = minimal().addNode("orphan", fnNode<State>(noop));

		const data = dataOf(graph);

		expect(data.warnings).toHaveLength(2);
		expect(data.warnings.some((w) => w.includes("not reachable"))).toBe(true);
		expect(data.warnings.some((w) => w.includes("terminal"))).toBe(true);
	});

	it("never throws when warnings are the only complaints (R4)", () => {
		const graph = minimal().addNode("orphan", fnNode<State>(noop));

		expect(() => graph.compile()).not.toThrow();
		expect(dataOf(graph).warnings).not.toEqual([]);
	});
});

describe("graph sealing (设计 §6.8)", () => {
	it("throws GraphSealedError from every addXxx after compile", () => {
		const graph = minimal();
		graph.compile();

		expect(() => graph.addNode("b", fnNode<State>(noop))).toThrow(
			GraphSealedError,
		);
		expect(() => graph.addEdge("a", "b")).toThrow(GraphSealedError);
		expect(() => graph.addConditionalEdges("a", () => END)).toThrow(
			GraphSealedError,
		);
	});

	it("seals before any add-time validation runs", () => {
		const graph = minimal();
		graph.compile();

		// 保留名本会抛 GraphValidationError；封印检查在一切校验之前
		let thrown: unknown;
		try {
			graph.addNode("START", fnNode<State>(noop));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(GraphSealedError);
		expect(thrown).not.toBeInstanceOf(GraphValidationError);
	});

	it("names the sealed method in the error message", () => {
		const graph = minimal();
		graph.compile();

		expect(() => graph.addEdge("a", "b")).toThrow(/addEdge/);
	});
});

describe("compile decoupling (R11)", () => {
	it("copies channels so mutating the caller's object cannot leak in", () => {
		const channels: StateSchema<State> = {
			count: (_current, update) => update,
		};
		const graph = minimal({ name: "flow", channels });
		const data = dataOf(graph);
		const original = channels.count;

		expect(data.channels).not.toBe(channels);
		channels.count = () => 42;

		expect(data.channels.count).toBe(original);
		expect(data.warnings).toEqual([]);
	});

	it("keeps stateSchema by reference without freezing caller objects", () => {
		const stateSchema = Type.Object({
			count: Type.Number(),
			log: Type.Array(Type.String()),
		});
		const channels: StateSchema<State> = {
			count: (_current, update) => update,
		};
		const graph = minimal({ name: "flow", channels, stateSchema });
		const data = dataOf(graph);

		expect(data.stateSchema).toBe(stateSchema);
		expect(Object.isFrozen(stateSchema)).toBe(false);
		expect(Object.isFrozen(channels)).toBe(false);
		expect(Object.isFrozen(data)).toBe(false);
		expect(Object.isFrozen(data.channels)).toBe(false);
	});
});

describe("sentinel node names (R10)", () => {
	it("rejects the sentinel literals with a single-issue GraphValidationError", () => {
		const graph = new StateGraph<State>();

		for (const name of [START, END, "START", "END"]) {
			let thrown: unknown;
			try {
				graph.addNode(name, fnNode<State>(noop));
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(GraphValidationError);
			const error = thrown as GraphValidationError;
			expect(error.issues).toHaveLength(1);
			expect(error.issues[0]).toContain(name);
		}

		// 被拒的注册不留痕：补一个合法节点后仍能编译
		graph
			.addNode("a", fnNode<State>(noop))
			.addEdge(START, "a")
			.addEdge("a", END);
		expect(dataOf(graph).nodes.size).toBe(1);
	});
});

describe("compile: valid graphs (name precedence)", () => {
	it("does not throw and applies opts.name ?? cfg.name ?? 'graph'", () => {
		const bare = chained(["a"]);
		expect(bare.compile().name).toBe("graph");

		const named = chained(["a"], { name: "cfg" });
		expect(named.compile().name).toBe("cfg");
		expect(named.compile({ name: "opts" }).name).toBe("opts");
	});
});

// ---------------------------------------------------------------------------
// Task 8：compile 期补全解析与绑定（§6.6/D12）
//
// 可用性由 `vi.mock("../../src/runtime/llm-pi-ai.js")` 控制（T7 review 要求在本任务覆盖
// "对等依赖未安装"的 false 路径）：mock 默认 available = true，与"pi-ai 真的装在
// devDependencies 里"的真实探测一致——本文件此前的用例行为不变；不可用路径逐例显式置
// false 并在 finally 复位。
// ---------------------------------------------------------------------------

/** 假 llm-pi-ai 模块的状态（vi.hoisted：mock 工厂先于 import 执行，必须同层提前建好）。 */
const piAi = vi.hoisted(() => ({
	available: true,
	probes: 0,
	defaultComplete: undefined as CompleteFn | undefined,
}));

vi.mock("../../src/runtime/llm-pi-ai.js", () => ({
	isPiAiAvailable: () => {
		piAi.probes += 1;
		return piAi.available;
	},
	// 懒建 + 单例（与真模块同形）：同一份实例既用于绑定，也供用例做身份断言。
	defaultPiAiComplete: () =>
		(piAi.defaultComplete ??= async () => ({ text: '["pi-ai"]' })),
}));

/** llm 节点声明的产出 schema（数组——写往 State.log，真跑时与 state 形状一致）。 */
const draftSchema = Type.Array(Type.String());

/** 记录每次调用的 prompt、返回固定文本的 fake complete。 */
function fakeComplete(text: string): { complete: CompleteFn; calls: string[] } {
	const calls: string[] = [];
	const complete: CompleteFn = async (req) => {
		calls.push(req.prompt);
		return { text };
	};
	return { complete, calls };
}

/** 单个 llm 节点（draft → log）的最小合法图；`complete` 缺省 = 交给 compile 解析。 */
function llmGraph(complete?: CompleteFn): StateGraph<State> {
	return new StateGraph<State>()
		.addNode(
			"draft",
			llmNode<State, "log">({
				prompt: "draft {count}",
				schema: draftSchema,
				writeTo: "log",
				complete,
			}),
		)
		.addEdge(START, "draft")
		.addEdge("draft", END);
}

/** compile（可带选项）并交出图数据（既有 dataOf 只支持无参 compile）。 */
function dataWithOptions(
	graph: StateGraph<State>,
	options?: CompileOptions,
): CompiledGraphData<State> {
	const compiled = graph.compile(options) as CompiledGraph<State> & {
		readonly data: CompiledGraphData<State>;
	};
	return compiled.data;
}

/** 在"pi-ai 不可用"下跑一段同步断言（finally 复位：探测状态不跨用例泄漏）。 */
function asUnavailable(fn: () => void): void {
	piAi.available = false;
	try {
		fn();
	} finally {
		piAi.available = true;
	}
}

describe("compile: llm completion resolution (§6.6/D12, Task 8)", () => {
	it("reports an llm node with no completion implementation when pi-ai is unavailable", () => {
		asUnavailable(() => {
			const error = captureIssues(() => llmGraph().compile());

			// 硬错误（GraphValidationError）而非运行期爆炸——issues 恰 1 条
			expect(error.issues).toHaveLength(1);
			expect(error.issues[0]).toContain(
				'node "draft" (kind "llm") has no completion implementation',
			);
			// 消息可行动（T7 review）：三条出路都在
			expect(error.issues[0]).toContain("services.complete");
			expect(error.issues[0]).toContain("npm i @earendil-works/pi-ai");
		});
	});

	it("accepts an llm node when services.complete is provided (pi-ai unavailable)", () => {
		const { complete } = fakeComplete('["services"]');

		asUnavailable(() => {
			const data = dataWithOptions(llmGraph(), { services: { complete } });

			// 解析结果落进图数据的定义副本（D12 的绑定口径）
			expect(data.nodes.get("draft")?.complete).toBe(complete);
		});
	});

	it("accepts an llm node when node-level complete is provided, without probing pi-ai", () => {
		const { complete } = fakeComplete('["node"]');
		piAi.probes = 0;

		asUnavailable(() => {
			const data = dataWithOptions(llmGraph(complete));

			expect(data.nodes.get("draft")?.complete).toBe(complete);
			// 探测闸门（D12）：每个 llm 节点都有显式 complete → 完全不问 pi-ai
			expect(piAi.probes).toBe(0);
		});
	});

	it("prefers node complete over services.complete (call log assertion)", async () => {
		const node = fakeComplete('["node"]');
		const services = fakeComplete('["services"]');
		// 连 pi-ai 都没有：三级解析仍以最前的节点级为胜
		piAi.available = false;
		try {
			const compiled = llmGraph(node.complete).compile({
				services: { complete: services.complete },
			});
			const { state } = await compiled.run({ count: 2, log: [] });

			// 真跑一遍：只有节点级 complete 被调用（prompt 插值 + writeTo 包装都走通）
			expect(node.calls).toEqual(["draft 2"]);
			expect(services.calls).toEqual([]);
			expect(state.log).toEqual(["node"]);
		} finally {
			piAi.available = true;
		}
	});

	it("reports a non-llm node that declares complete", () => {
		const { complete } = fakeComplete("[]");

		const error = captureIssues(() =>
			minimal()
				.addNode("worker", { kind: "fn", name: "", handler: noop, complete })
				.compile(),
		);

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toBe(
			'node "worker" (kind "fn") must not declare complete: it is only supported on kind "llm" nodes',
		);
	});

	it("collects completion issues alongside earlier checks in one GraphValidationError", () => {
		const { complete } = fakeComplete("[]");

		asUnavailable(() => {
			const graph = llmGraph().addNode("worker", {
				kind: "fn",
				name: "",
				handler: noop,
				complete,
			});

			const error = captureIssues(() => graph.compile());

			// 全量收集（§6）：新检查不 fail-fast，与既有检查同批报出
			expect(error.message).toBe("graph invalid");
			expect(error.issues).toHaveLength(2);
			expect(
				error.issues.some((issue) =>
					issue.includes(
						'node "draft" (kind "llm") has no completion implementation',
					),
				),
			).toBe(true);
			expect(
				error.issues.some((issue) =>
					issue.includes('node "worker" (kind "fn") must not declare complete'),
				),
			).toBe(true);
		});
	});

	it("probes pi-ai once per compile even when several llm nodes lack a completion", () => {
		piAi.probes = 0;

		asUnavailable(() => {
			const graph = llmGraph().addNode(
				"draft2",
				llmNode<State, "log">({
					prompt: "again {count}",
					schema: draftSchema,
					writeTo: "log",
				}),
			);

			const error = captureIssues(() => graph.compile());

			// 两个缺补全的 llm 节点各报一条（全量收集，注册序）
			expect(error.issues).toHaveLength(2);
			expect(error.issues[0]).toContain(
				'node "draft" (kind "llm") has no completion implementation',
			);
			expect(error.issues[1]).toContain(
				'node "draft2" (kind "llm") has no completion implementation',
			);
			// 探测闸门：整个 compile 只探一次（探测结果在本次解析里复用，
			// "每个节点各探一次"的坏实现在这里挂）
			expect(piAi.probes).toBe(1);
		});
	});

	it("binds the pi-ai default when available and no complete is provided", async () => {
		// 可用（mock 的默认值）：默认实现的注入点就是 mock 的 defaultPiAiComplete
		const compiled = llmGraph().compile();

		const bound = (
			compiled as CompiledGraph<State> & {
				readonly data: CompiledGraphData<State>;
			}
		).data.nodes.get("draft");
		expect(bound?.complete).toBe(defaultPiAiComplete());

		const events: RunEvent[] = [];
		const { state } = await compiled.run(
			{ count: 0, log: [] },
			{ onEvent: (event) => events.push(event) },
		);

		// 默认实现（fake）真的被调用：解析值经引擎 writeTo 包装落进 state
		expect(state.log).toEqual(["pi-ai"]);
		const finished = events.filter((event) => event.type === "node_finished");
		expect(finished).toHaveLength(1);
		expect(finished[0]).toMatchObject({
			node: "draft",
			instanceId: "draft#1",
			output: ["pi-ai"],
		});
	});
});

// ---------------------------------------------------------------------------
// M3/T2：compile 期 agent executor 解析与绑定（§4.6/D20）
//
// 解析是同步纯查表（D20——compile 无探测/无 spawn；版本探测归适配器，D18）。
// "subprocess" 的 spawn 适配器在 resolveAgentExecutors 接线（配置存在即合法，空对象
// {} 合法）；"sdk" 在 M4 前报占位 issue——M4/T3 已将该占位退役并接线（D20 演进），
// sdk 分支的现行行为见下方 "M4/T3" 用例组（预裁定例外 1 的既有断言更新）。
// ---------------------------------------------------------------------------

/** agent 节点声明的产出 schema（数组——写往 State.log，与 state 形状一致）。 */
const agentListSchema = Type.Array(Type.String());

/** 单个 agent 节点（check → log）的最小合法图；executor 按用例给声明形态。 */
function agentGraph(
	executor: "subprocess" | "sdk" | AgentExecutor,
): StateGraph<State> {
	return new StateGraph<State>()
		.addNode(
			"check",
			agentNode<State, "log">({
				task: "check {count}",
				schema: agentListSchema,
				writeTo: "log",
				executor,
			}),
		)
		.addEdge(START, "check")
		.addEdge("check", END);
}

describe("compile: agent executor resolution (§4.6/D20, M3/T2)", () => {
	it("reports a hand-written agent definition that declares complete (R1: falls through to the shared check, §4.3)", () => {
		const { complete } = fakeComplete("[]");

		const error = captureIssues(() =>
			minimal()
				.addNode("writer", {
					kind: "agent",
					name: "",
					handler: noop,
					writeTo: "log",
					complete,
				})
				.compile(),
		);

		// 全量收集（§6）：手工 agent 定义无从声明 executor（D20），executor issue
		// 照旧报；complete 声明再追加一条——两条同批，不互斥（R1 前 complete 被
		// agent 分支的 continue 静默吞掉）。
		expect(error.issues).toHaveLength(2);
		expect(error.issues[0]).toContain(
			'node "writer" (kind "agent") has no executor implementation',
		);
		// 消息逐字 = 既有 llm/fn 分支的同款模板（§4.3：complete 是 llm 专用）。
		expect(error.issues[1]).toBe(
			'node "writer" (kind "agent") must not declare complete: it is only supported on kind "llm" nodes',
		);
	});

	it("reports a hand-written agent definition (executor is not a NodeDefinition field, so there is no way to declare one)", () => {
		const error = captureIssues(() =>
			minimal()
				.addNode("writer", {
					kind: "agent",
					name: "",
					handler: noop,
					writeTo: "log",
				})
				.compile(),
		);

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toBe(
			'node "writer" (kind "agent") has no executor implementation: pass executor: "subprocess" with services.agent.subprocess configured, or a custom AgentExecutor function to agentNode',
		);
	});

	it('reports executor "sdk" without services.agent.sdk (D20 evolution: M4/T3 retires the placeholder)', () => {
		const error = captureIssues(() => agentGraph("sdk").compile());

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toBe(
			'node "check" (kind "agent") declares executor "sdk" but services.agent.sdk is not configured (an empty object {} is enough to accept defaults)',
		);
	});

	it('reports executor "subprocess" without services.agent.subprocess', () => {
		const error = captureIssues(() => agentGraph("subprocess").compile());

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toBe(
			'node "check" (kind "agent") declares executor "subprocess" but services.agent.subprocess is not configured (an empty object {} is enough to accept defaults)',
		);
	});

	it('accepts executor "subprocess" with an empty {} config (every field defaults, D20)', () => {
		// 空对象 {} 合法：compile 只校验配置存在（D18 同步、无探测）；handler 的真实
		// 绑定（spawn 适配器）归 Task 3——本任务不跑它，只认 compile 通过且无 issue。
		const data = dataWithOptions(agentGraph("subprocess"), {
			services: { agent: { subprocess: {} } },
		});

		expect(data.nodes.get("check")?.kind).toBe("agent");
	});

	it("binds a custom executor function without any services config and runs it (D20)", async () => {
		const calls: string[] = [];
		const compiled = agentGraph(async (req) => {
			calls.push(req.task);
			return { output: '["agent"]' };
		}).compile();

		const { state } = await compiled.run({ count: 3, log: [] });

		// task 插值 + schema 指令拼在插值之后（D22）；解析值经 writeTo 落 state。
		expect(calls).toHaveLength(1);
		expect(calls[0].startsWith("check 3")).toBe(true);
		expect(calls[0]).toContain("输出约束");
		expect(state.log).toEqual(["agent"]);
	});
});

// ---------------------------------------------------------------------------
// M4/T3："sdk" 分支接线（D20 演进）
//
// 可用性由 `vi.mock("../../src/runtime/pi-sdk.js")` 控制（文件级 mock：graph.ts 对
// pi-sdk 的运行期 import 全部落进 fake——上方 llm-pi-ai mock 的同款姿态）。检查顺序
// 冻结（计划 T3 Step 1）：**先配置后可用性**——services.agent.sdk 缺省 → "未配置"
// issue（不探测）；配置在但 @earendil-works/pi-coding-agent 不可用 → "未安装" issue；
// 两关都过 → createPiSdkExecutor(config) 放行绑定。compile 不调用 executor——mock 的
// 可辨识假函数即可（真实执行路径归 tests/runtime/pi-sdk.test.ts 的 fake SDK）。
// ---------------------------------------------------------------------------

/** 假 pi-sdk 模块的状态（vi.hoisted：mock 工厂先于 import 执行，必须同层提前建好）。 */
const piSdk = vi.hoisted(() => ({
	available: true,
	probes: 0,
	createCalls: [] as unknown[],
}));

vi.mock("../../src/runtime/pi-sdk.js", () => ({
	isPiSdkAvailable: () => {
		piSdk.probes += 1;
		return piSdk.available;
	},
	// 与真工厂同形：只闭包配置（记录调用供接线断言），不执行任何进程动作。
	createPiSdkExecutor: (config: unknown) => {
		piSdk.createCalls.push(config);
		return async () => ({ output: "sdk-fake" });
	},
}));

/** 单个 sdk agent 节点（writer → log）的最小合法图（节点名 = 计划 T3 消息模板的 "writer"）。 */
function sdkAgentGraph(): StateGraph<State> {
	return new StateGraph<State>()
		.addNode(
			"writer",
			agentNode<State, "log">({
				task: "check {count}",
				schema: agentListSchema,
				writeTo: "log",
				executor: "sdk",
			}),
		)
		.addEdge(START, "writer")
		.addEdge("writer", END);
}

describe("compile: agent executor resolution — sdk branch (D20 evolution, M4/T3)", () => {
	it('reports executor "sdk" without services.agent.sdk, without probing availability (config check is first)', () => {
		piSdk.probes = 0;

		const error = captureIssues(() => sdkAgentGraph().compile());

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toBe(
			'node "writer" (kind "agent") declares executor "sdk" but services.agent.sdk is not configured (an empty object {} is enough to accept defaults)',
		);
		// 先配置后可用性（冻结顺序）：配置缺省即报，可用性探测一次都不发生。
		expect(piSdk.probes).toBe(0);
	});

	it('accepts executor "sdk" with an empty {} config when the peer package is available (bound, never run)', () => {
		piSdk.available = true;
		piSdk.createCalls.length = 0;

		const data = dataWithOptions(sdkAgentGraph(), {
			services: { agent: { sdk: {} } },
		});

		// compile 过、无 issue（不 run）：接线以配置调用工厂（空对象 {} 原样透传），
		// executor 只绑定不执行。
		expect(piSdk.createCalls).toEqual([{}]);
		expect(data.nodes.get("writer")?.kind).toBe("agent");
	});

	it('reports executor "sdk" when the peer package is unavailable although the config is present', () => {
		piSdk.available = false;
		try {
			const error = captureIssues(() =>
				sdkAgentGraph().compile({ services: { agent: { sdk: {} } } }),
			);

			expect(error.issues).toHaveLength(1);
			expect(error.issues[0]).toBe(
				'node "writer" (kind "agent") declares executor "sdk" but @earendil-works/pi-coding-agent is not installed — install it (npm i @earendil-works/pi-coding-agent) to use the sdk executor',
			);
		} finally {
			piSdk.available = true; // 探测状态不跨用例泄漏（asUnavailable 同款纪律）
		}
	});
});
