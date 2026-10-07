/**
 * Task 7：模板插值（设计 §5.6）。
 *
 * 契约（brief + 裁定 R16 + 未规定形状的固化）：
 * - `{key}` / `{a.b.c}` 从 input 按点分路径解析（逐级 own-property 检查）；缺失 → `TemplateError{key, template}`；
 * - 非字符串值 → `JSON.stringify`；字符串值原样（不加引号）；`null` → `"null"`（R16）；
 * - 路径最终值为 `undefined`（属性存在但值是 undefined，R16）→ `TemplateError`，不输出 `"undefined"`；
 * - 任一级不是对象 → 视为缺失 → `TemplateError`（逐级 hasOwnProperty，不用可选链吞成 undefined）；
 * - `{{` / `}}` → 字面花括号；
 * - 未配对的单个 `{` / `}`（无闭合）→ 按字面输出（固化行为，防止漂移）；
 * - key 原样取用、不 trim：`{ clause }` 的 key 是 `" clause "`；`{}` 的 key 是 `""`；
 * - 字面带点的 key 不可达：`{a.b}` 走 a → b 路径，从不查 `"a.b"` 这个键本身。
 */

import { describe, expect, it } from "vitest";

import { TemplateError } from "../src/core/errors.js";
import { interpolate } from "../src/template.js";

/** 捕获 fn 抛出的值；未抛出则让测试失败。 */
function captureThrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (thrown) {
		return thrown;
	}
	throw new Error("expected the function to throw, but it returned normally");
}

/** 断言 fn 抛出 TemplateError 并返回它，便于继续断言字段。 */
function captureTemplateError(fn: () => unknown): TemplateError {
	const thrown = captureThrown(fn);
	expect(thrown).toBeInstanceOf(TemplateError);
	return thrown as TemplateError;
}

describe("interpolate: 基本替换", () => {
	it("replaces {key} with the input value", () => {
		expect(interpolate("审阅 {clause}。", { clause: "第三条" })).toBe(
			"审阅 第三条。",
		);
	});

	it("uses string values as-is (no JSON quoting)", () => {
		expect(interpolate("{name}", { name: '张三 "法务"' })).toBe('张三 "法务"');
	});

	it("substitutes every placeholder in one template, left to right", () => {
		expect(interpolate("{a} 与 {b} 与 {a}", { a: "甲", b: "乙" })).toBe(
			"甲 与 乙 与 甲",
		);
	});

	it("returns an empty string for an empty template", () => {
		expect(interpolate("", { clause: "x" })).toBe("");
	});

	it("returns a template without placeholders unchanged", () => {
		expect(interpolate("plain text", {})).toBe("plain text");
	});
});

describe("interpolate: 嵌套路径", () => {
	it("resolves a dotted path by walking the input", () => {
		const input = { doc: { meta: { title: "合同" } } };
		expect(interpolate("{doc.meta.title}", input)).toBe("合同");
	});

	it("does not resolve inherited properties (own-property check at each level)", () => {
		const error = captureTemplateError(() => interpolate("{toString}", {}));
		expect(error.key).toBe("toString");
	});

	it("does not resolve inherited properties on an intermediate level", () => {
		const error = captureTemplateError(() =>
			interpolate("{a.constructor.name}", { a: {} }),
		);
		expect(error.key).toBe("a.constructor.name");
	});

	it("resolves an array index path ({items.0}) — indices are own properties (Minor 9/R25)", () => {
		expect(interpolate("{items.0}", { items: ["a", "b"] })).toBe("a");
	});
});

describe("interpolate: 缺失 key 抛 TemplateError", () => {
	it("throws with key = the placeholder as written and the original template", () => {
		const template = "审阅 {clause} 并给出结论";
		const error = captureTemplateError(() =>
			interpolate(template, { other: 1 }),
		);
		expect(error).toBeInstanceOf(TemplateError);
		expect(error.key).toBe("clause");
		expect(error.template).toBe(template);
		expect(error.message).toBe('missing key "clause" in template');
	});

	it("reports the full dot-path as written, not the last segment", () => {
		const error = captureTemplateError(() =>
			interpolate("{doc.title}", { doc: {} }),
		);
		expect(error.key).toBe("doc.title");
	});

	it("throws when the top-level input is not an object", () => {
		const error = captureTemplateError(() => interpolate("{a}", 42));
		expect(error.key).toBe("a");
	});

	it("throws when the input is null or undefined", () => {
		expect(captureTemplateError(() => interpolate("{a}", null)).key).toBe("a");
		expect(captureTemplateError(() => interpolate("{a}", undefined)).key).toBe(
			"a",
		);
	});
});

