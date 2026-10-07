/**
 * run 日志（设计 §8）：日志注入点的类型 `RunLogger` + 内置 JSONL 实现。
 *
 * - 本文件是 `src/log/` 的实现模块（**唯一允许直接 I/O 的地方**）：`RunLogger`
 *   类型 + 默认实现 `createJsonlLogger`（D9，内部设施，不进包公开面）；
 * - 判定语义（D2/R2，设计 §4.6）：`services.logger !== undefined` 即**原样使用**
 *   ——空对象 `{}`（三个钩子全可选）= 全静默（显式关闭日志）；
 * - 三个钩子全部**同步**（异步会把事件顺序与完成序解耦，写失败也无法即刻捕获）。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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

/** 数字左补零到固定宽度（时间戳各段拼接用）。 */
function pad(value: number, width: number): string {
	return String(value).padStart(width, "0");
}

/**
 * 目录名时间戳（D9）：`YYYYMMDDTHHmmssSSSZ`——UTC，无冒号无点（Windows 文件名合法）。
 * 入参是 ms 时钟值（工厂的 `ts`，**不是** Date.now() 的隐式取值）。
 * 模块内导出供测试使用，不进包公开面。
 */
export function formatLogTimestamp(ts: number): string {
	const d = new Date(ts);
	return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}T${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}${pad(d.getUTCMilliseconds(), 3)}Z`;
}

/**
 * 内置 JSONL 运行日志（D2 的默认实现；设计 §8/D9）：每次 run 一个目录
 * `<dir>/<YYYYMMDDTHHmmssSSSZ>-<runId>/`，事件逐行 JSON 落盘 `run.jsonl`。
 *
 * - **同步 fs**（D9）：事件顺序 = 钩子调用顺序，写失败在钩子内即刻抛出，
 *   引擎（Task 3）按 `onLogError` 决策 fail/warn；
 * - **无状态**：每次 append 自行开关文件，`onRunFinish` 因此是 no-op；
 * - **失败包装**（D8）：任何 fs 错误转为
 *   `Error("run log write failed: <原因.message>", { cause })`——本文件只产生
 *   错误，不改写错误可见面（cause 保留原始 fs 错误）。
 */
export function createJsonlLogger(opts: {
	dir: string;
	runId: string;
	ts: number;
}): RunLogger {
	const runDir = join(opts.dir, `${formatLogTimestamp(opts.ts)}-${opts.runId}`);
	const filePath = join(runDir, "run.jsonl");

	const wrap = (error: unknown): Error =>
		new Error(
			`run log write failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ cause: error },
		);

	return {
		/** 建目录 + 建空文件：目录不可写在首个事件之前就抛（不留到写事件时）。 */
		onRunStart() {
			try {
				mkdirSync(runDir, { recursive: true });
				appendFileSync(filePath, "");
			} catch (error) {
				throw wrap(error);
			}
		},
		/** 一行一个事件：`JSON.stringify(event) + "\n"`（D9）。 */
		onEvent(event) {
			try {
				appendFileSync(filePath, `${JSON.stringify(event)}\n`);
			} catch (error) {
				throw wrap(error);
			}
		},
		onRunFinish() {
			// 无状态实现：每次 append 自带开关，没有需要收尾的文件句柄。
		},
	};
}
