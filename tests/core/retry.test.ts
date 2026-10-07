/**
 * Task 5：重试分类（设计 §7.2 落地、D3）。
 *
 * 契约：
 * - `isRetryableError(error)`（**内部** API，不进公开面——Task 6 的 llm 节点与引擎消费）：
 *   D3 判定 = ① `markRetryable()` 打的非枚举 Symbol 标记；② `error.code === "ECONNRESET"`；
 *   ③ 消息正则族（429/408/5xx 要求**数字边界**——"1408" 不因粘连命中 "408"；rate limit /
 *   too many requests / timeout / timed out / ECONNRESET / socket hang up）。
 *   非 Error 抛值按引擎渲染口径取文本（对象走 JSON.stringify，与 node_failed 的可见消息一致）；
 * - `markRetryable(error)`：打标并**原样返回同一实例**；标记是 Symbol 且非枚举——
 *   JSON.stringify / Object.keys / 事件载荷都看不到（D3："非枚举 Symbol"）；
 * - 引擎（§7.2 落地）：不可重试失败**立即失败**（恰好 1 次尝试、0 条 node_retry、不退避）；
 *   可重试失败照旧用满 maxAttempts 并逐次发 node_retry；引擎自身 attempt 超时消息含
 *   "timed out" → 保持可重试（§7.3："超时 = 可重试失败"）。
 */

import { describe, expect, it } from "vitest";

import { NodeExecutionError } from "../../src/core/errors.js";
import { StateGraph } from "../../src/core/graph.js";
import { isRetryableError, markRetryable } from "../../src/core/retry.js";
import {
	END,
	type NodeDefinition,
	type RunEvent,
	START,
} from "../../src/core/types.js";

type S = { v?: number };

/** 取指定 type 的事件（带类型收窄）。 */
function ofType<T extends RunEvent["type"]>(
	events: readonly RunEvent[],
	type: T,
): Extract<RunEvent, { type: T }>[] {
	return events.filter((event) => event.type === type) as Extract<
		RunEvent,
		{ type: T }
	>[];
}

