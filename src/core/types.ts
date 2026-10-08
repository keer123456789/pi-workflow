/**
 * 公共类型与哨兵常量（leaf 模块：只有 START/END 两个运行期值，无 I/O）。
 *
 * 图构建器（StateGraph）在 graph.ts，不在这里；本文件只放被各方共享的类型，
 * 以及对外的常量 START / END。
 */

import type { TSchema } from "typebox";

import type { RunLogger } from "../log/runlog.js";
import type { CompleteFn, TokenUsage } from "../runtime/executor.js";
import type { PiSdkConfig } from "../runtime/pi-sdk.js";
import type { PiSubprocessConfig } from "../runtime/pi-subprocess.js";
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
	/**
	 * **attempt signal**（设计 §7.4 三级信号里节点能看到的那一级）：从实例信号派生、
	 * 每次重试新建（本尝试超时只 abort 它，不影响下一次尝试）。
	 *
	 * 触发条件：run 级取消（调用方 signal / RunHandle.cancel() / runTimeoutMs 到期）、
	 * 同超步兄弟实例失败（fail-fast）、本尝试 `timeoutMs` 到期。
	 * 节点**必须**尊重它（长循环里周期性检查，§7.4:440）——引擎无法抢占不检查信号的节点。
	 */
	signal: AbortSignal;
	/**
	 * 上报本次尝试的 token 用量（D11）：按 attempt 记录、最后一次生效；只有**成功**
	 * 尝试的值会挂到 `node_finished.usage`（失败/重试的尝试不产生 usage）。
	 * 引擎**总是提供**这个回调（声明可选是给手工组装 ctx 的调用方留余地）。
	 */
	reportUsage?: (usage: TokenUsage) => void;
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
	/**
	 * 补全实现（D12）：**只有 `kind === "llm"` 允许声明**（其他 kind 声明它 →
	 * compile 期 issue）。compile 解析顺序 `def.complete ?? services.complete ??
	 * pi-ai 默认（可用时）`；全缺 → compile 报"has no completion implementation"。
	 */
	complete?: CompleteFn;
	retry?: { maxAttempts: number };
	timeoutMs?: number;
};

/**
 * 条件边的返回值：节点名、END 或 Send（可数组形式一次给出多个目标）。
 * `null` / `undefined` 合法，语义同 END（设计 §4.2:183-184）；数组内的 null 项同样
 * 只终止该项（运行期归一化在 engine.ts 的 normalizeRoute）。数组内项按本类型的
 * 元素联合声明，null 项对 TS 调用方是运行期防御面（JS 调用方到得了）。
 */
export type RouterResult =
	| typeof END
	| string
	| Send
	| null
	| undefined
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
	/**
	 * agent 节点的适配器配置（§4.6/D20）：`subprocess` 字段全可选——空对象 `{}` 即
	 * 接受全部默认；`sdk` 字段同形状（`PiSdkConfig`，M4/T1 定型，D25/D27），适配器
	 * 实现归 M4/T2（M3 内声明 `executor: "sdk"` 只产 compile issue，T3 接线）。
	 */
	agent?: { subprocess?: PiSubprocessConfig; sdk?: PiSdkConfig };
	/** llm 节点的默认补全实现（§4.6/D12）：缺省时 compile 用 pi-ai 适配器（§9.4）。 */
	complete?: CompleteFn;
	/**
	 * run 日志实现（§8/D2）：`=== undefined` → 用内置 JSONL 实现（日志默认开启）；
	 * `!== undefined` → **原样使用**——空对象 `{}`（钩子全可选）= 全静默（显式关闭）。
	 */
	logger?: RunLogger;
	clock?: () => number;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
};

/**
 * sleep 的返回值（R20）：**公开契约不变**——`Services.sleep` 依然是
 * `(ms) => Promise<void>`，注入实现不需要知道这个类型。默认实现额外挂一个非枚举的
 * `cancel()`（清掉未到期的定时器），引擎只做**能力探测**（`typeof cancel === "function"`）：
 * run 结束、竞速分出胜负之后，把已不再等待的睡眠句柄清掉，事件循环不再被引擎持有的
 * 计时器拖住。等待期间（退避 = 进度等待）计时器保持 ref'd，进程不会在退避中途退出。
 */
