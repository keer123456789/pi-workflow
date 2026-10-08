/**
 * pi SDK 进程内适配器（设计 §9.3；M4/T2，D24–D29）。
 *
 * `src/runtime/` 是适配器的**物理隔离区**（同 `pi-subprocess.ts` / `llm-pi-ai.ts` 的
 * 惯例）：对等依赖 `@earendil-works/pi-coding-agent` 只按名解析/动态加载，从不静态
 * import；类型面只用 `import(...)` 类型查询 + 结构化最小接口（assistant 消息只读
 * `role/content/stopReason/errorMessage/usage`，与 M3 JSONL 解析器同口径），不深引
 * pi-agent-core。core 对本模块只做 type-only import（`import type` 编译期擦除——运行
 * 时零耦合）。类型 `PiSdkConfig` 经 `src/index.ts` 公开；适配器本体（
 * `createPiSdkExecutor` 等）不进公开面（同 `llm-pi-ai.ts` 的先例：供 compile 解析与
 * 高级用户直接接线用）。
 *
 * 调用流程（顺序冻结，见 M4 计划"实现冻结点"）：① `signal.aborted` 预检（不建
 * session，镜像 M3 回归锁）→ ② 加载 sdk（懒动态 import，单次、进程缓存、含失败缓存）
 * + `ModelRuntime.create(D27 选项)` + D27 model 解析 → ③ `createAgentSession({ cwd,
 * agentDir, modelRuntime, model?, tools?, sessionManager: SessionManager.inMemory() })`
 * → ④ 创建后再查 `signal.aborted` → dispose + AbortError（创建本身不可取消）→ ⑤ 挂
 * `{ once: true }` abort 监听（`void session.abort()`，只吞错不等待失败扩散）+
 * `await session.prompt(task)`（resolve 即本轮完成，pi 内部重试不关闭不配置——D26，
 * 与 subprocess 路径的 CLI 行为一致）→ ⑥ `signal.aborted` → AbortError
 * （kill-then-reject 同构）→ ⑦ D24 verdict（与 pi-subprocess 的 `verdictOf` 逐类同构）
 * → ⑧ `finally { session.dispose() }`（②–⑧ 任一步抛出都必达；②③ 阶段 session 可能
 * 未建成——dispose 前判空，D25）。
 *
 * 判定与生命周期逐类同构（D24/D25，镜像 M3 pi-subprocess）：`"stop"` 成功（文本 +
 * D21 usage）；`"error"` → `pi agent failed: <errorMessage>`（原文保留，D3 可匹配）；
 * `"aborted"` → `name = "AbortError"`（半截正文不算成功，取消不属可重试族）；其他值
 * 可读失败不猜；无 assistant 消息失败。`req.schema` 忽略（D22：schema 在 handler 层，
 * 适配器回原文）。每节点 `SessionManager.inMemory()` 新会话、结束即弃，不做复用（D25
 * 关闭 design §13 开放问题 4）。
 */

import { join } from "node:path";

import type { AgentExecutor, TokenUsage } from "./executor.js";
import { probePeerPackage } from "./peer-resolve.js";
import { toTokenUsage } from "./usage.js";

/**
 * PiSdkConfig（§4.6；D25/D27 冻结形状）
 */
export type PiSdkConfig = {
	/** pi agent 目录（auth.json/models.json 所在）。缺省 = pi 默认（PI_CODING_AGENT_DIR 或 ~/.pi/agent）。 */
	agentDir?: string;
	/** 会话工作目录（资源发现与内置工具路径）。缺省 = process.cwd()。 */
	cwd?: string;
	/** 节点未声明 model 时的兜底模型串 "<provider>/<id>"（D23 优先级：cfg.model ?? defaultModel）。 */
	defaultModel?: string;
};

/** 对等依赖包名（只按名解析/动态加载，从不静态 import）。 */
const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

/** sdk 模块的类型查询（编译期擦除；运行期对象一律来自动态加载）。 */
type PiSdkModule = typeof import("@earendil-works/pi-coding-agent");

/** ModelRuntime 的实例类型（getModel 同步返回 Model | undefined——1.1.0 实测签名）。 */
type SdkModelRuntime = import("@earendil-works/pi-coding-agent").ModelRuntime;

