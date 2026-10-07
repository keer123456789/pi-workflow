import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { GraphValidationError } from "../../src/core/errors.js";
import { StateGraph } from "../../src/core/graph.js";
import type { StateSchema } from "../../src/core/state.js";
import {
	type CompiledGraph,
	type CompiledGraphData,
	END,
	type GraphCfg,
	type NodeDefinition,
	START,
} from "../../src/core/types.js";
import { fnNode } from "../../src/nodes/fn.js";

type State = { count: number; log: string[] };

const noopHandler = (input: Readonly<State>) => ({ count: input.count });

/** 注册若干 fn 节点并串成 START → n1 → … → END 的合法图（供观测 compile 数据）。 */
function chainedGraph(
	names: string[],
	cfg?: GraphCfg<State>,
): StateGraph<State> {
	const graph = new StateGraph<State>(cfg);
	let from: string = START;
	for (const name of names) {
		graph.addNode(name, fnNode<State>(noopHandler));
		graph.addEdge(from, name);
		from = name;
	}
	if (names.length > 0) {
		graph.addEdge(from, END);
	}
	return graph;
}

/** compile() 产物额外携带装配好的图数据；用它观测 CompiledGraphData。 */
function dataOf(graph: StateGraph<State>): CompiledGraphData<State> {
	const compiled = graph.compile() as CompiledGraph<State> & {
		readonly data: CompiledGraphData<State>;
	};
	return compiled.data;
}

