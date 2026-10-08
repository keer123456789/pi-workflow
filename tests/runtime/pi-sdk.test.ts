/**
 * Task 2：pi SDK 进程内适配器（D24–D29）。
 *
 * 与 `@earendil-works/pi-coding-agent` 的一切交互由 `vi.mock` 顶替根 barrel（本适配器
 * 只有这一个 import 路径）：假 `createAgentSession`（返回可编程 FakeSession）、
 * `SessionManager.inMemory`（记数）、`ModelRuntime.create`（返回可编程 fake runtime，
 * `getModel` 可命中/未命中）。FakeSession 的 `prompt` 可编程（resolve/抛错/挂起直至
 * abort）、`abort()` 翻转状态并让 prompt 收场、`dispose()` 记数、`messages` 逐例注入。
 * **无网络、无凭据、无真实模型**。
 *
 * 每个用例经 `resetPiSdkCacheForTests()` + `vi.resetModules()` + 动态 re-import 拿干净
 * 模块实例（M2 llm-pi-ai.test.ts :367 先例）——适配器的 loader 缓存/可用性缓存都以进程
 * 为界，测试必须逐例隔离。
 *
 * 用例组（brief 七组）：①成功文本路径（usage 映射 D21/D29）②schema 透传（D22）
 * ③verdict 三分支 + 无 assistant（D24，与 pi-subprocess 的判定逐类同构）④取消组
 * （预 abort / 创建期 abort / prompt 中 abort——镜像 M3 回归锁与 kill-then-reject 同构）
 * ⑤model 解析（D27：第一个 `/`、agentDir 映射、缺省不传 model）⑥tools 映射（D29）
 * ⑦可用性与加载（D28：探测缓存、加载失败缓存）。
 */

import { join } from "node:path";
import type { TSchema } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isRetryableError } from "../../src/core/retry.js";
import type { AgentExecutor } from "../../src/runtime/executor.js";

// ---------------------------------------------------------------------------
// 假 SDK barrel：vi.hoisted 里造替身；brokenPeer 标志把 barrel 变成"装坏了"的形态
// （属性访问即抛——加载器的 try 捕获后包成 could not load 错误）。
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
	const state = { brokenPeer: false };
	const createAgentSession = vi.fn();
	const inMemory = vi.fn();
	const modelRuntimeCreate = vi.fn();
	const getModel = vi.fn();
	const probePeerPackage = vi.fn();
	const barrel = {
		get createAgentSession() {
			if (state.brokenPeer) {
				throw new Error("simulated broken peer install");
			}
			return createAgentSession;
		},
		SessionManager: { inMemory },
		ModelRuntime: { create: modelRuntimeCreate },
	};
	return {
		state,
		createAgentSession,
		inMemory,
		modelRuntimeCreate,
		getModel,
		probePeerPackage,
		barrel,
	};
});

vi.mock("@earendil-works/pi-coding-agent", () => mocks.barrel);
vi.mock("../../src/runtime/peer-resolve.js", () => ({
	probePeerPackage: mocks.probePeerPackage,
}));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** 干净模块实例：resetModules + 动态 re-import + 清缓存（D28 的 reset 导出逐例钉住）。 */
async function freshPiSdk(): Promise<
	typeof import("../../src/runtime/pi-sdk.js")
> {
	vi.resetModules();
	const mod = await import("../../src/runtime/pi-sdk.js");
	mod.resetPiSdkCacheForTests();
	return mod;
}

/** 一条可编程 FakeSession：prompt 缺省 resolve、abort 缺省 resolve、dispose 记数。 */
function fakeSession(messages: unknown[] = []) {
	return {
		prompt: vi.fn(() => Promise.resolve()),
		abort: vi.fn(() => Promise.resolve()),
		dispose: vi.fn(() => {}),
		messages,
	};
}

