/**
 * Task 6：compile 期全量校验（设计 §6.1/§6.2/§6.3/§6.5）与封印（§6.8）。
 *
 * 契约（裁定 R4/R10/R11/R12/R13）：
 * - 错误一次聚合报完：issues 非空 → 单次 `GraphValidationError("graph invalid")`，绝不 fail-fast；
 * - 警告永不抛：挂在 `CompiledGraphData.warnings`，消息是纯文本（无 "warning:" 前缀，R12）；
 * - 只要图里有 router，可达性检查整体放弃（router/Send 目标静态不可知，宁漏勿误报，R13）；
 * - compile 成功后 builder 封印：addNode/addEdge/addConditionalEdges 抛 `GraphSealedError`。
 */

import { Type } from "typebox";
import { describe, expect, it } from "vitest";

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
	END,
	type GraphCfg,
	START,
} from "../../src/core/types.js";
import { fnNode } from "../../src/nodes/fn.js";

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
			channels: { count: (_current, update) => update },
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
		// 6 条问题：ghost 起点 / nowhere 终点 / phantom router 起点 /
		// START 无出边 / sink 缺 writeTo / writer 的 writeTo 越界
		expect(error.issues).toHaveLength(6);
		const expected = [
			'edge source "ghost" is not a registered node',
			'edge target "nowhere" (from "orphan") is not a registered node',
			'router source "phantom" is not a registered node',
			"START has no outgoing edge",
			'node "sink" (kind "llm") must declare writeTo',
			'node "writer" writeTo key "missing" is not in the state key universe',
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

	it("accepts a router registered from START (an alternative to START's out-edge)", () => {
		const graph = new StateGraph<State>()
			.addNode("a", fnNode<State>(noop))
			.addConditionalEdges(START, () => "a")
			.addEdge("a", END);

		expect(() => graph.compile()).not.toThrow();
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

			expect(error.issues).toHaveLength(1);
			expect(error.issues[0]).toContain('"summary"');
			expect(error.issues[0]).toContain(kind);
			expect(error.issues[0]).toContain("writeTo");
		}
	});

	it("accepts a writeTo key present in the channels universe", () => {
		const channels: StateSchema<State> = {
			count: (_current, update) => update,
		};
		const graph = minimal({ channels }).addNode("summary", {
			kind: "llm",
			name: "",
			handler: noop,
			writeTo: "count",
		});

		expect(() => graph.compile()).not.toThrow();
	});

	it("reports a writeTo key absent from the channels universe", () => {
		const channels: StateSchema<State> = {
			count: (_current, update) => update,
		};
		const graph = minimal({ channels }).addNode("summary", {
			kind: "llm",
			name: "",
			handler: noop,
			writeTo: "log",
		});

		const error = captureIssues(() => graph.compile());

		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]).toContain('"summary"');
		expect(error.issues[0]).toContain('"log"');
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

	it("prefers the stateSchema properties over channels when both are given", () => {
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

	it("checks the key of an fn node that declares writeTo", () => {
		const channels: StateSchema<State> = {
			count: (_current, update) => update,
		};
		const graph = minimal({ channels }).addNode("worker", {
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
			.addNode("precedent_check", {
				kind: "agent",
				name: "",
				handler: noop,
				writeTo: "log",
			})
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
		expect(data.warnings[0]).toContain('"a"');
		expect(data.warnings[0]).toContain("END");
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