/** createAgentSession 的选项（cwd/agentDir/modelRuntime/model/tools/sessionManager）。 */
type SdkSessionOptions =
	import("@earendil-works/pi-coding-agent").CreateAgentSessionOptions;

/** 会话对象类型（prompt/abort/dispose/messages 的最小面）。 */
type SdkSession = import("@earendil-works/pi-coding-agent").AgentSession;

/** getModel 命中的 model（createAgentSession 的 `model` 选项类型）。 */
type SdkModel = NonNullable<ReturnType<SdkModelRuntime["getModel"]>>;

// ---------------------------------------------------------------------------
// 加载器（D28）：懒动态 import，单次、进程缓存、含失败缓存
// ---------------------------------------------------------------------------

/** 懒加载缓存（D28：`undefined` = 还没加载；失败同样缓存——重装依赖需重启进程）。 */
let loading: Promise<PiSdkModule> | undefined;

/** 可用性探测缓存（D28：`undefined` = 还没探过；与加载缓存相互独立）。 */
let available: boolean | undefined;

/**
 * 清适配器缓存（仅测试用：两个缓存都以进程为界，测试需要用例间隔离）。同时重置
 * 加载缓存与可用性缓存（D28）。
 */
export function resetPiSdkCacheForTests(): void {
	loading = undefined;
	available = undefined;
}

/**
 * 对等依赖是否可用（D28）：能否解析 `@earendil-works/pi-coding-agent`（机制同 M2：
 * `createRequire` 失败退 `import.meta.resolve` 的共享探测 {@link probePeerPackage}）。
 * 首次调用探测，结果缓存到进程结束；**永不抛**（探测失败 = `false`）。
 * compile 期（graph.ts）用它给可行动 issue；运行期加载失败仍走 {@link loadPiSdk} 的
 * 可行动错误。
 */
export function isPiSdkAvailable(): boolean {
	available ??= probePeerPackage(PI_SDK_PACKAGE);
	return available;
}

/**
 * 动态加载（惰性、单次）：根 barrel 取 `createAgentSession`/`SessionManager`/
 * `ModelRuntime` 三个绑定（1.1.0 实测的导出位置）。解构放在 try 里：装上但 barrel
 * 缺面/损坏同属"加载失败"。失败包成可行动错误（含原错 cause）。失败同样被
 * {@link loading} 记住——同进程后续调用直接复抛，不重新 import（重装依赖需重启进程）。
 */
async function loadPiSdk(): Promise<PiSdkModule> {
	try {
		const mod: PiSdkModule = await import("@earendil-works/pi-coding-agent");
		// barrel 面校验：缺任一绑定即加载失败（装坏了的形态），不等到调用时才炸。
		const { createAgentSession, SessionManager, ModelRuntime } = mod;
		if (
			typeof createAgentSession !== "function" ||
			typeof SessionManager?.inMemory !== "function" ||
			typeof ModelRuntime?.create !== "function"
		) {
			throw new Error(
				"sdk barrel is missing createAgentSession/SessionManager/ModelRuntime",
			);
		}
		return mod;
	} catch (error) {
		throw new Error(
			`pi sdk adapter: could not load "${PI_SDK_PACKAGE}" — install it (npm i ${PI_SDK_PACKAGE}) to use the sdk executor: ${messageOf(error)}`,
			{ cause: error },
		);
	}
}

// ---------------------------------------------------------------------------
// D27：ModelRuntime 选项与 model 解析
// ---------------------------------------------------------------------------

/**
 * ModelRuntime.create 的选项（D27）：`agentDir` 给定 → `authPath`/`modelsPath` 指进
 * 该目录；未给定 → 全默认（等价 session 内部默认，含 `models.json` 自定义 provider）。
 * `allowModelNetwork` 不传（缺省 false——离线确定性，1.1.0 的 CreateModelRuntimeOptions
 * 文档同口径）。
 */
function modelRuntimeOptionsOf(
	config: PiSdkConfig,
):
	| import("@earendil-works/pi-coding-agent").CreateModelRuntimeOptions
	| undefined {
	if (config.agentDir === undefined) {
		return undefined; // 全默认：选项对象缺省（undefined 透传，等价 session 内部默认）
	}
	return {
		authPath: join(config.agentDir, "auth.json"),
		modelsPath: join(config.agentDir, "models.json"),
	};
}

