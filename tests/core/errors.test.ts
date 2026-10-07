import { describe, expect, it } from "vitest";

import {
	GraphRecursionError,
	GraphSealedError,
	GraphValidationError,
	InstanceBudgetError,
	InvalidWriteError,
	NodeExecutionError,
	RouterError,
	TemplateError,
	WorkflowError,
} from "../../src/core/errors.js";

describe("WorkflowError", () => {
	it("throws as itself and preserves the message", () => {
		const error = new WorkflowError("boom");
		expect(() => {
			throw error;
		}).toThrow(WorkflowError);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("boom");
	});
});

describe("GraphValidationError", () => {
	it("throws as itself and preserves every aggregated issue", () => {
		const issues = [
			"node a: duplicate node name",
			"edge START -> ghost: unknown target",
		];
		const error = new GraphValidationError("graph invalid", { issues });
		expect(() => {
			throw error;
		}).toThrow(GraphValidationError);
		expect(error.message).toBe("graph invalid");
		expect(error.issues).toEqual(issues);
	});
});

describe("GraphSealedError", () => {
	it("throws as itself and preserves the message", () => {
		const error = new GraphSealedError("graph is sealed");
		expect(() => {
			throw error;
		}).toThrow(GraphSealedError);
		expect(error.message).toBe("graph is sealed");
	});
});

describe("RouterError", () => {
	it("throws as itself and preserves nodeId and result", () => {
		const result = { route: "ghost" };
		const error = new RouterError("router returned an unknown node", {
			nodeId: "a",
			result,
		});
		expect(() => {
			throw error;
		}).toThrow(RouterError);
		expect(error.message).toBe("router returned an unknown node");
		expect(error.nodeId).toBe("a");
		expect(error.result).toBe(result);
	});
});

describe("InvalidWriteError", () => {
	it("throws as itself and preserves key and writers", () => {
		const writers = ["a", "b"];
		const error = new InvalidWriteError("conflicting writes", {
			key: "k",
			writers,
		});
		expect(() => {
			throw error;
		}).toThrow(InvalidWriteError);
		expect(error.message).toBe("conflicting writes");
		expect(error.key).toBe("k");
		expect(error.writers).toEqual(["a", "b"]);
		expect(error.writers).toBe(writers);
	});
});

describe("GraphRecursionError", () => {
	it("throws as itself and preserves superstep and limit", () => {
		const error = new GraphRecursionError("recursion limit exceeded", {
			superstep: 26,
			limit: 25,
		});
		expect(() => {
			throw error;
		}).toThrow(GraphRecursionError);
		expect(error.message).toBe("recursion limit exceeded");
		expect(error.superstep).toBe(26);
		expect(error.limit).toBe(25);
	});
});

describe("InstanceBudgetError", () => {
	it("throws as itself and preserves kind and limit for a superstep budget", () => {
		const error = new InstanceBudgetError("superstep budget exceeded", {
			kind: "superstep",
			limit: 1000,
		});
		expect(() => {
			throw error;
		}).toThrow(InstanceBudgetError);
		expect(error.message).toBe("superstep budget exceeded");
		expect(error.kind).toBe("superstep");
		expect(error.limit).toBe(1000);
	});

	it("throws as itself and preserves kind and limit for a total budget", () => {
		const error = new InstanceBudgetError("total budget exceeded", {
			kind: "total",
			limit: 5000,
		});
		expect(() => {
			throw error;
		}).toThrow(InstanceBudgetError);
		expect(error.kind).toBe("total");
		expect(error.limit).toBe(5000);
	});
});

describe("TemplateError", () => {
	it("throws as itself and preserves template and key", () => {
		const error = new TemplateError("missing template key", {
			template: "hello {user.name}",
			key: "user.name",
		});
		expect(() => {
			throw error;
		}).toThrow(TemplateError);
		expect(error.message).toBe("missing template key");
		expect(error.template).toBe("hello {user.name}");
		expect(error.key).toBe("user.name");
	});
});

describe("NodeExecutionError", () => {
	it("throws as itself and preserves node, instanceId, cause, collateral and optional log fields", () => {
		const cause = new Error("root cause");
		const error = new NodeExecutionError("node b failed", {
			node: "b",
			instanceId: "b#1",
			cause,
			collateral: ["c#1", "d#1"],
			logPath: ".pi-workflow/logs/run-1.jsonl",
			summary: "provider returned 500",
		});
		expect(() => {
			throw error;
		}).toThrow(NodeExecutionError);
		expect(error.message).toBe("node b failed");
		expect(error.node).toBe("b");
		expect(error.instanceId).toBe("b#1");
		expect(error.cause).toBe(cause);
		expect(error.collateral).toEqual(["c#1", "d#1"]);
		expect(error.logPath).toBe(".pi-workflow/logs/run-1.jsonl");
		expect(error.summary).toBe("provider returned 500");
	});

	it("leaves the optional log fields undefined when omitted", () => {
		const cause = new Error("root cause");
		const error = new NodeExecutionError("node b failed", {
			node: "b",
			instanceId: "b#2",
			cause,
			collateral: [],
		});
		expect(() => {
			throw error;
		}).toThrow(NodeExecutionError);
		expect(error.logPath).toBeUndefined();
		expect(error.summary).toBeUndefined();
		expect(error.cause).toBe(cause);
		expect(error.collateral).toEqual([]);
	});
});

describe("error hierarchy", () => {
	const instances: WorkflowError[] = [
		new WorkflowError("base"),
		new GraphValidationError("graph invalid", { issues: [] }),
		new GraphSealedError("graph is sealed"),
		new RouterError("router returned an unknown node", {
			nodeId: "a",
			result: undefined,
		}),
		new InvalidWriteError("conflicting writes", {
			key: "k",
			writers: ["a", "b"],
		}),
		new GraphRecursionError("recursion limit exceeded", {
			superstep: 26,
			limit: 25,
		}),
		new InstanceBudgetError("budget exceeded", { kind: "total", limit: 5000 }),
		new TemplateError("missing template key", { template: "{k}", key: "k" }),
		new NodeExecutionError("node b failed", {
			node: "b",
			instanceId: "b#0",
			cause: undefined,
			collateral: [],
		}),
	];

	it("covers all 9 error classes", () => {
		expect(instances).toHaveLength(9);
	});

	it("makes every error an instance of WorkflowError and Error", () => {
		for (const error of instances) {
			expect(error).toBeInstanceOf(WorkflowError);
			expect(error).toBeInstanceOf(Error);
		}
	});
});
