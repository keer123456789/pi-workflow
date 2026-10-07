/**
 * 错误分类（leaf 模块：无任何 import、无 I/O）。
 * 后续所有模块只从本文件导入这些错误类型。
 */

/** 全部 workflow 错误的基类。 */
export class WorkflowError extends Error {}

/** compile 期校验失败：一次聚合全部问题（issues）。 */
export class GraphValidationError extends WorkflowError {
	issues: string[];

	constructor(message: string, props: { issues: string[] }) {
		super(message);
		this.issues = props.issues;
	}
}

/** compile 封印后再改图。 */
export class GraphSealedError extends WorkflowError {}

/** router 返回值非法（未知节点 / START / 指向 END 的 Send / 抛异常）。 */
export class RouterError extends WorkflowError {
	nodeId: string;
	result: unknown;

	constructor(message: string, props: { nodeId: string; result: unknown }) {
		super(message);
		this.nodeId = props.nodeId;
		this.result = props.result;
	}
}

/** reducer-less key 并发写入冲突 / reducer 包装的错误。 */
export class InvalidWriteError extends WorkflowError {
	key: string;
	writers: string[];

	constructor(message: string, props: { key: string; writers: string[] }) {
		super(message);
		this.key = props.key;
		this.writers = props.writers;
	}
}

/** 超步数超过 recursionLimit。 */
export class GraphRecursionError extends WorkflowError {
	superstep: number;
	limit: number;

	constructor(message: string, props: { superstep: number; limit: number }) {
		super(message);
		this.superstep = props.superstep;
		this.limit = props.limit;
	}
}

/** 实例数超过预算（单超步或累计）。 */
export class InstanceBudgetError extends WorkflowError {
	kind: "superstep" | "total";
	limit: number;

	constructor(
		message: string,
		props: { kind: "superstep" | "total"; limit: number },
	) {
		super(message);
		this.kind = props.kind;
		this.limit = props.limit;
	}
}

/** 模板缺 key（不静默 undefined）。 */
export class TemplateError extends WorkflowError {
	template: string;
	key: string;

	constructor(message: string, props: { template: string; key: string }) {
		super(message);
		this.template = props.template;
		this.key = props.key;
	}
}

/** 节点执行失败：根因 + 被连带取消的实例。 */
export class NodeExecutionError extends WorkflowError {
	node: string;
	instanceId: string;
	cause: unknown;
	collateral: string[];
	logPath?: string;
	summary?: string;

	constructor(
		message: string,
		props: {
			node: string;
			instanceId: string;
			cause: unknown;
			collateral: string[];
			logPath?: string;
			summary?: string;
		},
	) {
		super(message);
		this.node = props.node;
		this.instanceId = props.instanceId;
		this.cause = props.cause;
		this.collateral = props.collateral;
		this.logPath = props.logPath;
		this.summary = props.summary;
	}
}
