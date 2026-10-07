import { describe, expect, it } from "vitest";

import type {
	NodeContext,
	NodeDefinition,
	NodeHandler,
} from "../../src/core/types.js";
import { fnNode } from "../../src/nodes/fn.js";

type State = { count: number; log: string[] };

const ctx: NodeContext = {
	runId: "run-1",
	superstep: 0,
	instanceId: "a#0",
	seq: 0,
	signal: new AbortController().signal,
};

describe("fnNode", () => {
	it("returns a fn-kind definition with an empty name placeholder", () => {
		const handler: NodeHandler<State, State> = (input) => ({
			count: input.count,
		});
		const def = fnNode(handler);

		expect(def.kind).toBe("fn");
		expect(def.name).toBe("");
		expect(def.handler).toBe(handler);
	});

	it("leaves timeoutMs undefined when opts are omitted", () => {
		const def = fnNode<State>((input) => ({ count: input.count }));

		expect(def.timeoutMs).toBeUndefined();
	});

	it("carries timeoutMs from opts", () => {
		const def = fnNode<State>((input) => ({ count: input.count }), {
			timeoutMs: 5_000,
		});

		expect(def.timeoutMs).toBe(5_000);
	});

	it("does not offer retry (fn failures are code errors, design §7.1)", () => {
		const def = fnNode<State>((input) => ({ count: input.count }));

		expect(def.retry).toBeUndefined();
	});

	it("returns a fresh object per call (addNode backfills name per registration)", () => {
		const handler: NodeHandler<State, State> = (input) => ({
			count: input.count,
		});

		expect(fnNode(handler)).not.toBe(fnNode(handler));
	});

	it("exposes a handler callable with (input, ctx) returning a partial state", async () => {
		const def: NodeDefinition<State, { task: string }> = fnNode<
			State,
			{ task: string }
		>((input) => ({ log: [input.task] }));

		const partial = await def.handler({ task: "t" }, ctx);

		expect(partial).toEqual({ log: ["t"] });
	});

	it("accepts a sync handler returning a partial state without wrapping", () => {
		const def = fnNode<State>((input, context) => ({
			count: input.count + context.seq,
		}));

		expect(def.handler({ count: 2, log: [] }, ctx)).toEqual({ count: 2 });
	});
});
