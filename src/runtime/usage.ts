/**
 * 共享 usage 映射（D21；M4/T1 自 pi-subprocess.ts 逐字平移）。
 *
 * `src/runtime/` 是适配器的**物理隔离区**：本模块是无 I/O 的纯映射——D21 的零填
 * 口径（数字键缺失/非有限以 0 填、`cost` 仅源有才带、pi 独有的 `cacheWrite1h` 等
 * 不转发）由 pi-subprocess（M3）与 pi sdk 适配器（M4/T2）共用，两边行为必须逐字
 * 一致（D29）。llm-pi-ai.ts 不复用它：其直取版语义独立（pi-ai 类型有保证的完整
 * usage，见"预裁定例外"）。
 */

import type { TokenUsage } from "./executor.js";

/** 数字键缺失/非有限数值以 0 填（D21：pi 的 usage 键集可变，M0 ④.3）。 */
function countOf(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * usage 映射（D21）：只带 D4 的五个计数；`cost` **只在源 usage 有 cost 时**进结果；
 * pi 独有的 `cacheWrite1h`/`raw*`/`reasoning` 不转发；usage 对象整体缺失 → 调用方
 * 不带 usage 字段（由调用方的存在性判断负责）。
 */
export function toTokenUsage(raw: Record<string, unknown>): TokenUsage {
	const mapped: TokenUsage = {
		input: countOf(raw, "input"),
		output: countOf(raw, "output"),
		cacheRead: countOf(raw, "cacheRead"),
		cacheWrite: countOf(raw, "cacheWrite"),
		totalTokens: countOf(raw, "totalTokens"),
	};
	const cost = raw.cost;
	if (typeof cost === "object" && cost !== null) {
		mapped.cost = {
			input: countOf(cost as Record<string, unknown>, "input"),
			output: countOf(cost as Record<string, unknown>, "output"),
			cacheRead: countOf(cost as Record<string, unknown>, "cacheRead"),
			cacheWrite: countOf(cost as Record<string, unknown>, "cacheWrite"),
			total: countOf(cost as Record<string, unknown>, "total"),
		};
	}
	return mapped;
}
