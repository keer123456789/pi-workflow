/**
 * pi-ai 默认补全适配器（D13；设计 §9.4、§9.1）。
 *
 * `src/runtime/` 是适配器的**物理隔离区**：本文件是 `@earendil-works/*` 的唯一接触点，
 * 且运行期**只动态 import**（静态面只有 `node:module` 的 `createRequire`）——对等依赖
 * 没装时本模块照常加载，`isPiAiAvailable()` 说"没有"，编译期给出可行动报错（Task 8）。
 * 类型层面用 `import(...)` 类型查询（编译期擦除，零运行期耦合）。
 *
 * 公开面（两个）：
 * - `isPiAiAvailable()`：对等依赖能否解析。首选
 *   `createRequire(import.meta.url).resolve(...)`，失败退到 `import.meta.resolve`
 *   （缘由见 {@link probePiAi}）；结果**进程内缓存**、**永不抛**；
 * - `defaultPiAiComplete()`：懒建单例的 `CompleteFn`（D13）——取函数不加载任何东西，
 *   **首次调用**才动态 import pi-ai 并 `builtinModels()` 建一次 Models 集合（之后复用）。
 *
 * 调用形状（D13）：模型串 `"<provider>/<id>"` 按**第一个** `/` 切分（id 可再含 `/`）；
 * 缺 `/`、provider/id 为空、`model` 未配置、或 `getModel` 未命中 → 可读错误（作者错误，
 * 消息不落 D3 可重试族）。转发形状：
 * `completeSimple(model, { messages: [{ role: "user", content: prompt, timestamp }] }, { signal })`
 * ——`timeoutMs` 不转发：引擎的单次尝试超时就是 `abort` 这个 `signal`（§7.3/T11），
 * 适配器复用同一根取消链即可。**成败只认助手消息的 `stopReason`**（§9.2；R1 收紧）：成功 =
 * 白名单 `{stop, length, toolUse}`；`error` → 抛 `pi-ai completion failed: <errorMessage>`
 * （消息保留 provider 原文，瞬态文本仍能被 `isRetryableError` 的 D3 正则族匹配）；
 * `aborted` → 抛 `name = "AbortError"` 的错误（半截正文不算成功）；`deferred`/`pending` →
 * 可读错误（llm 节点不支持异步补全）；未知值 → 报"unsupported stopReason"。成功路径文本
 * `contentText(msg.content)`；usage 按 D4 映射（`cost` 只在源 usage 带 cost 时进结果）。
 *
 * 不进 `src/index.ts` 公开面（Task 9 决定导出面）：本模块供 compile 期解析（Task 8）与
 * 高级用户直接接线用。
 */

import { createRequire } from "node:module";

import type { CompleteFn, TokenUsage } from "./executor.js";

/** 对等依赖包名（只按名解析/动态加载，从不静态 import）。 */
const PI_AI_PACKAGE = "@earendil-works/pi-ai";

/** 可用性探测结果（D13：进程内缓存；`undefined` = 还没探过）。 */
let available: boolean | undefined;

/**
 * 对等依赖是否可用（D13）：能否解析 `@earendil-works/pi-ai`。首次调用探测，结果缓存到
 * 进程结束（依赖装没装不会在进程中途变化）；**永不抛**（探测失败 = `false`）。
 */
export function isPiAiAvailable(): boolean {
	available ??= probePiAi();
	return available;
}

/**
 * 真实探测：`createRequire(import.meta.url).resolve(PKG)`（D13 指定机制）在 try/catch 里；
 * 它失败时退到 `import.meta.resolve(PKG)`。
 *
 * 为什么要退一步（对 pi-ai@1.0.4 实测）：其 `exports` map 的 `"."` 只声明了
 * `"types"`/`"import"` 两个条件——**没有 `"require"`/`"default"`**，而 `require.resolve`
 * 按 CJS 条件解析，必然 `ERR_PACKAGE_PATH_NOT_EXPORTED`：只按字面实现会让探测在
 * "装好了"时也报 false，默认实现永远接不上。`import.meta.resolve` 走 ESM 条件，正是
 * 本库（ESM-only）该用的机制；本仓库 Node ≥22，它在 22/24 与 vitest 下都可用。
 */
function probePiAi(): boolean {
	try {
		createRequire(import.meta.url).resolve(PI_AI_PACKAGE);
		return true;
	} catch {
		// 落到 ESM 条件兜底（见上）；老环境/打包器里 import.meta.resolve 可能没有 → false。
	}
	try {
		const resolve = (
			import.meta as ImportMeta & {
				resolve?: (specifier: string) => string;
			}
		).resolve;
		return (
			typeof resolve === "function" && resolve(PI_AI_PACKAGE) !== undefined
		);
	} catch {
		return false;
	}
}

/** 懒建单例（D13：重复调用返回**同一个** `CompleteFn` 实例）。 */
let singleton: CompleteFn | undefined;

/**
 * 默认补全实现（D13）：懒建单例。取函数不触碰 pi-ai；首次真正调用时才动态加载并建
 * Models 集合，之后这个实例复用同一份加载结果（失败同样被记住——重装依赖请重启进程）。
 */
export function defaultPiAiComplete(): CompleteFn {
	singleton ??= createDefaultComplete();
	return singleton;
}

