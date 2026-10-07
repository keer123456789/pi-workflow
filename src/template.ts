/**
 * 模板插值（设计 §5.6）：纯逻辑 leaf 模块（无 I/O、无 pi 依赖）。
 *
 * 规则：
 * - `{key}` / `{a.b.c}` 从 input 按点分路径解析（逐级 own-property 检查）；
 *   key 原样取用（不 trim），缺失即抛 `TemplateError`（不静默 undefined）；
 * - 路径最终值为 `undefined`（属性存在但值为 undefined，裁定 R16）→ `TemplateError`；
 * - 非字符串值 → `JSON.stringify`；字符串值原样（不加引号）；`null` → `"null"`；
 * - `{{` / `}}` → 字面 `{` / `}`；未配对的单个 `{` / `}` 按字面输出。
 *
 * 单遍扫描：每个位置先匹配 `{{` / `}}`（转义优先），否则单个 `{` 开启占位符，
 * 取其后的第一个 `}` 为界；找不到闭合 `}` 时该 `{` 按字面输出。
 */

import { TemplateError } from "./core/errors.js";

/** 缺失 key：不静默 undefined。 */
function missingKey(path: string, template: string): TemplateError {
	return new TemplateError(`missing key "${path}" in template`, {
		template,
		key: path,
	});
}

/** 按点分路径取值；任一级不是对象 / 无该 own property / 最终值为 undefined → TemplateError。 */
function resolvePath(input: unknown, path: string, template: string): unknown {
	let current: unknown = input;
	for (const segment of path.split(".")) {
		if (current === null || typeof current !== "object") {
			throw missingKey(path, template);
		}
		// 逐级 hasOwnProperty 语义（Object.hasOwn）：不沿原型链取，
		// 也不用可选链把缺失吞成 undefined。
		if (!Object.hasOwn(current, segment)) {
			throw missingKey(path, template);
		}
		current = (current as Record<string, unknown>)[segment];
	}
	if (current === undefined) {
		// R16：`JSON.stringify(undefined)` 不是字符串，无法插值 → 与缺失同等处理。
		throw new TemplateError(`template key "${path}" is undefined`, {
			template,
			key: path,
		});
	}
	return current;
}

/** 字符串原样；其余 `JSON.stringify`（不可序列化 → TemplateError）。 */
function render(value: unknown, path: string, template: string): string {
	if (typeof value === "string") {
		return value;
	}
	let json: string | undefined;
	try {
		json = JSON.stringify(value);
	} catch {
		json = undefined; // 循环引用 / BigInt 等无法序列化
	}
	if (json === undefined) {
		throw new TemplateError(`template key "${path}" is not JSON-serializable`, {
			template,
			key: path,
		});
	}
	return json;
}

/**
 * 插值用户模板：`{key}` / `{a.b.c}` 从 input 解析，`{{` / `}}` 转义为字面花括号。
 * 任何无法呈现的引用（缺失、undefined、不可序列化）都抛 `TemplateError`。
 */
export function interpolate(template: string, input: unknown): string {
	let out = "";
	let i = 0;
	while (i < template.length) {
		if (template.startsWith("{{", i)) {
			out += "{";
			i += 2;
		} else if (template.startsWith("}}", i)) {
			out += "}";
			i += 2;
		} else if (template.startsWith("{", i)) {
			const close = template.indexOf("}", i + 1);
			if (close === -1) {
				// 未配对：没有闭合 `}`，按字面输出（固化行为，见 tests/template.test.ts）。
				out += "{";
				i += 1;
			} else {
				const key = template.slice(i + 1, close);
				out += render(resolvePath(input, key, template), key, template);
				i = close + 1;
			}
		} else {
			out += template[i];
			i += 1;
		}
	}
	return out;
}
