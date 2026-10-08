/**
 * 产出解析与校验助手（§4.3/§9.3/D22）：llm 与 agent 节点共用的
 * "剥栅栏 → JSON.parse → typebox 校验"层——从 llm.ts 平移（M3/T2，本计划唯一授权的
 * 实现文件重构），错误消息按 kind 参数化前缀（"llm output is not valid JSON" /
 * "agent output is not valid JSON"），两个节点的公开行为逐字不变。
 *
 * - D3：JSON / schema 违规一律 `markRetryable`（同 prompt/task 重发）；
 * - D22：{@link schemaInstruction} 的指令文本由 handler 层拼在 task/prompt 插值
 *   **之后**（不参与插值，§5.6）——本模块只提供文本与解析，不做插值。
 *
 * 内部模块：不进 `src/index.ts` 公开面（供 src/nodes/ 内部共用）。
 */

import type { TSchema } from "typebox";
import { Value } from "typebox/value";

import { markRetryable } from "../core/retry.js";

/** 产出节点的种类：`parseJsonOutput` 的消息前缀（"llm" / "agent"）。 */
export type OutputKind = "llm" | "agent";

/** schema 失败消息最多列出的错误条数（compact：不把几十条 issue 灌进 message）。 */
const MAX_SCHEMA_ISSUES = 3;

/** JSON 失败消息里原文预览的上限（字符）。 */
const MAX_TEXT_PREVIEW = 200;

/** 开栅栏：三个反引号 + 可选 json 标签（可带水平空白 / 换行；大小写不敏感）。 */
const OPEN_FENCE = /^```(?:json)?[ \t]*\r?\n?/i;

/** D22 逐字的产出约束指令前缀（勿改——测试钉住全文）。 */
const INSTRUCTION_PREFIX =
	"\n\n输出约束：最终输出只包含一个符合以下 JSON Schema 的 JSON 对象，不要包含任何其他文本或代码栅栏：\n";

/**
 * 解析产出文本（§4.3）：trim → 剥 ```json / ``` 栅栏 → `JSON.parse`。
 * 失败 → `markRetryable`（D3：同 prompt/task 重发），消息带解析失败原因与原文预览
 * ——重试事件 / run 日志里能看清模型吐了什么。消息前缀按 kind 参数化
 * （`"<kind> output is not valid JSON: …"`）。
 */
export function parseJsonOutput(kind: OutputKind, text: string): unknown {
	const body = stripFences(text.trim());
	try {
		return JSON.parse(body);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw markRetryable(
			new Error(
				`${kind} output is not valid JSON: ${reason}; text: ${preview(body)}`,
			),
		);
	}
}

/**
 * schema 违规的紧凑详情：`instancePath: message`（根路径省略前缀），最多
 * {@link MAX_SCHEMA_ISSUES} 条 + 余量计数。`Value.Errors` 空但 `Check` 为假
 * （自造 schema / refine 不报错）时给一句兜底，不让消息断在冒号后。
 */
export function schemaErrorDetail(schema: TSchema, value: unknown): string {
	const issues: string[] = [];
	let total = 0;
	for (const issue of Value.Errors(schema, value)) {
		total += 1;
		if (issues.length < MAX_SCHEMA_ISSUES) {
			issues.push(
				issue.instancePath === ""
					? issue.message
					: `${issue.instancePath}: ${issue.message}`,
			);
		}
	}
	if (total === 0) {
		return "value rejected by schema (no error details reported)";
	}
	const rest = total - issues.length;
	return rest > 0 ? `${issues.join("; ")} (+${rest} more)` : issues.join("; ");
}

/** D22：schema 产出约束指令——由 handler 层拼在 task/prompt 插值结果之后。 */
export function schemaInstruction(schema: TSchema): string {
	return INSTRUCTION_PREFIX + JSON.stringify(schema);
}

/** 原文预览：压成单行 + 截断——错误消息要能塞进一行日志。 */
export function preview(text: string): string {
	const flat = text.replace(/\s+/g, " ");
	return flat.length <= MAX_TEXT_PREVIEW
		? flat
		: `${flat.slice(0, MAX_TEXT_PREVIEW)}…`;
}

/** 开栅栏命中时剥掉一层代码栅栏：开头剥 {@link OPEN_FENCE}，此时结尾若是 ``` 再剥
 * 闭栅栏（没开栅栏就不动结尾——裸 JSON 字符串本身可能以 ``` 结尾）。其余内容原样。 */
export function stripFences(text: string): string {
	const open = OPEN_FENCE.exec(text);
	if (open === null) {
		return text;
	}
	const body = text.slice(open[0].length);
	const trimmed = body.trimEnd();
	return trimmed.endsWith("```") ? trimmed.slice(0, -3) : body;
}
