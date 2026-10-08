/**
 * 适配层公共接口（设计 §9.1）：`CompleteFn`、`AgentExecutor` 与用量类型 `TokenUsage`。
 *
 * - `src/runtime/` 是适配器的**物理隔离区**：core/** 不 import `@earendil-works/*`，
 *   对 runtime 模块一律 **type-only import**（`import type` 编译期擦除——运行时零耦合）；
 * - pi-ai 默认补全已落地（`llm-pi-ai.ts`，M2）；subprocess / sdk 适配器实现属后续
 *   里程碑，本文件只承载接口类型。
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

/**
 * agent 节点的执行器（设计 §9.1）：一次 agent 任务的适配层调用——默认实现是
 * pi CLI subprocess 适配器（`runtime/pi-subprocess.ts`），也可注入自定义函数
 * （D20：`agentNode` 的 `executor` 字段三选一）。
 *
 * - `task`：插值后的任务文本（D22：schema 指令由 handler 层拼接在插值之后，
 *   不参与插值）；
 * - `tools` / `model`：D23——只透传节点声明与配置的解析结果，缺省则适配器
 *   不带对应 CLI 参数；
 * - `schema`：产出 schema（§9.3：原样透传——解析与校验在 handler 层，M3 的
 *   subprocess 适配器不使用它，自定义适配器按需使用）；
 * - `signal` / `timeoutMs`：本次尝试的取消与超时（引擎提供的 attempt 级信号，§7.4）；
 * - `runId` / `instanceId`：本次执行归属的 run 与节点实例（适配器侧日志/排查用）；
 * - 返回 `{ output, usage? }`：`output` 是 agent 的最终文本产出（schema 模式下是
 *   待 handler 层解析的原文，§9.3）；`usage` 语义同 `CompleteFn`（D11/D21：
 *   缺失则引擎不上报用量，数字键缺失由适配器以 0 填）。
 */
export type AgentExecutor = (req: {
	task: string;
	tools?: string[];
	model?: string;
	schema?: TSchema;
	signal: AbortSignal;
	timeoutMs: number;
	runId: string;
	instanceId: string;
}) => Promise<{ output: string; usage?: TokenUsage }>;
