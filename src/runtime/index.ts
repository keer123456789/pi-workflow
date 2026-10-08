/**
 * `./runtime` 子入口（M5 T1，D33）：适配层公开面——5 个公开类型 + 2 个可用性探测函数。
 *
 * 口径同 `src/index.ts` 的**不增不漏**：
 * - 类型（各自来源模块）：`AgentExecutor` / `CompleteFn` / `TokenUsage`（executor.ts）、
 *   `PiSubprocessConfig`（pi-subprocess.ts）、`PiSdkConfig`（pi-sdk.ts）；
 * - 值导出（均为函数，调用后返回 boolean）：`isPiAiAvailable`（llm-pi-ai.ts）/ `isPiSdkAvailable`（pi-sdk.ts）——
 *   compile 前探测对等依赖是否可解析，给可行动 issue 用。
 *
 * 适配器本体**不进子入口**（M2/M4 裁定不变）：`createPiSubprocessExecutor` /
 * `createPiSdkExecutor` 维持内部导出，供 compile 解析与高级用户直接接线用；
 * `buildSpawnArgs`、探针、用量映射等内部设施同不导。
 * tests/public-exports.test.ts 的 runtime 断言组钉住这个口径。
 */

export type { AgentExecutor, CompleteFn, TokenUsage } from "./executor.js";
export { isPiAiAvailable } from "./llm-pi-ai.js";
export type { PiSdkConfig } from "./pi-sdk.js";
export { isPiSdkAvailable } from "./pi-sdk.js";
export type { PiSubprocessConfig } from "./pi-subprocess.js";
