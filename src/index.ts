/**
 * 包公开面（设计 §4/§7.5/§10）：M1 的全部公开 API 与公开类型 + M2 新增（llmNode 与三类型）
 * + M3 新增（agentNode 与 AgentExecutor / PiSubprocessConfig 两类型）。
 *
 * 口径是**不增不漏**——逐名列出，不多导一个、也不少导一个：
 * - 运行期值：StateGraph / Send / START / END / 节点工厂（fnNode / llmNode / agentNode）、4 个标准
 *   reducer（overwrite/append/concat/setOnce）、9 个错误类、interpolate；
 * - 类型：前序任务 Interfaces 冻结的公开类型（NodeContext…SleepResult），一律 `export type`
 *   （只在类型位置存在，运行期无痕迹）；M2 增 `TokenUsage` / `CompleteFn` / `RunLogger`；
 *   M3 增 `AgentExecutor` / `PiSubprocessConfig`。
 *
 * 内部设施**不进包面**：engine 的 executeRun/resolveServices、emitter、foldUpdates/
 * stateKeyUniverse、InstanceCancelledError 等都是实现细节（可自由重构，不构成契约）。
 * tests/public-exports.test.ts 的钉法（覆盖范围如实说明）：
 * - **运行期值**：`Object.keys` 精确集合——多导（内部泄漏）或少导都会红；
 * - **类型**：只对上面列名的类型逐一在类型位置引用（删一个名字/改名 → typecheck 失败）；
 *   **多导一个类型名在类型层面钉不住**（类型没有运行期痕迹）——这份清单本身就是口径。
 */

// —— 错误分类（设计 §7；9 类全公开，调用方按类型分支） ——
export {
	GraphRecursionError,
	GraphSealedError,
	GraphValidationError,
	InstanceBudgetError,
	InvalidWriteError,
	NodeExecutionError,
	RouterError,
	TemplateError,
	WorkflowError,
} from "./core/errors.js";
// —— 图构建与执行（设计 §4.1/§4.2/§4.4） ——
export { StateGraph } from "./core/graph.js";
export { Send } from "./core/send.js";
export type { ChannelUpdate, Reducer, StateSchema } from "./core/state.js";

// —— 标准 reducer（设计 §4.5） ——
export { append, concat, overwrite, setOnce } from "./core/state.js";
// —— 公开类型（设计 §4.2–§4.6/§7.4） ——
export type {
	CompiledGraph,
	CompiledGraphData,
	CompileOptions,
	GraphCfg,
	NodeContext,
	NodeDefinition,
	NodeHandler,
	ResolvedServices,
	Router,
	RouterResult,
	RunEvent,
	RunHandle,
	RunOptions,
	RunResult,
	Services,
	SleepResult,
} from "./core/types.js";
export { END, START } from "./core/types.js";
// —— M2 公开类型（设计 §8/§9.1）：日志注入点与补全接口 ——
export type { RunLogger } from "./log/runlog.js";
// —— M3 agent 节点工厂（设计 §4.3/§4.6）：值导出，executor 在 compile 期绑定（D20） ——
export { agentNode } from "./nodes/agent.js";
export { fnNode } from "./nodes/fn.js";
export { llmNode } from "./nodes/llm.js";
// —— M3 公开类型（设计 §4.6/§9.1）：agent 执行器接口与 pi subprocess 配置
// （适配器实现见 src/runtime/pi-subprocess.ts）——
export type {
	AgentExecutor,
	CompleteFn,
	TokenUsage,
} from "./runtime/executor.js";
export type { PiSubprocessConfig } from "./runtime/pi-subprocess.js";
// —— 模板插值（设计 §5.6） ——
export { interpolate } from "./template.js";
