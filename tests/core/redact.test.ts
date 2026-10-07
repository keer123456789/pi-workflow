/**
 * Task 3：hash 脱敏纯函数（设计 §8.1、D7）。
 *
 * 契约：
 * - `hashValue`：`"sha256:<64位小写hex>"`，摘要输入 = `JSON.stringify(value)`；
 * - stringify 抛错（循环引用 / BigInt / 抛错的 toJSON）或产出 `undefined`
 *   （undefined / 函数 / Symbol 没有 JSON 表示）时，对**字面量** `"[unserializable]"`
 *   取哈希（D7）——脱敏不因为怪值崩掉；
 * - `redactEvent`：`run_started.input`、`node_started.input`（字段存在时；RunEvent 当前
 *   不携带）、`node_finished.output` → hash 字符串；其余事件**原样返回同一个对象**；
 * - 非破坏性：入参事件不被原地修改（浅拷贝后替换目标字段）。
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hashValue, redactEvent } from "../../src/core/redact.js";
import type { RunEvent } from "../../src/core/types.js";

/** 独立参照实现（不复用被测代码）：D7 的公式直写。 */
function sha256(text: string): string {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** D7 的替代字面量（stringify 抛错/无产出时的摘要输入）。 */
const UNKNOWN = sha256("[unserializable]");

describe("hashValue (D7)", () => {
	it("hashes JSON.stringify(value) into sha256:<64 lowercase hex>", () => {
		expect(hashValue({ question: "42?", n: [1, 2] })).toBe(
			sha256('{"question":"42?","n":[1,2]}'),
		);
		// 字符串走 JSON 编码（含引号），不是裸文本
		expect(hashValue("abc")).toBe(sha256('"abc"'));
		expect(hashValue("abc")).toMatch(/^sha256:[0-9a-f]{64}$/);
		// 同一个值稳定、不同值不同（含 undefined 与 null 的区别）
		expect(hashValue({ a: 1 })).toBe(hashValue({ a: 1 }));
		expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
		expect(hashValue(undefined)).toBe(UNKNOWN);
		expect(hashValue(null)).not.toBe(UNKNOWN);
	});

	it("falls back to the literal [unserializable] when stringify throws or yields nothing", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		// 抛错：循环引用 / BigInt
		expect(hashValue(circular)).toBe(UNKNOWN);
		expect(hashValue(10n)).toBe(UNKNOWN);
		// 产出 undefined：函数 / Symbol / undefined（JSON.stringify 的合法返回值）
		expect(hashValue(() => {})).toBe(UNKNOWN);
		expect(hashValue(Symbol("s"))).toBe(UNKNOWN);
		// 替代字面量对"字面量本身"与"真正的怪值"是同一摘要（都是 sha256("[unserializable]")）
		expect(UNKNOWN).toBe(
			`sha256:${createHash("sha256").update("[unserializable]").digest("hex")}`,
		);
	});
});

describe("redactEvent (D7)", () => {
	it("redacts run_started.input without touching other fields or the input object", () => {
		const input = { question: "机密", nested: { n: 1 } };
		const event: RunEvent = {
			seq: 1,
			superstep: 0,
			ts: 11,
			runId: "r1",
			type: "run_started",
			graph: "g",
			input,
		};

		const redacted = redactEvent(event) as Extract<
			RunEvent,
			{ type: "run_started" }
		>;

		expect(redacted.input).toBe(sha256(JSON.stringify(input)));
		// 其余字段逐一保留
		expect(redacted).toEqual({ ...event, input: redacted.input });
		// 非破坏性：原事件仍持有原对象
		expect((event as { input: unknown }).input).toBe(input);
	});

	it("redacts node_finished.output and keeps usage / durationMs", () => {
		const output = { draft: "全文" };
		const event: RunEvent = {
			seq: 9,
			superstep: 2,
			ts: 5,
			runId: "r1",
			type: "node_finished",
			node: "review",
			instanceId: "review#7",
			output,
			usage: {
				input: 1000,
				output: 234,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1234,
			},
			durationMs: 4200,
		};

		const redacted = redactEvent(event) as Extract<
			RunEvent,
			{ type: "node_finished" }
		>;

		expect(redacted.output).toBe(sha256(JSON.stringify(output)));
		expect(redacted.usage).toEqual(event.usage);
		expect(redacted.durationMs).toBe(4200);
		expect((event as { output: unknown }).output).toBe(output);
	});

	it("redacts node_started.input when the field is present, and passes it through otherwise", () => {
		const base: RunEvent = {
			seq: 2,
			superstep: 1,
			ts: 3,
			runId: "r1",
			type: "node_started",
			node: "a",
			instanceId: "a#1",
			kind: "fn",
		};

		// RunEvent 的 node_started 当前不带 input：原样返回（同一个对象，不产生拷贝）
		expect(redactEvent(base)).toBe(base);

		// 字段存在时（事件形状将来增补该字段）同样脱敏——D7 按字段名约束
		const withInput = { ...base, input: { secret: 1 } } as unknown as RunEvent;
		const redacted = redactEvent(withInput) as Extract<
			RunEvent,
			{ type: "node_started" }
		> & { input: unknown };
		expect(redacted.input).toBe(sha256(JSON.stringify({ secret: 1 })));
		expect(redacted.type).toBe("node_started");
		expect(redacted.instanceId).toBe("a#1");
		expect((withInput as { input: unknown }).input).toEqual({ secret: 1 });
	});

	it("returns non-sensitive events unchanged (same object)", () => {
		const committed: RunEvent = {
			seq: 4,
			superstep: 1,
			ts: 6,
			runId: "r1",
			type: "superstep_committed",
		};
		const finished: RunEvent = {
			seq: 5,
			superstep: 1,
			ts: 7,
			runId: "r1",
			type: "run_finished",
			status: "completed",
			durationMs: 3,
		};
		const failed: RunEvent = {
			seq: 6,
			superstep: 1,
			ts: 8,
			runId: "r1",
			type: "node_failed",
			node: "a",
			instanceId: "a#1",
			error: "boom",
		};

		expect(redactEvent(committed)).toBe(committed);
		expect(redactEvent(finished)).toBe(finished);
		expect(redactEvent(failed)).toBe(failed);
	});
});
