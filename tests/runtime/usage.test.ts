/**
 * M4/T1：共享 usage 映射（D21 零填）的单测——实现自 pi-subprocess.ts 逐字平移到
 * `src/runtime/usage.ts`，行为逐字不变（pi-subprocess 与 M4/T2 的 pi sdk 适配器共用）。
 *
 * 覆盖口径（计划 Task 1 Step 3）：全键直取 / 缺键与非有限数值 0 填 / cost 有无 /
 * 多余键（pi 独有的 cacheWrite1h/reasoning/raw*）不转发。
 */

import { describe, expect, it } from "vitest";

import { toTokenUsage } from "../../src/runtime/usage.js";

describe("toTokenUsage (D21 零填映射，M4/T1 平移)", () => {
	it("copies the five counts and a full cost object when every key is present", () => {
		const usage = toTokenUsage({
			input: 11,
			output: 22,
			cacheRead: 33,
			cacheWrite: 44,
			totalTokens: 66,
			cost: {
				input: 0.001,
				output: 0.002,
				cacheRead: 0.003,
				cacheWrite: 0.004,
				total: 0.01,
			},
		});

		expect(usage).toEqual({
			input: 11,
			output: 22,
			cacheRead: 33,
			cacheWrite: 44,
			totalTokens: 66,
			cost: {
				input: 0.001,
				output: 0.002,
				cacheRead: 0.003,
				cacheWrite: 0.004,
				total: 0.01,
			},
		});
	});

	it("zero-fills missing and non-finite counts (D21: pi 的 usage 键集可变)", () => {
		// 缺失的数字键以 0 填，已有的照直取；空对象 → 全 0。
		expect(toTokenUsage({ input: 7, totalTokens: 7 })).toEqual({
			input: 7,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 7,
		});
		expect(toTokenUsage({})).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
		});

		// 非有限数值（NaN/Infinity）与非数字类型同属"不可信计数"→ 0 填
		// （countOf 的 typeof number + isFinite 判定）。
		expect(
			toTokenUsage({
				input: Number.NaN,
				output: Number.POSITIVE_INFINITY,
				cacheRead: 1,
				cacheWrite: "3",
				totalTokens: null,
			}),
		).toEqual({
			input: 0,
			output: 0,
			cacheRead: 1,
			cacheWrite: 0,
			totalTokens: 0,
		});
	});

	it("keeps cost only when the source carries it as an object (absent/null → no cost key)", () => {
		// 源没有 cost（自定义网关可以不报）→ 结果连 cost 键都没有。
		const bare = toTokenUsage({
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
		});
		expect("cost" in bare).toBe(false);

		// cost 不是对象（null/数字）→ 同样不进结果（只在对象形态转发）。
		expect("cost" in toTokenUsage({ input: 1, output: 2, cost: null })).toBe(
			false,
		);
		expect("cost" in toTokenUsage({ input: 1, output: 2, cost: 0.5 })).toBe(
			false,
		);

		// cost 内部缺键 → cost 内部同样 0 填。
		const partialCost = toTokenUsage({
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { total: 0.5 },
		});
		expect(partialCost.cost).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0.5,
		});
	});

	it("does not forward pi-only extras (cacheWrite1h/reasoning/raw*) — TokenUsage 形状即口径", () => {
		const usage = toTokenUsage({
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			cacheWrite1h: 5,
			reasoning: 6,
			rawInput: 7,
			rawOutput: 8,
			totalTokens: 10,
		});

		expect(Object.keys(usage)).toEqual([
			"input",
			"output",
			"cacheRead",
			"cacheWrite",
			"totalTokens",
		]);
	});
});