/** 运行并交出 rejection 的错误本体（断言错误字段用）。 */
async function captureRejection(
	runPromise: Promise<unknown>,
): Promise<unknown> {
	try {
		await runPromise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the run to reject, but it resolved");
}

/**
 * 带 retry 配置的手搓 fn 定义（fnNode 不暴露 retry——§7.1 说 fn 不自动重试；
 * 这里直接观察引擎的失败分支本身）。handler 抛什么由用例决定。
 */
function retryingFn(
	handler: NodeDefinition<S>["handler"],
	cfg?: { maxAttempts?: number; timeoutMs?: number },
): NodeDefinition<S> {
	return {
		kind: "fn",
		name: "",
		handler,
		retry: { maxAttempts: cfg?.maxAttempts ?? 3 },
		timeoutMs: cfg?.timeoutMs,
	};
}

/** START → a → END 的最小图。 */
function single(node: NodeDefinition<S>): StateGraph<S> {
	return new StateGraph<S>()
		.addNode("a", node)
		.addEdge(START, "a")
		.addEdge("a", END);
}

/** 记录退避请求的注入服务（random 固定 0.5：退避 250、500、…可精确断言）。 */
function recordingServices(): {
	services: { sleep: (ms: number) => Promise<void>; random: () => number };
	sleeps: number[];
} {
	const sleeps: number[] = [];
	return {
		sleeps,
		services: {
			sleep: (ms: number) => {
				sleeps.push(ms);
				return Promise.resolve();
			},
			random: () => 0.5,
		},
	};
}

describe("isRetryableError (D3 分类)", () => {
	// D3 逐字表的每一行：消息族正例 / 反例 + 数字边界 + code + 标记
	const CASES: readonly [label: string, error: unknown, expected: boolean][] = [
		["429 rate limit", new Error("429 rate limit"), true],
		["HTTP 503", new Error("HTTP 503"), true],
		["timeout", new Error("timeout"), true],
		["socket hang up", new Error("socket hang up"), true],
		[
			'code "ECONNRESET"',
			Object.assign(new Error("connection reset by peer"), {
				code: "ECONNRESET",
			}),
			true,
		],
		["boom", new Error("boom"), false],
		["1408（数字粘连不得命中 408）", new Error("1408"), false],
	];

	for (const [label, error, expected] of CASES) {
		it(`classifies ${label} as ${expected ? "retryable" : "not retryable"}`, () => {
			expect(isRetryableError(error)).toBe(expected);
		});
	}

	it("classifies a marked error as retryable even when its message is not", () => {
		expect(isRetryableError(markRetryable(new Error("boom")))).toBe(true);
	});

	it("keeps the engine's own attempt-timeout message in the retryable family", () => {
		// 引擎超时的逐字形状（engine.ts 的 makeTimeoutError）：含 "timed out" → 天然可重试
		expect(
			isRetryableError(
				new Error('node "a" (a#1) attempt 1 timed out after 100ms'),
			),
		).toBe(true);
	});

	it("classifies non-Error thrown values by the engine's rendering", () => {
		// handler 允许抛非 Error（引擎 messageOf：对象走 JSON.stringify、其余 String()）——
		// 分类与 node_failed 的可见消息同口径
		expect(isRetryableError({ code: 429 })).toBe(true);
		expect(isRetryableError("socket hang up")).toBe(true);
		expect(isRetryableError({ code: "boom" })).toBe(false);
	});
});

describe("markRetryable (D3 标记)", () => {
	it("marks and returns the same instance", () => {
		const error = new Error("boom");
		expect(markRetryable(error)).toBe(error);
	});

	it("uses a non-enumerable Symbol flag invisible to JSON and key enumeration", () => {
		const error = markRetryable(new Error("boom"));

		// 日志 / JSON / 事件载荷永远看不到标记（D3：非枚举 Symbol）
		expect(JSON.stringify(error)).toBe("{}");
		expect(Object.keys(error)).toEqual([]);
		const symbols = Object.getOwnPropertySymbols(error);
		expect(symbols).toHaveLength(1);
		expect(Object.getOwnPropertyDescriptor(error, symbols[0])?.enumerable).toBe(
			false,
		);
	});

	it("is idempotent", () => {
		const error = markRetryable(new Error("boom"));
		expect(markRetryable(error)).toBe(error);
		expect(isRetryableError(error)).toBe(true);
	});
});

describe("engine fail-fast / retry classification (设计 §7.2 落地)", () => {
	it("fails fast on a non-retryable error: exactly one attempt, no node_retry, no backoff", async () => {
		const { services, sleeps } = recordingServices();
		const events: RunEvent[] = [];
		const boom = new Error("boom");
		let attempts = 0;

		const graph = single(
			retryingFn(() => {
				attempts += 1;
				throw boom;
			}),
		);

		const error = await captureRejection(
			graph.compile({ services }).run({}, { onEvent: (e) => events.push(e) }),
		);

		expect(attempts).toBe(1); // 不可重试：不再有第 2 次尝试
		expect(sleeps).toEqual([]); // 不退避
		expect(ofType(events, "node_retry")).toEqual([]); // 不发 node_retry
		expect(ofType(events, "node_failed")).toHaveLength(1);
		expect(error).toBeInstanceOf(NodeExecutionError);
		expect((error as NodeExecutionError).cause).toBe(boom);
	});

	it("retries a retryable error: 3 attempts, 2 node_retry events", async () => {
		const { services, sleeps } = recordingServices();
		const events: RunEvent[] = [];
		const boom = new Error("429 rate limit");
		let attempts = 0;

		const graph = single(
			retryingFn(() => {
				attempts += 1;
				throw boom;
			}),
		);

		const error = await captureRejection(
			graph.compile({ services }).run({}, { onEvent: (e) => events.push(e) }),
		);

		expect(attempts).toBe(3); // maxAttempts = 总尝试次数（含首次）
		expect(sleeps).toEqual([250, 500]); // 500*2^0*0.5、500*2^1*0.5
		expect(ofType(events, "node_retry").map((e) => e.attempt)).toEqual([1, 2]);
		expect(error).toBeInstanceOf(NodeExecutionError);
		expect((error as NodeExecutionError).cause).toBe(boom);
	});

	it("retries an error carrying the markRetryable flag even without a retryable message", async () => {
		const { services } = recordingServices();
		const events: RunEvent[] = [];
		let attempts = 0;

		const graph = single(
			retryingFn(() => {
				attempts += 1;
				if (attempts === 1) {
					throw markRetryable(new Error("schema violation"));
				}
				return { v: 2 };
			}),
		);

		const { state } = await graph
			.compile({ services })
			.run({}, { onEvent: (e) => events.push(e) });

		expect(state.v).toBe(2);
		expect(attempts).toBe(2);
		expect(ofType(events, "node_retry")).toHaveLength(1);
	});

	it("keeps the engine's attempt-timeout error retryable (timed out family)", async () => {
		// 引擎自身的超时判定（非节点抛错）：超时 = 可重试失败（§7.3）——
		// 若分类误判为不可重试，这里会退化成 1 次尝试、0 条 node_retry。
		const { services, sleeps } = recordingServices();
		const events: RunEvent[] = [];
		let attempts = 0;

		const graph = single(
			retryingFn(
				() => {
					attempts += 1;
					return new Promise<Partial<S>>(() => {}); // 永不 settle：超时分支收尾
				},
				{ maxAttempts: 2, timeoutMs: 100 },
			),
		);

		const error = await captureRejection(
			graph.compile({ services }).run({}, { onEvent: (e) => events.push(e) }),
		);

		expect(attempts).toBe(2); // 第 1 次超时 → 重试；第 2 次超时 → 耗尽失败
		expect(sleeps).toEqual([100, 250, 100]); // 超时定时器、退避、超时定时器
		expect(ofType(events, "node_retry")).toHaveLength(1);
		expect(error).toBeInstanceOf(NodeExecutionError);
		expect((error as NodeExecutionError).message).toContain("timed out");
	});
});
