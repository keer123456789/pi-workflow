/**
 * 适配层公共接口（设计 §9.1）：`CompleteFn` 与用量类型 `TokenUsage`。
 *
 * - `src/runtime/` 是适配器的**物理隔离区**：core/** 不 import `@earendil-works/*`，
 *   只对本文件做 **type-only import**（`import type` 编译期擦除——运行时零耦合）；
 * - `AgentExecutor`、pi-ai / subprocess / sdk 实现属后续里程碑，本任务只落类型。
 */

import type { TSchema } from "typebox";

/**
 * 一次补全调用的 token 用量（D4）。字段与 pi-ai 的 assistant usage 对齐，
 * 由适配器负责映射；`cost` 可选（自定义网关可以不报成本）。
 */
export type TokenUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
};

/**
 * 补全实现（D5；设计 §9.1）：llm 节点的默认实现经 `services.complete` 注入，
 * 节点级覆盖用 `NodeDefinition.complete`（§4.3/D12）。
 *
 * - `schema`：llm 节点声明的产出 schema（此处可选——适配器按需使用）；
 * - `signal` / `timeoutMs`：本次尝试的取消与超时（引擎提供，§7.4）；
 * - 返回 `{ text, usage? }`：usage 在该尝试**成功**时由引擎挂到
 *   `node_finished.usage`（D11）——失败尝试的调用方不必上报用量。
 */
export type CompleteFn = (req: {
	prompt: string;
	model?: string;
	schema?: TSchema;
	signal: AbortSignal;
	timeoutMs: number;
}) => Promise<{ text: string; usage?: TokenUsage }>;
