/**
 * 内存事件发射器（设计 §8）：RunEvent 的 seq 分配 + onEvent 分发。
 *
 * - 分配全局单调递增的 eventSeq（run 内首个事件为 1）；
 * - 补齐 `ts`（注入 clock）与 `runId`——引擎只提供事件主体；
 * - 分发保持**完成序**（实时性优先，§8.1）：不缓冲、不重排、同步回调；
 *   需要全序的消费者用事件自带的 seq 重排；
 * - 纯内存、无 I/O：JSONL 落盘是后续任务（log/runlog.ts）。
 */

import type { RunEvent } from "../core/types.js";

/** 分配式 Omit：联合类型的每个成员各去掉自己身上的 key（普通 Omit 会把联合压扁）。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;

/**
 * onEvent 的入参：事件主体，`seq`/`ts`/`runId` 由发射器补。
 * 例：`{ type: "node_started", superstep: 1, node: "a", instanceId: "a#1", kind: "fn" }`。
 */
export type RunEventInput = DistributiveOmit<RunEvent, "seq" | "ts" | "runId">;

export type RunEmitter = {
	/** 分配 seq 并同步分发给 onEvent（未配置 onEvent 时只分配 seq，见实现注释）。 */
	emit(event: RunEventInput): void;
};

export function createEmitter(opts: {
	clock: () => number;
	runId: string;
	onEvent?: (event: RunEvent) => void;
}): RunEmitter {
	let seq = 0;
	return {
		emit(event) {
			// 即便没有监听者也要分配 seq：事件编号与"谁在消费"无关，
			// 保证任何消费者（onEvent、日后的 JSONL）看到的编号一致。
			seq += 1;
			opts.onEvent?.({
				...event,
				seq,
				ts: opts.clock(),
				runId: opts.runId,
			} as RunEvent);
		},
	};
}