/** 捕获 addXxx 的即时校验错误：必须是 GraphValidationError 且恰好一条 issue。 */
function captureSingleIssue(fn: () => unknown): GraphValidationError {
	let thrown: unknown;
	try {
		fn();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(GraphValidationError);
	const error = thrown as GraphValidationError;
	expect(error.issues).toHaveLength(1);
	return error;
}

describe("START / END sentinels", () => {
	it("are the reserved sentinel strings", () => {
		expect(START).toBe("__start__");
		expect(END).toBe("__end__");
	});
});

describe("fluent API", () => {
	it("returns the same instance from addNode / addEdge / addConditionalEdges", () => {
		const graph = new StateGraph<State>();

		expect(graph.addNode("a", fnNode<State>(noopHandler))).toBe(graph);
		expect(graph.addEdge(START, "a")).toBe(graph);
		expect(graph.addEdge("a", END)).toBe(graph);
		expect(graph.addConditionalEdges("a", () => END)).toBe(graph);
	});

	it("chains typed as StateGraph<S> across calls", () => {
		const chained: StateGraph<State> = new StateGraph<State>({ name: "flow" })
			.addNode("a", fnNode<State>(noopHandler))
			.addEdge(START, "a")
			.addEdge("a", END);

		expect(chained).toBeInstanceOf(StateGraph);
	});

	it("types addNode's input generic independently of the graph state", () => {
		const graph = new StateGraph<State>()
			.addNode<{ task: string }>(
				"worker",
				fnNode<State, { task: string }>((input) => ({ log: [input.task] })),
			)
			.addEdge(START, "worker")
			.addEdge("worker", END);

		expect(dataOf(graph).nodes.get("worker")?.kind).toBe("fn");
	});
});

describe("immediate validation (throws inside addNode)", () => {
	it("throws GraphValidationError with a single issue on a duplicate node name", () => {
		const graph = chainedGraph(["a"]);

		const error = captureSingleIssue(() =>
			graph.addNode("a", fnNode<State>(noopHandler)),
		);

		expect(error.issues[0]).toContain('"a"');
		expect(dataOf(graph).nodes.size).toBe(1);
	});

	it('throws on the reserved node names "START" and "END"', () => {
		for (const name of ["START", "END"]) {
			const graph = new StateGraph<State>();
			const error = captureSingleIssue(() =>
				graph.addNode(name, fnNode<State>(noopHandler)),
			);
			expect(error.issues[0]).toContain(name);
		}
	});

	it("accepts node names that only look like sentinels (e.g. START-ish)", () => {
		const graph = new StateGraph<State>();

		expect(() =>
			graph.addNode(`${START}x`, fnNode<State>(noopHandler)),
		).not.toThrow();
	});
});

describe("immediate validation (throws inside addEdge)", () => {
	it("throws on a duplicated edge (same from → same to)", () => {
		const graph = chainedGraph(["a", "b"]);

		const error = captureSingleIssue(() => graph.addEdge("a", "b"));

		expect(error.issues[0]).toContain('"a"');
		expect(error.issues[0]).toContain('"b"');
		expect(dataOf(graph).plainEdges.get("a")).toEqual(["b"]);
	});

	it("allows a second edge from the same from to a different target (ordered target list)", () => {
		const graph = chainedGraph(["a", "b", "c"]);

		expect(() => graph.addEdge("a", "c")).not.toThrow();
		expect(dataOf(graph).plainEdges.get("a")).toEqual(["b", "c"]);
	});

	it("throws on a duplicated edge to END from the same from (design §6.4)", () => {
		const graph = chainedGraph(["a"]);

		const error = captureSingleIssue(() => graph.addEdge("a", END));

		expect(error.issues[0]).toContain('"a"');
	});

	it("accepts START as from and END as to (sentinels, no node lookup at add time)", () => {
		const graph = new StateGraph<State>().addNode(
			"a",
			fnNode<State>(noopHandler),
		);

		expect(() => graph.addEdge(START, "a")).not.toThrow();
		expect(() => graph.addEdge("a", END)).not.toThrow();
	});
});

describe("immediate validation (throws inside addConditionalEdges)", () => {
	it("throws when the same node already has a router (at most one per node)", () => {
		const graph = chainedGraph(["a"]);
		graph.addConditionalEdges("a", () => END);

		const error = captureSingleIssue(() =>
			graph.addConditionalEdges("a", () => "b"),
		);

		expect(error.issues[0]).toContain('"a"');
	});

	it("treats plain edges and a router as independent registrations", () => {
		const graph = chainedGraph(["a"]);
		graph.addConditionalEdges("a", () => END);

		expect(dataOf(graph).routers.has("a")).toBe(true);
		expect(dataOf(graph).plainEdges.has("a")).toBe(false); // a 只有 END 边与 router
	});
});

describe("cross-node validation is deferred to Task 6's compile", () => {
	it("accepts edges and routers referencing not-yet-registered nodes at add time", () => {
		const graph = new StateGraph<State>();

		// add 时不查引用存在性：先连边/router，后注册节点
		expect(() => graph.addEdge("a", "b")).not.toThrow();
		expect(() => graph.addConditionalEdges("a", () => END)).not.toThrow();

		graph
			.addNode("a", fnNode<State>(noopHandler))
			.addNode("b", fnNode<State>(noopHandler))
			.addEdge(START, "a")
			.addEdge("b", END);

		expect(dataOf(graph).plainEdges.get("a")).toEqual(["b"]);
		expect(dataOf(graph).routers.has("a")).toBe(true);
	});

	it("accepts a graph with no START out-edge at add time (Task 6 才会报错)", () => {
		const graph = new StateGraph<State>();

		expect(() => {
			graph.addNode("a", fnNode<State>(noopHandler)).addEdge("a", END);
		}).not.toThrow();
	});
});

describe("addNode storage", () => {
	it("backfills the empty name placeholder of fnNode", () => {
		const def = fnNode<State>(noopHandler);
		const graph = new StateGraph<State>()
			.addNode("worker", def)
			.addEdge(START, "worker")
			.addEdge("worker", END);

		expect(def.name).toBe("worker");
		const stored = dataOf(graph).nodes.get("worker");
		expect(stored?.name).toBe("worker");
		expect(stored?.kind).toBe("fn");
		expect(stored?.handler).toBe(noopHandler);
	});

	it("does not rewrite an already-named definition object (registration name wins)", () => {
		const def: NodeDefinition<State> = {
			kind: "fn",
			name: "explicit",
			handler: noopHandler,
		};
		const graph = chainedGraph(["a"]).addNode("c", def);
		const data = dataOf(graph);

		expect(data.nodes.get("c")?.name).toBe("c");
		expect(data.nodes.get("c")?.handler).toBe(noopHandler);
		expect(def.name).toBe("explicit");
	});

	it("registers the same definition object under two names without aliasing", () => {
		const def = fnNode<State>(noopHandler);
		const graph = chainedGraph(["a", "b"]).addNode("c", def).addNode("d", def);
		const data = dataOf(graph);

		expect(data.nodes.get("c")?.name).toBe("c");
		expect(data.nodes.get("d")?.name).toBe("d");
		expect(data.nodes.get("c")?.handler).toBe(noopHandler);
		expect(data.nodes.get("d")?.handler).toBe(noopHandler);
		// 第二次注册按注册名落名，不改写调用方已注册的对象
		expect(def.name).toBe("c");
	});

	it("stores llm / agent definitions as-is (factories land in M2)", () => {
		const graph = new StateGraph<State>()
			.addNode("summarize", {
				kind: "llm",
				name: "",
				handler: noopHandler,
				writeTo: "count",
				timeoutMs: 120_000,
			})
			.addEdge(START, "summarize")
			.addEdge("summarize", END);

		const stored = dataOf(graph).nodes.get("summarize");
		expect(stored?.kind).toBe("llm");
		expect(stored?.name).toBe("summarize");
		expect(stored?.writeTo).toBe("count");
		expect(stored?.timeoutMs).toBe(120_000);
	});
});

describe("compile()", () => {
	it('defaults the name to "graph", prefers cfg.name, then opts.name', () => {
		const bare = chainedGraph(["a"]);
		const named = chainedGraph(["a"], { name: "cfg" });

		expect(dataOf(bare).name).toBe("graph");
		expect(dataOf(named).name).toBe("cfg");
		expect(named.compile({ name: "opts" }).name).toBe("opts");
	});

	it("exposes the assembled CompiledGraphData with empty warnings", () => {
		const channels: StateSchema<State> = {
			log: (current, update) => [...current, ...update],
		};
		const stateSchema = Type.Object({
			count: Type.Number(),
			log: Type.Array(Type.String()),
		});
		const router = () => END;
		const graph = new StateGraph<State>({ name: "flow", channels, stateSchema })
			.addNode("a", fnNode<State>(noopHandler))
			.addNode("b", fnNode<State>(noopHandler))
			.addEdge(START, "a")
			.addEdge("a", "b")
			.addConditionalEdges("b", router);

		const data = dataOf(graph);

		expect(data.name).toBe("flow");
		expect(data.channels).toEqual(channels);
		expect(data.stateSchema).toBe(stateSchema);
		expect([...data.nodes.keys()]).toEqual(["a", "b"]);
		expect(data.plainEdges.get(START)).toEqual(["a"]);
		expect(data.plainEdges.get("a")).toEqual(["b"]);
		expect(data.routers.get("b")).toBe(router);
		expect(data.warnings).toEqual([]);
	});

	it("defaults channels to an empty schema when cfg omits them", () => {
		expect(dataOf(chainedGraph(["a"])).channels).toEqual({});
	});

	it("keeps END edges out of plainEdges (END triggers no node, brief contract)", () => {
		const graph = chainedGraph(["a"]);

		expect(dataOf(graph).plainEdges.has("a")).toBe(false);
	});

	it("returns a CompiledGraph whose run and invoke reject with not implemented", async () => {
		const app = chainedGraph(["a"], { name: "flow" }).compile();
		const initial: State = { count: 0, log: [] };

		expect(app.name).toBe("flow");
		await expect(app.run(initial)).rejects.toThrow("not implemented");
		await expect(app.invoke(initial)).rejects.toThrow("not implemented");
	});
});