export interface SleepResult extends Promise<void> {
	readonly cancel?: () => void;
}

/**
 * compile 期归一后的运行服务（Task 8 R3）：三个字段全部必填，
 * 缺省值在 compile 时落定（Date.now / 可取消的 setTimeout / Math.random），
 * 引擎内部不再处理 undefined。`sleep` 的返回类型放宽到 {@link SleepResult}
 * （可选 `cancel`），注入的普通 `(ms) => Promise<void>` 依然兼容（R20）。
 */
export type ResolvedServices = {
	clock: () => number;
	sleep: (ms: number) => SleepResult;
	random: () => number;
	/**
	 * run 日志实现（Task 3，D2）：从 `Services.logger` **原样**传递——**不做默认化**。
	 * `undefined` = "用内置 JSONL 实现"，具体装配在 run 期完成（默认目录要按 run 解析：
	 * `logDir` → `PI_WORKFLOW_LOG_DIR` → `.pi-workflow/runs`）；`!== undefined` 原样使用
	 * （空对象 `{}` = 钩子全缺省 = 全静默）。可选字段：手工装配 ResolvedServices 的
	 * 调用方不必提供。
	 */
	logger?: RunLogger;
};

/**
 * run 期事件流（设计 §8；Task 8 引入）。所有事件共享
 * `seq`（全局单调的 eventSeq）、`superstep`、`ts`（services.clock()）与 `runId`。
 * 顺序保证 = 完成序（实时性优先，§8.1）：需要全序的消费者用 seq 重排。
 *
 * committed 边界语义（T10）：**不做**逐事件打标（§8.1 样例的 `committed:false` 在 M1
 * 不落字段）。某超步是否提交看它的事件之后跟随的边界事件——`superstep_committed`
 * 已提交 / `superstep_aborted` 未提交（含失败超步）；消费方按最近边界判定。
 *
 * `run_finished.superstep` 语义（R1）——**两套编号**，按结局分：
 * - **失败路径**：实例失败 / 提交失败 / 生成下一批失败 = **已执行（或正在执行）**的超步
 *   编号；**被拒绝、一个实例都没跑的那一批**（recursionLimit 越限、两类实例预算越限）=
 *   **尝试**的超步编号（本超步未执行；limit 内跑满后 = limit + 1，与
 *   `GraphRecursionError.superstep` 对齐）；run 未开始（初始激活的内部不变量错误）= 0。
 * - **取消路径**（调用方 signal / `RunHandle.cancel()` / `runTimeoutMs` 到期）=
 *   **最后执行过的**超步编号：超步之间取消 = 最近跑完的超步号；超步内取消 = 正在执行的
 *   超步号（该超步整体不提交，随附 `superstep_aborted` 边界）。取消路径永远不会报一个
 *   未执行的"尝试超步"。
 */
export type RunEvent =
	| {
			seq: number;
			superstep: number;
			ts: number;
			runId: string;
			type: "run_started";
			graph: string;
			input: unknown;
	  }
	| {
			seq: number;
			superstep: number;
			ts: number;
			runId: string;
			type: "node_started";
			node: string;
			instanceId: string;
			kind: string;
	  }
	| {
			seq: number;
			superstep: number;
			ts: number;
			runId: string;
			type: "node_finished";
			node: string;
			instanceId: string;
			output: unknown;
			/**
			 * 成功尝试的用量（D11）：handler 经 `ctx.reportUsage` 上报（按 attempt 取末次）。
			 * 未上报时**不落此字段**；失败/重试的尝试不产生 usage。
			 */
			usage?: TokenUsage;
			/** 实例墙钟时长：含重试与退避（非最后一次尝试耗时，§8.1）。 */
			durationMs: number;
	  }
	| {
			seq: number;
			superstep: number;
			ts: number;
			runId: string;
			/**
			 * 瞬态失败后的重试（§7.2/§8.1）：每次重试前发一条。
			 * `attempt` = **刚失败的那次尝试**编号（1 起）；`error` = 失败错误的消息文本。
			 */
			type: "node_retry";
			node: string;
			instanceId: string;
			attempt: number;
			error: string;
	  }
	| {
			seq: number;
			superstep: number;
			ts: number;
			runId: string;
			type: "node_failed";
			node: string;
			instanceId: string;
			error: string;
	  }
	| {
			seq: number;
			superstep: number;
			ts: number;
			runId: string;
			type: "superstep_committed";
	  }
	| {
			seq: number;
			superstep: number;
			ts: number;
			runId: string;
			type: "superstep_aborted";
	  }
	| {
			seq: number;
			superstep: number;
			ts: number;
			runId: string;
			type: "run_finished";
			status: "completed" | "failed";
			durationMs: number;
	  };