describe("interpolate: 非字符串值 JSON.stringify", () => {
	it("stringifies arrays", () => {
		expect(
			interpolate("风险：{riskReports}", { riskReports: ["r1", "r2"] }),
		).toBe('风险：["r1","r2"]');
	});

	it("stringifies objects", () => {
		expect(interpolate("{meta}", { meta: { a: 1, b: null } })).toBe(
			'{"a":1,"b":null}',
		);
	});

	it("stringifies numbers and booleans", () => {
		expect(interpolate("{n}/{b}", { n: 1.5, b: false })).toBe("1.5/false");
	});

	it("renders null as null (R16: only undefined is unpresentable)", () => {
		expect(interpolate("{x}", { x: null })).toBe("null");
	});
});

describe("interpolate: 花括号转义", () => {
	it("turns {{literal}} into the literal {literal} (the key is not interpolated)", () => {
		expect(interpolate("{{literal}}", { literal: "SHOULD NOT APPEAR" })).toBe(
			"{literal}",
		);
	});

	it("turns }} into a literal }", () => {
		expect(interpolate("a}}b", {})).toBe("a}b");
	});

	it("escapes a trailing {{ at the end of the template (Minor 9/R25)", () => {
		// 尾部转义：`{{` 在模板末尾也按字面 `{` 输出（单遍扫描命中即转义，不看后继）
		expect(interpolate("x{{", {})).toBe("x{");
	});

	it("mixes escapes with placeholders", () => {
		expect(interpolate("{{{clause}}}", { clause: "第三条" })).toBe("{第三条}");
	});

	it("closes a placeholder on the first } — a following } is literal, not an escape", () => {
		// 固化：单遍扫描下 `}}` 只在扫描位置命中时才当转义；占位符的闭合 `}` 优先级更高，
		// 因此 `{clause}}` 是「插值后的值 + 字面 }」，而不是把 `}}` 吃掉变成字面 `{clause}`。
		expect(interpolate("{clause}}", { clause: "第三条" })).toBe("第三条}");
		expect(interpolate("{clause}}}", { clause: "第三条" })).toBe("第三条}");
	});
});

describe("interpolate: R16 — 值为 undefined 抛错", () => {
	it("throws when the property exists but its value is undefined", () => {
		const template = "{clause}";
		const error = captureTemplateError(() =>
			interpolate(template, { clause: undefined }),
		);
		expect(error).toBeInstanceOf(TemplateError);
		expect(error.key).toBe("clause");
		expect(error.template).toBe(template);
		expect(error.message).toContain("undefined");
	});

	it("throws when the final segment of a nested path is undefined", () => {
		const error = captureTemplateError(() =>
			interpolate("{a.b}", { a: { b: undefined } }),
		);
		expect(error.key).toBe("a.b");
	});
});

describe("interpolate: 中间层级不是对象 → 缺失", () => {
	it("throws when an intermediate level is a primitive", () => {
		const error = captureTemplateError(() => interpolate("{a.b}", { a: 5 }));
		expect(error.key).toBe("a.b");
	});

	it("throws when an intermediate level is null", () => {
		const error = captureTemplateError(() => interpolate("{a.b}", { a: null }));
		expect(error.key).toBe("a.b");
	});

	it("throws when an intermediate level is a string", () => {
		const error = captureTemplateError(() =>
			interpolate("{a.b.c}", { a: { b: "leaf" } }),
		);
		expect(error.key).toBe("a.b.c");
	});
});

describe("interpolate: 未配对花括号（固化行为：原样输出）", () => {
	it("passes an unmatched single { through literally", () => {
		expect(interpolate("a { b", {})).toBe("a { b");
		expect(interpolate("{", {})).toBe("{");
		expect(interpolate("{unclosed", {})).toBe("{unclosed");
	});

	it("passes an unmatched single } through literally", () => {
		expect(interpolate("a } b", {})).toBe("a } b");
		expect(interpolate("}", {})).toBe("}");
		expect(interpolate("closed}", {})).toBe("closed}");
	});

	it("keeps the key text as written, without trimming", () => {
		const error = captureTemplateError(() =>
			interpolate("{ clause }", { clause: "x" }),
		);
		expect(error.key).toBe(" clause ");
	});

	it("treats {} as a placeholder with the empty key", () => {
		const error = captureTemplateError(() =>
			interpolate("{}", { clause: "x" }),
		);
		expect(error.key).toBe("");
	});
});

describe("interpolate: 点分路径 vs 字面带点的 key", () => {
	it('{a.b} walks a → b; a literal "a.b" property is never consulted', () => {
		const error = captureTemplateError(() =>
			interpolate("{a.b}", { "a.b": 1 }),
		);
		expect(error.key).toBe("a.b");
	});
});

describe("interpolate: 不修改 input", () => {
	it("leaves the input untouched", () => {
		const input = { doc: { tags: ["a", "b"], meta: { n: 1 } }, extra: null };
		const snapshot = structuredClone(input);
		expect(interpolate("{doc} {doc.tags} {doc.meta}", input)).toBe(
			'{"tags":["a","b"],"meta":{"n":1}} ["a","b"] {"n":1}',
		);
		expect(input).toEqual(snapshot);
	});
});
