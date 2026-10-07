/**
 * hash 脱敏（设计 §8.1/D7，Task 3）：`logOutputs: "hash"` 时把三个敏感字段替换成
 * `"sha256:<64位hex>"`，让 onEvent 与 JSONL 两路都只见摘要（法律文书的敏感输入/输出
 * 不经回调泄露）。
 *
 * - **纯函数、无 I/O**：`node:crypto` 的 createHash 是计算不是 I/O（core 允许）；
 * - 摘要输入 = `JSON.stringify(value)`（同一个值的脱敏结果稳定、可跨 run 比对）；
 * - stringify 抛错（循环引用 / BigInt / 抛错的 toJSON）或返回 `undefined`
 *   （undefined / 函数 / Symbol 没有 JSON 表示）时，对字面量 `"[unserializable]"`
 *   取哈希——脱敏绝不因为一个怪值让 run 崩掉（D7）；
 * - 变换在 emitter 里对每个事件**恰好执行一次**，两个 sink 拿到同一个结果对象
 *   （§8.1："两路都拿脱敏后的事件"）。
 */

import { createHash } from "node:crypto";

import type { RunEvent } from "./types.js";

/** stringify 抛错/无产出时的替代输入（D7 规定的字面量，不参与 JSON 编码）。 */
const UNKNOWN_VALUE_TEXT = "[unserializable]";

/**
 * 任意值的单向摘要（D7）：`sha256:<64位hex>`（小写 hex）。
 * `JSON.stringify` 的输入即摘要输入；抛错或产出 `undefined` 时改用
 * {@link UNKNOWN_VALUE_TEXT} 的字面量文本。
 */
export function hashValue(value: unknown): string {
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch {
		// 循环引用 / BigInt / 抛错的 toJSON：落到替代字面量
		text = undefined;
	}
	const digest = createHash("sha256")
		.update(text ?? UNKNOWN_VALUE_TEXT)
		.digest("hex");
	return `sha256:${digest}`;
}

/**
 * 事件脱敏（D7）：`run_started.input`、`node_started.input`（见下）、
 * `node_finished.output` → hash 字符串；其余事件**原样返回同一个对象**（不拷贝）。
 *
 * `RunEvent` 的 `node_started` 目前不携带 `input`（D7 按字段名约束）：该分支按
 * "字段存在才脱敏" 实现——事件将来增补 `input` 时，"两路只见脱敏值"不因字段增补而破。
 * 输入事件不被原地修改（浅拷贝后替换目标字段）。
 */
export function redactEvent(event: RunEvent): RunEvent {
	switch (event.type) {
		case "run_started":
			return { ...event, input: hashValue(event.input) };
		case "node_started": {
			const withInput = event as typeof event & { input?: unknown };
			if (!("input" in withInput)) {
				return event;
			}
			return { ...withInput, input: hashValue(withInput.input) } as RunEvent;
		}
		case "node_finished":
			return { ...event, output: hashValue(event.output) };
		default:
			return event;
	}
}