/**
 * run 期执行控制（设计 §4.4；默认值：recursionLimit 25、maxConcurrency 8、
 * maxInstancesPerSuperstep 1000、maxTotalInstances 10000）。
 *
 * 数值上限的**非有限值**（NaN / +Infinity / -Infinity）一律回落各自默认值——Infinity
 * **不代表"不限"**（落地界限形同虚设，与 recursionLimit 同一策略，见 engine.ts 的
 * 归一函数）；`runTimeoutMs` 是例外：非有限或 <= 0 表示"无超时"（本就默认无超时）。
 */
export type RunOptions = {
	recursionLimit?: number;
	maxConcurrency?: number;
	maxInstancesPerSuperstep?: number;
	maxTotalInstances?: number;
	runTimeoutMs?: number;
	signal?: AbortSignal;
	onEvent?: (e: RunEvent) => void;
	/**
	 * 日志目录（§8/D2）：默认 `PI_WORKFLOW_LOG_DIR` 环境变量，再缺省
	 * `.pi-workflow/runs`；每次 run 写 `<dir>/<YYYYMMDDTHHmmssSSSZ>-<runId>/run.jsonl`。
	 */
	logDir?: string;
	/**
	 * 敏感输入/输出的记录方式（§8.1/D7）：默认 `"full"`；`"hash"` 时
	 * `run_started.input`、`node_started.input`、`node_finished.output` 替换为
	 * `"sha256:<hex>"`——onEvent 与日志文件两路都拿脱敏后的值。
	 */
	logOutputs?: "full" | "hash";
	/**
	 * 日志写失败策略（§8.1/D8）：默认 `"fail"`——logger 任一钩子抛错使 run 以
	 * `WorkflowError("run log write failed: …")` 拒绝（含 `run_finished` 之后
	 * `onRunFinish` 抛错；审计优先，刻意）；`"warn"` 只 `console.warn` 并继续。
	 */
	onLogError?: "fail" | "warn";
};

/** run() 的产物（注意：不是裸 state，与 langgraph 的 invoke 有差异，设计 §12）。 */
export type RunResult<S> = { state: S; runId: string };

/**
 * run()/invoke() 的句柄（设计 §4.4 的实现层细化，T11）：await 得到 `RunResult`，
 * 另可 `cancel()` 中止本次 run（abort run signal，§7.4 的 run 级取消）。
 * 实现形态：promise 本体附加 cancel 方法（不引入 Promise 子类）——`then`/`catch` 与
 * 普通 promise 完全一致，`then` 的产物是普通 promise（不再带 cancel）。
 */
export interface RunHandle<S> extends Promise<RunResult<S>> {
	/** 中止本次 run：幂等；run 已 settle 后是 no-op。 */
	cancel(): void;
}

/** compile() 的产物；invoke 是 run 的别名（Task 6 封印、Task 8 引擎接线）。 */
export type CompiledGraph<S> = {
	readonly name: string;
	run(initial: S, options?: RunOptions): RunHandle<S>;
	invoke: CompiledGraph<S>["run"];
};
