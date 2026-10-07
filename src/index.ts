/**
 * 包公开面（设计 §4/§7.5/§10）：M1 的全部公开 API 与公开类型。
 *
 * 口径是**不增不漏**——逐名列出，不多导一个、也不少导一个：
 * - 运行期值：StateGraph / Send / START / END / fnNode（M1 只有 fn 工厂；llm/agent 属
 *   M2/M3）、4 个标准 reducer（overwrite/append/concat/setOnce）、9 个错误类、interpolate；
 * - 类型：前序任务 Interfaces 冻结的公开类型（NodeContext…SleepResult），一律 `export type`
 *   （只在类型位置存在，运行期无痕迹）。
 *
 * 内部设施**不进包面**：engine 的 executeRun/resolveServices、emitter、foldUpdates/
 * stateKeyUniverse、InstanceCancelledError 等都是实现细节（可自由重构，不构成契约）。
 * tests/public-exports.test.ts 用 `Object.keys` 的精确集合 + 类型位置的引用把这份口径
 * 钉住（多一个或少一个都会红）。
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
export { fnNode } from "./nodes/fn.js";
// —— 模板插值（设计 §5.6） ——
export { interpolate } from "./template.js";