/** 一次 agent 调用请求（引擎 attempt 级语义的最小形态；timeoutMs 不由适配器消费）。 */
type AgentRequest = Parameters<AgentExecutor>[0];

function agentRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
	return {
		task: "hello agent",
		signal: new AbortController().signal,
		timeoutMs: 600_000,
		runId: "run-1",
		instanceId: "node-1",
		...overrides,
	};
}

/** 取 rejection 的抛值（resolve 时返回 undefined——调用方必须断言其为 Error）。 */
async function rejectionOf(value: Promise<unknown>): Promise<unknown> {
	try {
		await value;
	} catch (error) {
		return error;
	}
	return undefined;
}

/**
 * 拒绝且必须在 ms 内发生（取消用例的自带护栏——快速失败的钉子）：
 * 超时返回带 label 的 Error（而非悬挂），正常返回 rejection 本体。
 */
async function rejectionWithin(
	promise: Promise<unknown>,
	ms: number,
	label: string,
): Promise<unknown> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new Error(`${label}: not settled within ${ms}ms (guard)`));
		}, ms);
	});
	try {
		const outcome = await Promise.race([
			promise.then(
				() => ({ kind: "fulfilled" as const, error: undefined as unknown }),
				(error: unknown) => ({ kind: "rejected" as const, error }),
			),
			guard,
		]);
		return outcome.kind === "rejected" ? outcome.error : undefined;
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

/** 默认成功接线：ModelRuntime 命中 + createAgentSession 返回给定 session。 */
function wireSuccess(
	session: ReturnType<typeof fakeSession>,
	fakeModel: Record<string, unknown> = { id: "model" },
): void {
	mocks.modelRuntimeCreate.mockResolvedValue({ getModel: mocks.getModel });
	mocks.getModel.mockReturnValue(fakeModel);
	mocks.createAgentSession.mockResolvedValue({ session });
}

beforeEach(() => {
	mocks.state.brokenPeer = false;
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// ① 成功文本路径（D24 成功分支 + D21/D29 usage 映射）
// ---------------------------------------------------------------------------

describe("success path (stopReason stop, D24)", () => {
	it("returns the last assistant text with mapped usage (cost forwarded, pi-only keys dropped)", async () => {
		const session = fakeSession([
			{ role: "user", content: [{ type: "text", text: "hello agent" }] },
			{
				role: "assistant",
				content: [{ type: "text", text: "first" }],
				stopReason: "stop",
				usage: { input: 1 },
			},
			{ role: "user", content: [{ type: "text", text: "more" }] },
			{
				role: "assistant",
				content: [{ type: "text", text: "final answer" }],
				stopReason: "stop",
				usage: {
					input: 1444,
					output: 17,
					cacheRead: 3,
					cacheWrite: 4,
					totalTokens: 1468,
					cacheWrite1h: 9, // pi 独有键：不得转发（D21）
					reasoning: 2,
					cost: {
						input: 0.001,
						output: 0.002,
						cacheRead: 0.0001,
						cacheWrite: 0.0002,
						total: 0.0033,
					},
				},
			},
		]);
		wireSuccess(session);
		const sessionManagerMarker = { inMemory: true };
		mocks.inMemory.mockReturnValue(sessionManagerMarker);
		const fresh = await freshPiSdk();
		const executor = fresh.createPiSdkExecutor({});

		const result = await executor(agentRequest());

		// D24：取**最后一个** role === "assistant" 的消息。
		expect(result.output).toBe("final answer");
		expect(result.usage).toEqual({
			input: 1444,
			output: 17,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 1468,
			cost: {
				input: 0.001,
				output: 0.002,
				cacheRead: 0.0001,
				cacheWrite: 0.0002,
				total: 0.0033,
			},
		});
		expect(result.usage !== undefined && "cacheWrite1h" in result.usage).toBe(
			false,
		);
		// D25：SessionManager.inMemory() 无参调用、每次调用恰一次；同一 marker 进 options。
		expect(mocks.inMemory).toHaveBeenCalledTimes(1);
		expect(mocks.inMemory).toHaveBeenCalledWith();
		const options = mocks.createAgentSession.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(options.sessionManager).toBe(sessionManagerMarker);
		// task 原样进 prompt（resolve 即本轮完成——D26 的 pi 内部重试在真 SDK 内发生）。
		expect(session.prompt).toHaveBeenCalledWith("hello agent");
		// D25：成功路径 dispose 必达（恰 1 次）。
		expect(session.dispose).toHaveBeenCalledTimes(1);
	});

	it("zero-fills missing numeric usage keys (D21/D29)", async () => {
		const session = fakeSession([
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				stopReason: "stop",
				usage: { input: 5, output: 6, totalTokens: 11, cacheWrite1h: 9 },
			},
		]);
		wireSuccess(session);
		const fresh = await freshPiSdk();

		const result = await fresh.createPiSdkExecutor({})(agentRequest());

		expect(result.usage).toEqual({
			input: 5,
			output: 6,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 11,
		});
	});

	it("omits the usage field entirely when the assistant message has none (D21)", async () => {
		const session = fakeSession([
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				stopReason: "stop",
			},
		]);
		wireSuccess(session);
		const fresh = await freshPiSdk();

		const result = await fresh.createPiSdkExecutor({})(agentRequest());

		expect(result.output).toBe("ok");
		expect(result.usage).toBeUndefined();
		expect("usage" in result).toBe(false);
	});

	it("joins multiple text blocks with a newline and skips non-text blocks (D24)", async () => {
		const session = fakeSession([
			{
				role: "assistant",
				content: [
					{ type: "thinking", text: "hmm" },
					{ type: "text", text: "a" },
					{ type: "toolCall", id: "c1", name: "read" },
					{ type: "text", text: "b" },
				],
				stopReason: "stop",
			},
		]);
		wireSuccess(session);
		const fresh = await freshPiSdk();

		const result = await fresh.createPiSdkExecutor({})(agentRequest());

		expect(result.output).toBe("a\nb");
	});
});

// ---------------------------------------------------------------------------
// ② schema 透传（D22）
// ---------------------------------------------------------------------------

describe("schema passthrough (D22)", () => {
	it("ignores req.schema: output stays the raw text and schema never reaches the sdk", async () => {
		const session = fakeSession([
			{
				role: "assistant",
				content: [{ type: "text", text: '{"answer":"raw"}' }],
				stopReason: "stop",
			},
		]);
		wireSuccess(session);
		const fresh = await freshPiSdk();
		const schema = { type: "object" } as TSchema;

		const result = await fresh.createPiSdkExecutor({})(
			agentRequest({ schema }),
		);

		// D22：schema 在 handler 层——适配器回原文，不解析不校验。
		expect(result.output).toBe('{"answer":"raw"}');
		const options = mocks.createAgentSession.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect("schema" in options).toBe(false);
		// prompt 只拿 task，不带 schema 指令（指令拼接在 handler 层）。
		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(session.prompt).toHaveBeenCalledWith("hello agent");
	});
});

// ---------------------------------------------------------------------------
// ③ verdict（D24，与 pi-subprocess 的 verdictOf 逐类同构）
// ---------------------------------------------------------------------------

describe("verdict (D24)", () => {
	it("stopReason 'error' keeps the upstream errorMessage verbatim (D3-reachable)", async () => {
		const session = fakeSession([
			{
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "503 Service Unavailable",
			},
		]);
		wireSuccess(session);
		const fresh = await freshPiSdk();

		const error = (await rejectionOf(
			fresh.createPiSdkExecutor({})(agentRequest()),
		)) as Error;

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("pi agent failed: 503 Service Unavailable");
		// 原文保留：瞬态文本仍能被 D3 正则族匹配（引擎重试才救得回来）。
		expect(isRetryableError(error)).toBe(true);
		expect(session.dispose).toHaveBeenCalledTimes(1);
	});

	it("stopReason 'error' without an errorMessage stays readable (no 'undefined')", async () => {
		const session = fakeSession([
			{ role: "assistant", content: [], stopReason: "error" },
		]);
		wireSuccess(session);
		const fresh = await freshPiSdk();

		const error = (await rejectionOf(
			fresh.createPiSdkExecutor({})(agentRequest()),
		)) as Error;

		expect(error.message).toBe(
			"pi agent failed: (pi reported an error without a message)",
		);
	});

	it("stopReason 'aborted' rejects with an AbortError (mirrors pi-subprocess)", async () => {
		const session = fakeSession([
			{
				role: "assistant",
				content: [{ type: "text", text: "half" }],
				stopReason: "aborted",
				errorMessage: "interrupted by user",
			},
		]);
		wireSuccess(session);
		const fresh = await freshPiSdk();

		const error = (await rejectionOf(
			fresh.createPiSdkExecutor({})(agentRequest()),
		)) as Error;

		expect(error.name).toBe("AbortError");
		expect(error.message).toContain("pi sdk agent aborted");
		expect(error.message).toContain("interrupted by user");
		expect(isRetryableError(error)).toBe(false); // 取消不属 D3 可重试族
		expect(session.dispose).toHaveBeenCalledTimes(1); // verdict 抛错路径 dispose 也不漏
	});

	it("stopReason 'length' fails without guessing success", async () => {
		const session = fakeSession([
			{
				role: "assistant",
				content: [{ type: "text", text: "truncat" }],
				stopReason: "length",
			},
		]);
		wireSuccess(session);
		const fresh = await freshPiSdk();

		const error = (await rejectionOf(
			fresh.createPiSdkExecutor({})(agentRequest()),
		)) as Error;

		expect(error.message).toBe(
			'pi agent failed: unsupported stopReason "length"',
		);
	});

	it("a message list without an assistant message fails with a dedicated message", async () => {
		const session = fakeSession([
			{ role: "user", content: [{ type: "text", text: "hello agent" }] },
		]);
		wireSuccess(session);
		const fresh = await freshPiSdk();

		const error = (await rejectionOf(
			fresh.createPiSdkExecutor({})(agentRequest()),
		)) as Error;

		expect(error.message).toBe("pi agent produced no assistant message");
	});
});

// ---------------------------------------------------------------------------
// ④ 取消组（冻结流程 ①④⑤⑥；镜像 M3 的预 abort 回归锁与 kill-then-reject 同构）
// ---------------------------------------------------------------------------

describe("cancellation (frozen flow ①④⑤⑥)", () => {
	it("rejects an already-aborted signal before any session work (nothing built, nothing disposed)", async () => {
		const fresh = await freshPiSdk();
		const controller = new AbortController();
		controller.abort(); // 先 abort 再调用（①：不建 session）

		const error = (await rejectionOf(
			fresh.createPiSdkExecutor({})(
				agentRequest({ signal: controller.signal }),
			),
		)) as Error;

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("AbortError");
		expect(error.message).toBe("pi sdk agent aborted");
		// 不建 session 的证据：runtime/session/dimension 全链路未触碰。
		expect(mocks.modelRuntimeCreate).not.toHaveBeenCalled();
		expect(mocks.inMemory).not.toHaveBeenCalled();
		expect(mocks.createAgentSession).not.toHaveBeenCalled();
		expect(isRetryableError(error)).toBe(false); // 取消不落 D3 族
	});

	it("rejects with an AbortError when the abort lands during createAgentSession (creation itself is not cancelable)", async () => {
		const session = fakeSession();
		let release: ((value: { session: unknown }) => void) | undefined;
		mocks.modelRuntimeCreate.mockResolvedValue({ getModel: mocks.getModel });
		mocks.getModel.mockReturnValue({ id: "model" });
		mocks.createAgentSession.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const fresh = await freshPiSdk();
		const controller = new AbortController();
		const pending = fresh.createPiSdkExecutor({})(
			agentRequest({ signal: controller.signal }),
		);

		// 等 createAgentSession 已被调（创建不可取消），abort 落在创建窗口内。
		await vi.waitFor(() =>
			expect(mocks.createAgentSession).toHaveBeenCalledTimes(1),
		);
		controller.abort();
		release?.({ session });

		const error = (await rejectionWithin(
			pending,
			5000,
			"create-window abort must fail fast",
		)) as Error;

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("AbortError");
		expect(error.message).toBe("pi sdk agent aborted"); // ④：创建后再查 aborted
		expect(session.prompt).not.toHaveBeenCalled();
		expect(session.dispose).toHaveBeenCalledTimes(1); // 恰 1 次：建成了就要弃
	});

	it("aborts a hanging prompt: signal fires, session.abort is called once, AbortError, disposed exactly once", async () => {
		const session = fakeSession();
		let release: (() => void) | undefined;
		session.prompt.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		// fake abort：翻转状态并让 prompt 收场（真实 SDK 的 abort 会打断本轮）。
		session.abort.mockImplementation(async () => {
			release?.();
		});
		wireSuccess(session);
		const fresh = await freshPiSdk();
		const controller = new AbortController();
		const pending = fresh.createPiSdkExecutor({})(
			agentRequest({ signal: controller.signal }),
		);

		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
		controller.abort(); // ⑤ 的 once 监听 → void session.abort()

		const error = (await rejectionWithin(
			pending,
			5000,
			"prompt abort must fail fast",
		)) as Error;

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("AbortError");
		expect(error.message).toBe("pi sdk agent aborted"); // ⑥：kill-then-reject 同构
		expect(session.abort).toHaveBeenCalledTimes(1);
		expect(session.dispose).toHaveBeenCalledTimes(1); // 恰 1 次
	});

	it("normalizes a prompt rejection that lands after abort into AbortError (kill-then-reject)", async () => {
		const session = fakeSession();
		let rejectPrompt: ((error: unknown) => void) | undefined;
		session.prompt.mockImplementation(
			() =>
				new Promise<void>((_, reject) => {
					rejectPrompt = reject;
				}),
		);
		session.abort.mockImplementation(async () => {
			rejectPrompt?.(new Error("pi internal interruption"));
		});
		wireSuccess(session);
		const fresh = await freshPiSdk();
		const controller = new AbortController();
		const pending = fresh.createPiSdkExecutor({})(
			agentRequest({ signal: controller.signal }),
		);

		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
		controller.abort();

		const error = (await rejectionWithin(
			pending,
			5000,
			"abort must swallow the prompt rejection",
		)) as Error;

		// 取消路径的成败由 signal 驱动：pi 内部的中断错误不得泄漏成失败原因。
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("AbortError");
		expect(error.message).toBe("pi sdk agent aborted");
		expect(session.dispose).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// ⑤ model 解析（D27）
// ---------------------------------------------------------------------------

describe("model resolution (D27)", () => {
	it("parses '<provider>/<id>' at the first '/' and passes runtime+model to createAgentSession together", async () => {
		const session = fakeSession([
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				stopReason: "stop",
			},
		]);
		const fakeModel = { id: "model/v2" };
		wireSuccess(session, fakeModel);
		const fresh = await freshPiSdk();
		// req.model 优先于 config.defaultModel（D23 的解析次序，D27 同口径）。
		const executor = fresh.createPiSdkExecutor({ defaultModel: "def/ault" });

		await executor(agentRequest({ model: "test/model/v2" }));

		expect(mocks.getModel).toHaveBeenCalledWith("test", "model/v2");
		expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
		const options = mocks.createAgentSession.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		// 单一 runtime 实例，不双建（D27）：runtime 与 model 同传。
		const runtime = (await mocks.modelRuntimeCreate.mock.results[0]
			?.value) as unknown;
		expect(options.modelRuntime).toBe(runtime);
		expect(options.model).toBe(fakeModel);
	});

	it("omits the model key when neither req.model nor defaultModel is set; still creates the ModelRuntime (D27)", async () => {
		const session = fakeSession([
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				stopReason: "stop",
			},
		]);
		wireSuccess(session);
		const fresh = await freshPiSdk();

		await fresh.createPiSdkExecutor({})(agentRequest({ model: undefined }));

		expect(mocks.getModel).not.toHaveBeenCalled(); // 串缺省：不解析
		expect(mocks.modelRuntimeCreate).toHaveBeenCalledTimes(1); // runtime 仍建
		expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
		const options = mocks.createAgentSession.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect("model" in options).toBe(false); // session 默认选型
	});

	it("maps agentDir to authPath/modelsPath and passes nothing otherwise (D27)", async () => {
		const session = fakeSession([
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				stopReason: "stop",
			},
		]);
		wireSuccess(session);
		const fresh = await freshPiSdk();

		await fresh.createPiSdkExecutor({ agentDir: "/agent-dir-x" })(
			agentRequest(),
		);
		expect(mocks.modelRuntimeCreate).toHaveBeenCalledTimes(1);
		expect(mocks.modelRuntimeCreate).toHaveBeenCalledWith({
			authPath: join("/agent-dir-x", "auth.json"),
			modelsPath: join("/agent-dir-x", "models.json"),
		});

		// agentDir 缺省 → 全默认：create() 不带选项对象（等价 session 内部默认，D27）。
		await fresh.createPiSdkExecutor({})(agentRequest());
		expect(mocks.modelRuntimeCreate).toHaveBeenCalledTimes(2);
		expect(mocks.modelRuntimeCreate.mock.calls[1][0]).toBeUndefined();
	});

	it("fails with an actionable error for invalid model shapes without calling createAgentSession", async () => {
		const session = fakeSession();
		wireSuccess(session);
		const fresh = await freshPiSdk();
		const executor = fresh.createPiSdkExecutor({});

		const noSlash = (await rejectionOf(
			executor(agentRequest({ model: "no-slash" })),
		)) as Error;
		expect(noSlash.message).toContain("pi sdk adapter: invalid model");
		expect(noSlash.message).toContain("<provider>/<id>");
		expect(noSlash.message).toContain("no-slash");
		expect(isRetryableError(noSlash)).toBe(false); // 作者错误不落 D3 族

		const emptyId = (await rejectionOf(
			executor(agentRequest({ model: "openai/" })),
		)) as Error;
		expect(emptyId.message).toContain("openai/");

		// 两轮都没走到建会话（作者错误在发请求之前）。
		expect(mocks.createAgentSession).not.toHaveBeenCalled();
		expect(mocks.getModel).not.toHaveBeenCalled();
	});

	it("fails with an actionable error when getModel misses, without calling createAgentSession", async () => {
		const session = fakeSession();
		mocks.modelRuntimeCreate.mockResolvedValue({ getModel: mocks.getModel });
		mocks.getModel.mockReturnValue(undefined);
		const fresh = await freshPiSdk();

		const error = (await rejectionOf(
			fresh.createPiSdkExecutor({})(agentRequest({ model: "nope/none" })),
		)) as Error;

		expect(error.message).toContain("pi sdk adapter: unknown model");
		expect(error.message).toContain('"nope/none"');
		expect(isRetryableError(error)).toBe(false);
		// 冻结顺序：ModelRuntime 已建（解析在其后），但会话绝不建。
		expect(mocks.modelRuntimeCreate).toHaveBeenCalledTimes(1);
		expect(mocks.createAgentSession).not.toHaveBeenCalled();
		expect(session.dispose).not.toHaveBeenCalled(); // session 未建成：无从 dispose
	});
});

// ---------------------------------------------------------------------------
// ⑥ tools 映射（D29）
// ---------------------------------------------------------------------------

describe("tools mapping (D29)", () => {
	it("passes a non-empty tools allowlist through by reference", async () => {
		const session = fakeSession([
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				stopReason: "stop",
			},
		]);
		wireSuccess(session);
		const fresh = await freshPiSdk();
		const tools = ["read"];

		await fresh.createPiSdkExecutor({})(agentRequest({ tools }));

		const options = mocks.createAgentSession.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(options.tools).toBe(tools); // 同引用（allowlist 原样透传）
	});

	it("omits the tools key for an empty array and for absent tools (D29)", async () => {
		const session = fakeSession([
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				stopReason: "stop",
			},
		]);
		wireSuccess(session);
		const fresh = await freshPiSdk();

		await fresh.createPiSdkExecutor({})(agentRequest({ tools: [] }));
		let options = mocks.createAgentSession.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect("tools" in options).toBe(false); // 空数组视同未配置（pi 默认工具集）

		await fresh.createPiSdkExecutor({})(agentRequest({ tools: undefined }));
		options = mocks.createAgentSession.mock.calls[1][0] as Record<
			string,
			unknown
		>;
		expect("tools" in options).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// ⑦ 可用性与加载（D28）
// ---------------------------------------------------------------------------

describe("availability and loading (D28)", () => {
	it("isPiSdkAvailable mirrors the probe and caches it (second call does not re-probe)", async () => {
		mocks.probePeerPackage.mockReturnValue(true);
		const fresh = await freshPiSdk();

		expect(fresh.isPiSdkAvailable()).toBe(true);
		expect(fresh.isPiSdkAvailable()).toBe(true);
		expect(mocks.probePeerPackage).toHaveBeenCalledTimes(1);
		expect(mocks.probePeerPackage).toHaveBeenCalledWith(
			"@earendil-works/pi-coding-agent",
		);
	});

	it("isPiSdkAvailable returns false on a probe miss and never throws", async () => {
		mocks.probePeerPackage.mockReturnValue(false);
		const fresh = await freshPiSdk();

		expect(fresh.isPiSdkAvailable()).toBe(false);
		expect(fresh.isPiSdkAvailable()).toBe(false);
		expect(mocks.probePeerPackage).toHaveBeenCalledTimes(1);
	});

	it("fails with an actionable error when the sdk cannot be loaded, and caches the failure", async () => {
		mocks.state.brokenPeer = true; // barrel 属性访问即抛：加载期形态
		const fresh = await freshPiSdk();
		const executor = fresh.createPiSdkExecutor({});

		const error = (await rejectionOf(executor(agentRequest()))) as Error;

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain(
			'pi sdk adapter: could not load "@earendil-works/pi-coding-agent"',
		);
		expect(error.message).toContain("npm i @earendil-works/pi-coding-agent");
		expect(error.message).toContain("simulated broken peer install");
		expect(error.cause).toBeInstanceOf(Error);
		expect(isRetryableError(error)).toBe(false); // 环境错误不落 D3 族

		// 失败缓存：修好 barrel 之后同实例再调——不得重新加载，仍复抛同一错误。
		mocks.state.brokenPeer = false;
		wireSuccess(fakeSession());
		const again = (await rejectionOf(executor(agentRequest()))) as Error;
		expect(again.message).toBe(error.message);
		expect(mocks.createAgentSession).not.toHaveBeenCalled();

		// re-import（不清模块注册表）拿到的仍是同一实例：缓存命中不变。
		const reimported = await import("../../src/runtime/pi-sdk.js");
		expect(reimported).toBe(fresh);
		const third = (await rejectionOf(
			reimported.createPiSdkExecutor({})(agentRequest()),
		)) as Error;
		expect(third.message).toBe(error.message);
	});
});
