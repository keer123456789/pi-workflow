/**
 * run 日志（设计 §8）：日志注入点的类型 `RunLogger`。
 *
 * - 本文件是 `src/log/` 的实现模块（**唯一允许直接 I/O 的地方**）；本任务只落
 *   `RunLogger` 类型，JSONL 实现（`createJsonlLogger`）在后续任务补入——
 *   实现是内部设施，不进包公开面；
 * - 判定语义（D2/R2，设计 §4.6）：`services.logger !== undefined` 即**原样使用**
 *   ——空对象 `{}`（三个钩子全可选）= 全静默（显式关闭日志）；
 * - 三个钩子全部**同步**（异步会把事件顺序与完成序解耦，写失败也无法即刻捕获）。
 */

import type { RunEvent } from "../core/types.js";

/** run 日志实现（§8）：run 开始、每个事件、run 结束三处时机；钩子全部可选。 */
export type RunLogger = {
	/** preflight 通过、首个事件之前调用一次。 */
	onRunStart?(info: { runId: string; graph: string; ts: number }): void;
	/** 每个 RunEvent（与 onEvent 同序 = 完成序，§8.1）；hash 模式下已是脱敏值（D7）。 */
	onEvent?(event: RunEvent): void;
	/** `run_finished` 发出之后调用一次；`status` 与 `run_finished.status` 一致。 */
	onRunFinish?(info: {
		runId: string;
		status: "completed" | "failed";
		ts: number;
	}): void;
};
