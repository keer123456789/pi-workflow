/**
 * 内存事件发射器（设计 §8）：RunEvent 的 seq 分配 + 双路分发（onEvent / 日志 sink）。
 *
 * - 分配全局单调递增的 eventSeq（run 内首个事件为 1——设计 §8.1 的样例从 0 起，
 *   编号只需全局单调即可，起点差异已 park 给 final review）；
 * - 补齐 `ts`（注入 clock）与 `runId`——引擎只提供事件主体；
 * - 分发保持**完成序**（实时性优先，§8.1）：不缓冲、不重排、同步回调；
 *   需要全序的消费者用事件自带的 seq 重排；
 * - **监听器异常策略（T10，不变）**：onEvent 是调用方代码，它的 bug 既不改变状态机、
 *   也不吞掉后续事件——捕获并记住首个错误，run 结束后由引擎统一报告；
 * - **第二 sink（Task 3，D7/D8）**：run 日志的 `onLogEvent`。与 onEvent 同序、拿
 *   **同一个**事件对象；钩子异常**不属于**监听器 bug——emitter 不捕获、不归类，
 *   由引擎在 sink 内实现 D8 策略（fail/warn），两条通道互不干扰；
 * - **事件变换（Task 3，D7）**：可选的 `transform` 在**两个 sink 之前**对每个事件
 *   恰好执行一次——hash 脱敏只需一次，两路拿同一个结果对象（§8.1）；
 * - 纯内存、无 I/O：JSONL 落盘在 log/runlog.ts（引擎负责接线与失败策略）。
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
	/** 分配 seq 并同步分发给两路 sink（未配置的 sink 直接跳过，见实现注释）。 */
	emit(event: RunEventInput): void;
	/**
	 * 首个 onEvent 监听器错误（T10）：`threw === false` 表示没有监听器抛过错。
	 * `error` 本体是任意 thrown 值（连 `throw undefined` 也能与"没抛"区分），
	 * 由引擎在 run_finished 之后决定如何报告（见 engine.ts 的策略注释）。
	 */
	listenerError(): { threw: boolean; error: unknown };
};

export function createEmitter(opts: {
	clock: () => number;
	runId: string;
	onEvent?: (event: RunEvent) => void;
	/**
	 * 第二 sink（Task 3）：日志的 `onEvent`。与 onEvent 同序、拿同一个事件对象；
	 * 异常由**引擎**（D8 策略）在 sink 内部消化——emitter 不捕获、不归类，
	 * 两条通道的失败语义因此互不污染。
	 */
	onLogEvent?: (event: RunEvent) => void;
	/**
	 * 事件变换（Task 3，D7）：hash 脱敏等"两路都要"的改写在这里做一次；
	 * 未配置时事件原样分发。返回的对象同时交给两个 sink。
	 */
	transform?: (event: RunEvent) => RunEvent;
}): RunEmitter {
	let seq = 0;
	let listenerThrew = false;
	let listenerError: unknown;
	return {
		emit(event) {
			// 即便没有监听者也要分配 seq：事件编号与"谁在消费"无关，
			// 保证任何消费者（onEvent、日志）看到的编号一致。
			seq += 1;
			const full = {
				...event,
				seq,
				ts: opts.clock(),
				runId: opts.runId,
			} as RunEvent;
			// 变换只做一次：两个 sink 拿到同一个对象（D7"两路都见脱敏值"的机制保证）
			const delivered =
				opts.transform === undefined ? full : opts.transform(full);
			// onEvent 先送：监听器看到的与 M1 完全一致（日志失败的副作用——如中止 run——
			// 不插进监听器的观察窗口）；日志 sink 后送，其失败只走引擎的 D8 策略。
			if (opts.onEvent !== undefined) {
				try {
					opts.onEvent(delivered);
				} catch (error) {
					// 监听器是调用方代码：抛错不改变状态机，也不吞掉后续事件（每个事件照常投递）。
					// 只记住首个错误——后续抛错是同一 bug 的重复，噪音无益。
					if (!listenerThrew) {
						listenerThrew = true;
						listenerError = error;
					}
				}
			}
			opts.onLogEvent?.(delivered);
		},
		listenerError: () => ({ threw: listenerThrew, error: listenerError }),
	};
}
