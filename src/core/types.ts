/**
 * 公共类型与哨兵常量（leaf 模块：只有 START/END 两个运行期值，无 I/O）。
 *
 * 图构建器（StateGraph）在 graph.ts，不在这里；本文件只放被各方共享的类型，
 * 以及对外的常量 START / END。
 */

import type { TSchema } from "typebox";

import type { Send } from "./send.js";
import type { StateSchema } from "./state.js";

/** 虚拟起点：只有出边，没有对应的节点定义。 */
export const START = "__start__";
/** 虚拟终点：该分支终止的标记，不触发任何节点。 */
export const END = "__end__";

/** 节点执行上下文（设计 §4.3）。 */
export type NodeContext = {
	runId: string;
	superstep: number;
	instanceId: string;
	seq: number;
	signal: AbortSignal;
};

/** 节点主体：输入只读，返回本次要写入 state 的增量。 */
export type NodeHandler<S, I> = (
	input: Readonly<I>,
	ctx: NodeContext,
) => Promise<Partial<S>> | Partial<S>;

/**
 * 注册到图里的节点定义。
 * `name` 在注册时由 StateGraph.addNode 回填（fnNode 产出空串占位）。
 */
export type NodeDefinition<S, I = S> = {
	kind: "fn" | "llm" | "agent";
	name: string;
	handler: NodeHandler<S, I>;
	inputType?: TSchema;
	writeTo?: string;
	retry?: { maxAttempts: number };
	timeoutMs?: number;
};

/** 条件边的返回值：节点名、END 或 Send（可数组形式一次给出多个目标）。 */
export type RouterResult =
	| typeof END
	| string
	| Send
	| (typeof END | string | Send)[];

/**
 * 条件边 router：读合并后 state 与源节点本次写入（lastUpdate），
 * 每个节点每个超步至多求值一次（设计 §4.2/§5.1）。
 */
// biome-ignore lint/correctness/noUnusedVariables: I 按任务 brief verbatim 保留（调用方用它标注 Send 输入类型；I 暂不进 RouterResult）
export type Router<S, I = unknown> = (
	state: S,
	lastUpdate: Partial<S>,
) => RouterResult;

/** StateGraph 构造参数。 */
export type GraphCfg<S> = {
	name?: string;
	channels?: StateSchema<S>;
	stateSchema?: TSchema;
};

/** compile() 装配出的图数据（Task 6 在其上校验并封印，Task 8 引擎消费）。 */
export type CompiledGraphData<S> = {
	name: string;
	channels: StateSchema<S>;
	stateSchema?: TSchema;
	// biome-ignore lint/suspicious/noExplicitAny: 对外字段按任务 brief verbatim（注册表里 I 泛型已擦除，设计 §4.2）
	nodes: Map<string, NodeDefinition<S, any>>;
	/**
	 * from → 有序目标（注册序保持）。
	 * 不含 END：连到 END 的边不触发节点，由构建器单独登记（见 graph.ts）。
	 */
	plainEdges: Map<string, string[]>;
	// biome-ignore lint/suspicious/noExplicitAny: 同上（Router<S, any>，I 只用于 Send 输入的类型标注）
	routers: Map<string, Router<S, any>>;
	/** compile 期警告（Task 6 填充；警告不算错误，见设计 §6）。 */
	warnings: string[];
};

/** compile 期注入的依赖（设计 §4.6；M1 只用 name，其余字段 M2/M3 生效）。 */
export type CompileOptions = { name?: string; services?: Services };

export type Services = {
	// biome-ignore lint/suspicious/noExplicitAny: 对外字段按任务 brief verbatim（M2/M3 才细化具体配置）
	agent?: { subprocess?: any; sdk?: any };
	complete?: unknown;
	logger?: unknown;
	clock?: () => number;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
};

/**
 * run 期执行控制（设计 §4.4；默认值：recursionLimit 25、maxConcurrency 8、
 * maxInstancesPerSuperstep 1000、maxTotalInstances 10000）。
 * onEvent 字段待 Task 8 引入 RunEvent 后增补。
 */
export type RunOptions = {
	recursionLimit?: number;
	maxConcurrency?: number;
	maxInstancesPerSuperstep?: number;
	maxTotalInstances?: number;
	runTimeoutMs?: number;
	signal?: AbortSignal;
	logDir?: string;
	logOutputs?: "full" | "hash";
	onLogError?: "fail" | "warn";
};

/** run() 的产物（注意：不是裸 state，与 langgraph 的 invoke 有差异，设计 §12）。 */
export type RunResult<S> = { state: S; runId: string };

/** compile() 的产物；invoke 是 run 的别名（Task 6 封印、Task 8 引擎接线）。 */
export type CompiledGraph<S> = {
	readonly name: string;
	run(initial: S, options?: RunOptions): Promise<RunResult<S>>;
	invoke: CompiledGraph<S>["run"];
};