/**
 * D27 model 解析：串 `"<provider>/<id>"` 按**第一个** `/` 切分（D13——id 可再含 `/`）；
 * `req.model ?? config.defaultModel`（D23 次序）均无 → `undefined`（不传 model，session
 * 默认选型）；形状非法或 `getModel` 未命中 → 可行动错误（作者错误，不落 D3 族），
 * 前缀 `pi sdk adapter: `。
 */
function resolveModel(
	config: PiSdkConfig,
	req: Parameters<AgentExecutor>[0],
	runtime: SdkModelRuntime,
): SdkModel | undefined {
	const modelRef = req.model ?? config.defaultModel; // D23：节点声明优先于配置兜底
	if (modelRef === undefined) {
		return undefined; // 串缺省：不传 model（session 默认选型，D27）
	}
	const slash = modelRef.indexOf("/");
	if (slash <= 0 || slash === modelRef.length - 1) {
		throw new Error(
			`pi sdk adapter: invalid model "${modelRef}" — expected "<provider>/<id>" (both parts must be non-empty)`,
		);
	}
	const provider = modelRef.slice(0, slash);
	const id = modelRef.slice(slash + 1);
	const model = runtime.getModel(provider, id);
	if (model === undefined) {
		throw new Error(
			`pi sdk adapter: unknown model "${modelRef}" — provider "${provider}" has no model "${id}" (check the model catalog under the pi agent dir / models.json)`,
		);
	}
	return model;
}

// ---------------------------------------------------------------------------
// D24：verdict（与 pi-subprocess 的 verdictOf 逐类同构）
// ---------------------------------------------------------------------------

/**
 * abort 失败（镜像 `pi-subprocess.ts` / `llm-pi-ai.ts` 的 abortError）：`name =
 * "AbortError"` 的普通 Error——上层按名字识别"这是取消"。消息不落 D3 可重试族
 * （取消不该重试）。
 */
function abortError(detail: string | undefined): Error {
	const error = new Error(
		detail === undefined
			? "pi sdk agent aborted"
			: `pi sdk agent aborted: ${detail}`,
	);
	error.name = "AbortError";
	return error;
}

/** assistant `content[]` 中 `type:"text"` 项的文本收集（D24：块间 join "\n"）。 */
function assistantTextOf(content: unknown): string {
	if (!Array.isArray(content)) {
		return "";
	}
	const texts: string[] = [];
	for (const item of content) {
		if (
			typeof item === "object" &&
			item !== null &&
			(item as Record<string, unknown>).type === "text"
		) {
			const value = (item as Record<string, unknown>).text;
			if (typeof value === "string") {
				texts.push(value);
			}
		}
	}
	return texts.join("\n");
}

/**
 * D24 verdict：`prompt()` resolve 后取 `session.messages` 中**最后一个**
 * `role === "assistant"` 的消息（后到覆盖先到）。`"stop"` 成功（文本 + D21 usage，
 * usage 对象整体缺失 → 结果连 usage 键都没有）；`"error"` 保留 errorMessage 原文；
 * `"aborted"` 抛 AbortError；其他值可读失败不猜；无 assistant 消息失败。
 */
function verdictOf(messages: readonly unknown[]): {
	output: string;
	usage?: TokenUsage;
} {
	let assistant: Record<string, unknown> | undefined;
	for (const message of messages) {
		if (
			typeof message === "object" &&
			message !== null &&
			(message as Record<string, unknown>).role === "assistant"
		) {
			assistant = message as Record<string, unknown>;
		}
	}
	if (assistant === undefined) {
		throw new Error("pi agent produced no assistant message");
	}
	switch (assistant.stopReason) {
		case "stop": {
			// D21：usage 对象整体缺失 → 结果**连 usage 键都没有**（键在且值 undefined
			// 会破坏"缺失 → 不上报"的引擎契约，同 pi-subprocess 的口径）。
			const result: { output: string; usage?: TokenUsage } = {
				output: assistantTextOf(assistant.content),
			};
			if (typeof assistant.usage === "object" && assistant.usage !== null) {
				result.usage = toTokenUsage(assistant.usage as Record<string, unknown>);
			}
			return result;
		}
		case "error":
			return verdictFailure(
				`pi agent failed: ${
					typeof assistant.errorMessage === "string"
						? assistant.errorMessage
						: "(pi reported an error without a message)"
				}`,
			);
		case "aborted":
			throw abortError(
				typeof assistant.errorMessage === "string"
					? assistant.errorMessage
					: undefined,
			);
		default:
			// 协议之外的 stopReason（未来值/脏数据）：失败要响，不猜成功。
			return verdictFailure(
				`pi agent failed: unsupported stopReason "${String(assistant.stopReason)}"`,
			);
	}
}

