/**
 * llmNode：把"一次性 LLM 补全"包装成节点定义（设计 §4.3；绑定机制 D12，签名放宽 D15）。
 *
 * 工厂产出的只是**待绑定**的 llm 定义：真正的 handler 需要知道用哪个补全实现
 * （`CompleteFn`），而这一解析发生在 compile 期（`def.complete ?? services.complete ??
 * pi-ai 默认`，§6.6/D12）——所以工厂把配置（prompt / schema / model / 归一后的
 * timeoutMs）存进本模块的 WeakMap，`bindLlmNode(def, complete)` 用它造出真正的
 * handler（graph.ts 在装配 `CompiledGraphData.nodes` 副本时调用，Task 8）。
 * `cfg.complete` 已给出时工厂内部直接预绑定一次；`bindLlmNode` 幂等且可覆盖——
 * 返回**新定义对象**，不改原件。
 *
 * WeakMap 的键有两种形态（同一份 cfg 登记两次）：
 * - **定义对象**（D12 口径）；
 * - **handler 函数**——addNode 注册时对定义做浅拷贝 `{ ...node, name }`（graph.ts），
 *   副本与原件**共享 handler 引用**但不再是同一个对象；compile 期绑定拿到的正是
 *   注册副本，按 def 查不到时按 handler 查，绑定信息才能跨注册存活。
 *
 * handler 每次尝试的流程（§4.3/§7.2/D11）：
 * `prompt 求值 → complete(...) → 剥 ```json 栅栏 → JSON.parse → Value.Check(schema)`；
 * JSON / schema 违规 `markRetryable(throw)`（D3：可重试、同 prompt 重发）；成功时
 * 先 `ctx.reportUsage(usage)`（仅 complete 报了 usage 才调，D11），再返回**解析值本身**
 * ——`{ [writeTo]: 值 }` 的包裹由引擎 `updateOf` 完成（§5.1:354）。
 *
 * 未绑定的定义其 handler 是占位函数：直接调用抛 "llm node is not bound"（compile
 * 保证编译产物里的 llm 节点都已绑定，运行期到不了这里；手工直接调用属误用）。
 */

import type { TSchema } from "typebox";
import { Value } from "typebox/value";

import { markRetryable } from "../core/retry.js";
import type {
	NodeContext,
	NodeDefinition,
	NodeHandler,
} from "../core/types.js";
import type { CompleteFn } from "../runtime/executor.js";
import { interpolate } from "../template.js";

/** 单次尝试的默认超时（设计 §4.3）。 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** schema 失败消息最多列出的错误条数（compact：不把几十条 issue 灌进 message）。 */
const MAX_SCHEMA_ISSUES = 3;

/** JSON 失败消息里原文预览的上限（字符）。 */
const MAX_TEXT_PREVIEW = 200;

/** 绑定所需的最小配置：与公开 cfg 的差异只在 `timeoutMs` 已归一。 */
type LlmCfg = {
	prompt: string | ((input: unknown) => string);
	schema: TSchema;
	model?: string;
	timeoutMs: number;
};

/** 待绑定配置（D12）：键 = 定义对象或 handler 函数（见文件头注释）。 */
const pending = new WeakMap<object, LlmCfg>();

/**
 * llm 节点工厂（签名按计划 verbatim；D15：不做 `Static<typeof schema>` 可赋给
 * `S[K]` 的类型级约束，`writeTo: K extends keyof S & string` 即全部保证）。
 *
 * 返回 `kind: "llm"` 的定义：`name` 留空串占位（由 `addNode` 回填，与 fnNode 一致）；
 * `timeoutMs` 缺省 120_000；`retry` / `model` / `complete` 原样带上。
 */
export function llmNode<S, K extends keyof S & string>(cfg: {
	prompt: string | ((input: unknown) => string);
	schema: TSchema;
	writeTo: K;
	model?: string;
	complete?: CompleteFn;
	retry?: { maxAttempts: number };
	timeoutMs?: number;
}): NodeDefinition<S> {
	const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const llmCfg: LlmCfg = {
		prompt: cfg.prompt,
		schema: cfg.schema,
		model: cfg.model,
		timeoutMs,
	};
	// 占位 handler（每次调用都是新函数——WeakMap 键不跨定义串味）：绑定前被调用即误用。
	const handler: NodeHandler<S, S> = () => {
		throw new Error(
			"llm node is not bound: call bindLlmNode(def, complete) before invoking the handler (compile() binds llm nodes automatically)",
		);
	};
	const def: NodeDefinition<S> = {
		kind: "llm",
		name: "",
		handler,
		writeTo: cfg.writeTo,
		retry: cfg.retry,
		timeoutMs,
		complete: cfg.complete,
	};
	pending.set(def, llmCfg);
	pending.set(handler, llmCfg);
	// D12：cfg.complete 已给出 → 工厂内部预绑定（返回的就是绑好的定义）。
	return cfg.complete === undefined ? def : bindLlmNode(def, cfg.complete);
}