/** pi-ai 侧助手消息（只用到适配器真正读的字段，其余由类型查询保证）。 */
type PiAiAssistantMessage = import("@earendil-works/pi-ai").AssistantMessage;
type PiAiUsage = import("@earendil-works/pi-ai").Usage;

/**
 * 动态加载（惰性、单次）：根 barrel 取 `contentText`，`providers/all` 取
 * `builtinModels()` 建一次 Models 集合——pi-ai@1.0.4 的根 barrel **不导出**
 * `builtinModels`（实测），它声明在 `providers/all`（exports map 的 `./providers/*`
 * 通配）。加载失败包成可行动错误（含原错 cause）。
 */
async function loadPiAi(): Promise<{
	contentText: (content: PiAiAssistantMessage["content"]) => string;
	models: import("@earendil-works/pi-ai").MutableModels;
}> {
	try {
		const [root, providers] = await Promise.all([
			import("@earendil-works/pi-ai"),
			import("@earendil-works/pi-ai/providers/all"),
		]);
		return {
			contentText: root.contentText,
			models: providers.builtinModels(),
		};
	} catch (error) {
		throw new Error(
			`pi-ai adapter: could not load "${PI_AI_PACKAGE}" — install it (npm i ${PI_AI_PACKAGE}) to use the default completion: ${messageOf(error)}`,
			{ cause: error },
		);
	}
}

/** 造一个 `CompleteFn`：内部懒记 {@link loadPiAi}（同一实例的所有调用共享）。 */
function createDefaultComplete(): CompleteFn {
	let loading: ReturnType<typeof loadPiAi> | undefined;

	return async (req) => {
		loading ??= loadPiAi();
		const { contentText, models } = await loading;

		const { provider, id } = parseModelRef(req.model);
		const model = models.getModel(provider, id);
		if (model === undefined) {
			throw new Error(
				`pi-ai adapter: unknown model "${req.model}" — provider "${provider}" has no built-in model "${id}" (check builtinModels())`,
			);
		}

		const message = await models.completeSimple(
			model,
			{
				messages: [
					{ role: "user", content: req.prompt, timestamp: Date.now() },
				],
			},
			{ signal: req.signal },
		);

		// 成败只认助手消息的 stopReason（§9.2；R1 收紧）：成功 = 白名单
		// {stop, length, toolUse}，其余逐类明确失败——**绝不把可能半截的文本当成功返回**。
		// （length：截断的正文照常返回，JSON/schema 违规由 llm 节点按可重试失败处理。）
		switch (message.stopReason) {
			case "stop":
			case "length":
			case "toolUse":
				break;
			case "error":
				throw new Error(
					`pi-ai completion failed: ${message.errorMessage ?? "(provider reported an error without a message)"}`,
				);
			case "aborted":
				throw abortError(message.errorMessage);
			case "deferred":
			case "pending":
				throw new Error(
					`pi-ai ${message.stopReason} completions are not supported by the llm node`,
				);
			default:
				// 白名单之外（未来 pi-ai 新增的 stopReason）：失败要响，不猜。
				throw new Error(
					`pi-ai completion failed: unsupported stopReason "${String(message.stopReason)}"`,
				);
		}

		return {
			text: contentText(message.content),
			usage: toTokenUsage(message.usage),
		};
	};
}

/**
 * abort 失败（R1）：`name = "AbortError"` 的普通 Error——调用方/上层能按名字识别"这是取消"
 * （DOMException 在本仓库不合用：Node 里它不是 `Error` 子类，引擎的 `messageOf` 会把
 * `JSON.stringify` 出的 `{}` 当消息，诊断反而丢失）。消息不落 D3 可重试族（取消不该重试）。
 */
function abortError(detail: string | undefined): Error {
	const error = new Error(
		detail === undefined
			? "pi-ai completion aborted"
			: `pi-ai completion aborted: ${detail}`,
	);
	error.name = "AbortError";
	return error;
}

/**
 * 切分模型串 `"<provider>/<id>"`（D13）：**第一个** `/` 之前是 provider，其余（含后续
 * `/`）整体是模型 id。作者错误（未配置/缺 `/`/空 provider/空 id）→ 可读错误，说明期望
 * 形状并带上原串——都在发请求之前。
 */
function parseModelRef(model: string | undefined): {
	provider: string;
	id: string;
} {
	if (model === undefined || model === "") {
		throw new Error(
			`pi-ai adapter: no model configured — set the llm node's "model" to "<provider>/<id>" (or inject a complete via services.complete)`,
		);
	}
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1) {
		throw new Error(
			`pi-ai adapter: invalid model "${model}" — expected "<provider>/<id>" (both parts must be non-empty)`,
		);
	}
	return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

/**
 * usage 映射（D4/D13）：只带 D4 的五个计数；`cost` **只在源 usage 有 cost 时**进结果
 * （自定义网关可以不报成本）。pi-ai 独有的 `cacheWrite1h`/`reasoning`/`raw*` 不转发。
 */
function toTokenUsage(usage: PiAiUsage): TokenUsage {
	const mapped: TokenUsage = {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
	};
	if (usage.cost !== undefined) {
		mapped.cost = {
			input: usage.cost.input,
			output: usage.cost.output,
			cacheRead: usage.cost.cacheRead,
			cacheWrite: usage.cost.cacheWrite,
			total: usage.cost.total,
		};
	}
	return mapped;
}

/** 抛值的一句话描述（与引擎 `messageOf` 同口径的简化版：只用于拼错误消息）。 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