/** verdict 失败分支的抛出（拆出纯为收窄 return 类型）。 */
function verdictFailure(message: string): never {
	throw new Error(message);
}

/** 抛值的一句话描述（与引擎 messageOf 同口径的简化版：只用于拼错误消息）。 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const noop = (): void => {};

// ---------------------------------------------------------------------------
// executor（D25/D27/D29：生命周期、参数映射）
// ---------------------------------------------------------------------------

/**
 * 造一个 pi SDK 进程内执行器（D20 的 `"sdk"` 分支；graph.ts 在 resolveAgentExecutors
 * 里调用）。同一 config 的多次调用共享加载缓存与可用性缓存（D28）。
 */
export function createPiSdkExecutor(config: PiSdkConfig): AgentExecutor {
	return async (req) => {
		// ① 预检：已取消就不建 session（镜像 M3 的回归锁——不 spawn 的 sdk 同构）。
		if (req.signal.aborted) {
			throw abortError(undefined);
		}
		let session: SdkSession | undefined; // ⑧ 判空依据：建成之前 undefined
		try {
			// ② 加载 sdk（D28：单次、进程缓存、含失败缓存——rejected promise 也留在
			// 缓存里，重装依赖需重启进程）+ ModelRuntime.create（D27 选项）+ model 解析。
			loading ??= loadPiSdk();
			const sdk = await loading;
			const runtime = await sdk.ModelRuntime.create(
				modelRuntimeOptionsOf(config),
			);
			const model = resolveModel(config, req, runtime);

			// ③ 建会话（D25：inMemory 新会话、结束即弃；D29：tools 仅非空白名单透传）。
			const options: SdkSessionOptions = {
				cwd: config.cwd,
				agentDir: config.agentDir,
				modelRuntime: runtime,
				sessionManager: sdk.SessionManager.inMemory(),
				...(model !== undefined ? { model } : {}),
				...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
			};
			const created = (await sdk.createAgentSession(options)).session;
			session = created; // 建成即记入：此后任何路径 finally 都 dispose

			// ④ 创建后再查 aborted（创建本身不可取消，D-frozen 流程）。
			if (req.signal.aborted) {
				throw abortError(undefined);
			}

			// ⑤ abort 监听：once + finally 移除；session.abort() 只负责打断 pi 内部
			// 循环（含内部重试，D26），其 promise 只吞错不等待失败扩散——取消路径的
			// 成败由 ⑥ 的 signal 检查驱动（kill-then-reject 同构）。
			const onAbort = (): void => {
				void created.abort().catch(noop);
			};
			req.signal.addEventListener("abort", onAbort, { once: true });
			try {
				// resolve 即本轮完成（含 pi 内部重试，D26/D24）；rejection 只在
				// signal 未 abort 时原样上抛（abort 中途的 rejection 归 ⑥ 收口）。
				await created.prompt(req.task);
			} catch (error) {
				if (req.signal.aborted) {
					throw abortError(undefined);
				}
				throw error;
			} finally {
				req.signal.removeEventListener("abort", onAbort);
			}

			// ⑥ signal.aborted → AbortError（prompt 可能被 abort 打断后正常 resolve）。
			if (req.signal.aborted) {
				throw abortError(undefined);
			}

			// ⑦ D24 verdict。
			return verdictOf(created.messages);
		} finally {
			// ⑧ dispose 必达（D25：成功/失败/abort/verdict 全路径）；②③ 阶段 session
			// 可能未建成——dispose 前判空。
			session?.dispose();
		}
	};
}