/**
 * 生成真正的 handler 并返回**新定义对象**（D12；graph.ts 在复制 nodes 时绑定）。
 *
 * - 幂等 / 可覆盖：不修改传入的 def；重复绑定、换一个 complete 重绑都只产出新对象，
 *   绑定结果自己也登记进 WeakMap（可再次绑定）；
 * - 绑定后 `.complete` 记录**本次实际生效**的补全实现（`{ ...def, handler, complete }`）
 *   ——反映这份定义将要运行的实现，而不是它声明时的缺省；
 * - 工厂产出的定义（含 addNode 注册副本）**总能**查到待绑定配置；查不到 = 这份定义
 *   不是工厂产物（NodeDefinition 是公开类型，手工定义合法）——那它自己的 handler
 *   就是既定行为，原样返回（no-op）：既不替换也没法替换，抛错反而会拒绝合法用法。
 *   工厂定义若因异常克隆丢了配置，症状是明确的运行期 "llm node is not bound"，不静默。
 */
export function bindLlmNode<S, I = S>(
	def: NodeDefinition<S, I>,
	complete: CompleteFn,
): NodeDefinition<S, I> {
	const cfg = pending.get(def) ?? pending.get(def.handler);
	if (cfg === undefined) {
		return def;
	}
	const handler = createHandler<S, I>(cfg, complete);
	const bound: NodeDefinition<S, I> = { ...def, handler, complete };
	pending.set(bound, cfg);
	pending.set(handler, cfg);
	return bound;
}

/** 真正的 handler：prompt 求值 → complete → 解析/校验 → 上报 usage → 返回解析值。 */
function createHandler<S, I>(
	cfg: LlmCfg,
	complete: CompleteFn,
): NodeHandler<S, I> {
	return async (input: Readonly<I>, ctx: NodeContext) => {
		const prompt =
			typeof cfg.prompt === "function"
				? cfg.prompt(input)
				: interpolate(cfg.prompt, input);
		const completion = await complete({
			prompt,
			model: cfg.model,
			schema: cfg.schema,
			signal: ctx.signal,
			timeoutMs: cfg.timeoutMs,
		});
		const parsed = parseCompletion(completion.text);
		if (!Value.Check(cfg.schema, parsed)) {
			throw markRetryable(
				new Error(
					`llm output does not match schema: ${schemaErrorDetail(cfg.schema, parsed)}`,
				),
			);
		}
		if (completion.usage !== undefined) {
			ctx.reportUsage?.(completion.usage);
		}
		// writeTo 的包裹是引擎的事（§5.1:354 / engine.ts 的 updateOf）：返回解析值本身。
		return parsed as Partial<S>;
	};
}

/**
 * 解析补全文本（§4.3）：trim → 剥 ```json / ``` 栅栏 → `JSON.parse`。
 * 失败 → `markRetryable`（D3：llm 的 JSON 违规同 prompt 重发），消息带解析失败原因
 * 与原文预览——重试事件 / run 日志里能看清模型吐了什么。
 */
function parseCompletion(text: string): unknown {
	const body = stripFences(text.trim());
	try {
		return JSON.parse(body);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw markRetryable(
			new Error(
				`llm output is not valid JSON: ${reason}; text: ${preview(body)}`,
			),
		);
	}
}

/** 开栅栏：三个反引号 + 可选 json 标签（可带水平空白 / 换行；大小写不敏感）。 */
const OPEN_FENCE = /^```(?:json)?[ \t]*\r?\n?/i;

/**
 * 剥掉一层代码栅栏：开头命中 {@link OPEN_FENCE} 时剥开栅栏，且此时结尾若是 ``` 再剥
 * 闭栅栏（没开栅栏就不动结尾——裸 JSON 字符串本身可能以 ``` 结尾）。其余内容原样。
 */
function stripFences(text: string): string {
	const open = OPEN_FENCE.exec(text);
	if (open === null) {
		return text;
	}
	const body = text.slice(open[0].length);
	const trimmed = body.trimEnd();
	return trimmed.endsWith("```") ? trimmed.slice(0, -3) : body;
}

/**
 * schema 违规的紧凑详情：`instancePath: message`（根路径省略前缀），最多
 * {@link MAX_SCHEMA_ISSUES} 条 + 余量计数。`Value.Errors` 空但 `Check` 为假
 * （自造 schema / refine 不报错）时给一句兜底，不让消息断在冒号后。
 */
function schemaErrorDetail(schema: TSchema, value: unknown): string {
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

/** 原文预览：压成单行 + 截断——错误消息要能塞进一行日志。 */
function preview(text: string): string {
	const flat = text.replace(/\s+/g, " ");
	return flat.length <= MAX_TEXT_PREVIEW
		? flat
		: `${flat.slice(0, MAX_TEXT_PREVIEW)}…`;
}
