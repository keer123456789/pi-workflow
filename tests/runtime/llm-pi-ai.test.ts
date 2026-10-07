/**
 * Task 7：pi-ai 默认补全适配器（D13）。
 *
 * 与 pi-ai 的交互全部由 `vi.mock` 顶替——**两个模块路径**都换掉：根 barrel 供
 * `contentText`、`providers/all` 供 `builtinModels`（pi-ai@1.0.4 实测的导出位置，
 * 根 barrel 不含 `builtinModels`）。假 Models 集合只登记 `getModel`/`completeSimple`，
 * 用例对调用形状与映射逐条断言；**无网络、无凭据、无真实模型**。
 *
 * `isPiAiAvailable()` 的用例走**真实**解析路径（不 mock `node:module`）：仓库把 pi-ai
 * 装在 devDependencies 里，探测对真包的结果应为 true——这条正是"只按字面用
 * createRequire 会误报 false"的护栏（见适配器 `probePiAi` 的注释）。"对等依赖未安装"
 * 的 false 路径由 Task 8 的 compile 用例覆盖（D13：vi.mock `llm-pi-ai.js` 模块本身）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { isRetryableError } from "../../src/core/retry.js";
import {
	defaultPiAiComplete,
	isPiAiAvailable,
} from "../../src/runtime/llm-pi-ai.js";

/** 假 pi-ai 表面（vi.hoisted：mock 工厂与用例共享同一批替身）。 */
const mocks = vi.hoisted(() => {
	const completeSimple = vi.fn();
	const getModel = vi.fn();
	const builtinModels = vi.fn(() => ({ getModel, completeSimple }));
	const contentText = vi.fn(() => "");
	return { completeSimple, getModel, builtinModels, contentText };
});

vi.mock("@earendil-works/pi-ai", () => ({ contentText: mocks.contentText }));
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
	builtinModels: mocks.builtinModels,
}));

/** 适配器真正读的 AssistantMessage 字段（其余用 `Partial` 覆盖逐例给）。 */
type FakeAssistantMessage = {
	content: unknown[];
	usage: unknown;
	stopReason: string;
	errorMessage?: string;
};

/** 一条最简助手消息：内容/usage/stopReason 齐全，用例按需覆盖。 */
function assistantMessage(
	overrides: Partial<FakeAssistantMessage> = {},
): FakeAssistantMessage {
	return {
		content: [{ type: "text", text: "hello" }],
		usage: {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		...overrides,
	};
}

/** 一次补全请求（信号逐例给，便于断言同一引用透传）。 */
function request(
	overrides: Partial<
		Parameters<ReturnType<typeof defaultPiAiComplete>>[0]
	> = {},
): Parameters<ReturnType<typeof defaultPiAiComplete>>[0] {
	return {
		prompt: "ping",
		model: "test/model",
		signal: new AbortController().signal,
		timeoutMs: 1_000,
		...overrides,
	};
}

/** 取 rejection 的抛值（fulfil 时是 undefined——调用方必须断言其为 Error）。 */
async function rejectionOf(value: unknown): Promise<unknown> {
	return Promise.resolve(value).then(
		() => undefined,
		(error: unknown) => error,
	);
}

beforeEach(() => {
	// 只清调用记录：`builtinModels` 的实现（vi.hoisted 里给的）与各用例显式设的
	// mockReturnValue/mockResolvedValue 由用例自己负责，避免跨用例串味。
	vi.clearAllMocks();
});

describe("defaultPiAiComplete", () => {
	it("splits '<provider>/<id>' at the first '/' and calls completeSimple with the prompt and signal", async () => {
		const model = { provider: "test", id: "model" };
		const message = assistantMessage();
		mocks.getModel.mockReturnValue(model);
		mocks.completeSimple.mockResolvedValue(message);
		mocks.contentText.mockReturnValue("pong");
		const signal = new AbortController().signal;

		const result = await defaultPiAiComplete()(
			request({ prompt: "ping", model: "test/model/v2", signal }),
		);

		// 第一个 `/` 之前是 provider，其余（含后续 `/`）整体是模型 id（D13）。
		expect(mocks.getModel).toHaveBeenCalledWith("test", "model/v2");
		expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
		const [passedModel, context, options] = mocks.completeSimple.mock.calls[0];
		expect(passedModel).toBe(model);
		expect(context.messages).toHaveLength(1);
		expect(context.messages[0]).toMatchObject({
			role: "user",
			content: "ping",
		});
		expect(typeof context.messages[0].timestamp).toBe("number");
		// 转发形状就是 `{ signal }`：同一引用透传（timeoutMs 由引擎 abort 该 signal 落地）。
		expect(Object.keys(options)).toEqual(["signal"]);
		expect(options.signal).toBe(signal);
		// 文本来源：contentText(助手消息内容)。
		expect(mocks.contentText).toHaveBeenCalledWith(message.content);
		expect(result.text).toBe("pong");
	});

	it("maps AssistantMessage text and usage (input/output/cacheRead/cacheWrite/totalTokens/cost)", async () => {
		const content = [{ type: "text", text: "answer" }];
		const usage = {
			input: 11,
			output: 22,
			cacheRead: 33,
			cacheWrite: 44,
			cacheWrite1h: 5,
			reasoning: 6,
			totalTokens: 66,
			cost: {
				input: 0.001,
				output: 0.002,
				cacheRead: 0.003,
				cacheWrite: 0.004,
				total: 0.01,
			},
		};
		mocks.getModel.mockReturnValue({});
		mocks.completeSimple.mockResolvedValue({
			content,
			usage,
			stopReason: "stop",
		});
		mocks.contentText.mockReturnValue("answer");

		const result = await defaultPiAiComplete()(request());

		expect(mocks.contentText).toHaveBeenCalledWith(content);
		expect(result).toEqual({
			text: "answer",
			usage: {
				input: 11,
				output: 22,
				cacheRead: 33,
				cacheWrite: 44,
				totalTokens: 66,
				cost: {
					input: 0.001,
					output: 0.002,
					cacheRead: 0.003,
					cacheWrite: 0.004,
					total: 0.01,
				},
			},
		});
		// D4 形状：pi-ai 独有的 cacheWrite1h/reasoning 不进 TokenUsage。
		expect(Object.keys(result.usage ?? {})).toEqual([
			"input",
			"output",
			"cacheRead",
			"cacheWrite",
			"totalTokens",
			"cost",
		]);

		// 源 usage 没有 cost（自定义网关可以不报）→ 结果**连键都没有**。
		mocks.completeSimple.mockResolvedValue({
			content,
			usage: {
				input: 7,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
			},
			stopReason: "length",
		});
		const bare = await defaultPiAiComplete()(request());
		expect(bare.usage).toEqual({
			input: 7,
			output: 8,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
		});
		expect(bare.usage !== undefined && "cost" in bare.usage).toBe(false);
	});

	it("throws with errorMessage when stopReason is 'error' (and keeps the D3 retry family reachable)", async () => {
		mocks.getModel.mockReturnValue({});
		mocks.completeSimple.mockResolvedValue(
			assistantMessage({
				content: [],
				stopReason: "error",
				errorMessage: "429 Too Many Requests: rate limit exceeded",
			}),
		);

		const error = await rejectionOf(defaultPiAiComplete()(request()));

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("pi-ai completion failed");
		expect((error as Error).message).toContain(
			"429 Too Many Requests: rate limit exceeded",
		);
		// D3：provider 原文留在消息里，瞬态文本仍能被分类器认出来（重试才救得回来）。
		expect(isRetryableError(error)).toBe(true);
		expect(mocks.contentText).not.toHaveBeenCalled(); // 失败不产出文本

		// 没有 errorMessage 也要有可读的失败消息（不出现 "undefined"）。
		mocks.completeSimple.mockResolvedValue(
			assistantMessage({ content: [], stopReason: "error" }),
		);
		const bare = await rejectionOf(defaultPiAiComplete()(request()));
		expect(bare).toBeInstanceOf(Error);
		expect((bare as Error).message).toContain("pi-ai completion failed");
		expect((bare as Error).message).not.toContain("undefined");
		expect(isRetryableError(bare)).toBe(false); // 无瞬态线索 → 不重试（D3 保守）
	});

	it("throws a readable error for a missing '/' or unknown model", async () => {
		const complete = defaultPiAiComplete();

		// 缺 `/`：说出期望形状并带上原串。
		const noSlash = await rejectionOf(complete(request({ model: "gpt-4o" })));
		expect(noSlash).toBeInstanceOf(Error);
		expect((noSlash as Error).message).toContain("<provider>/<id>");
		expect((noSlash as Error).message).toContain("gpt-4o");

		// 空 id（"openai/"）与空 provider（"/x"）同属作者错误。
		const emptyId = await rejectionOf(complete(request({ model: "openai/" })));
		expect(emptyId).toBeInstanceOf(Error);
		expect((emptyId as Error).message).toContain("openai/");
		const emptyProvider = await rejectionOf(complete(request({ model: "/x" })));
		expect(emptyProvider).toBeInstanceOf(Error);
		expect((emptyProvider as Error).message).toContain("/x");

		// 根本没配 model：提示两条可行动路线。
		const noModel = await rejectionOf(complete(request({ model: undefined })));
		expect(noModel).toBeInstanceOf(Error);
		expect((noModel as Error).message).toContain("no model configured");
		expect((noModel as Error).message).toContain("services.complete");

		// 未知模型：getModel 未命中 → 报错带 provider/id 原文，且**不发请求**。
		mocks.getModel.mockReturnValue(undefined);
		const unknown = await rejectionOf(
			complete(request({ model: "nope/none" })),
		);
		expect(unknown).toBeInstanceOf(Error);
		expect((unknown as Error).message).toContain("unknown model");
		expect((unknown as Error).message).toContain('"nope/none"');
		expect(mocks.getModel).toHaveBeenLastCalledWith("nope", "none");
		expect(mocks.completeSimple).not.toHaveBeenCalled();
		// 作者错误不属 D3 重试族：立即失败，不空烧重试预算。
		expect(isRetryableError(unknown)).toBe(false);
		expect(isRetryableError(noSlash)).toBe(false);
	});

	it("fails with an actionable error when the peer cannot be loaded", async () => {
		// 新模块实例 + 让 builtinModels() 抛错 = "装不上/装坏了"的运行期形态。
		vi.resetModules();
		mocks.builtinModels.mockImplementationOnce(() => {
			throw new Error("simulated missing peer");
		});
		const fresh = await import("../../src/runtime/llm-pi-ai.js");

		const error = await rejectionOf(fresh.defaultPiAiComplete()(request()));

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			'could not load "@earendil-works/pi-ai"',
		);
		expect((error as Error).message).toContain("npm i @earendil-works/pi-ai");
		expect((error as Error).message).toContain("simulated missing peer");
		expect((error as Error).cause).toBeInstanceOf(Error);

		// 加载失败被该实例记住：再调用一次不会重新加载（仍报同一条错）。
		const again = await rejectionOf(fresh.defaultPiAiComplete()(request()));
		expect((again as Error).message).toContain("simulated missing peer");
		expect(mocks.builtinModels).toHaveBeenCalledTimes(1);
	});

	it("returns the same instance on repeated calls (single Models build)", async () => {
		vi.resetModules();
		const fresh = await import("../../src/runtime/llm-pi-ai.js");

		// 懒：模块加载与取函数都不建 Models 集合。
		expect(mocks.builtinModels).not.toHaveBeenCalled();
		const a = fresh.defaultPiAiComplete();
		const b = fresh.defaultPiAiComplete();
		expect(mocks.builtinModels).not.toHaveBeenCalled();

		// 单例：重复调用返回**同一实例**。
		expect(a).toBe(b);

		// 首次调用才建，且整实例只建一次（两次调用复用同一 Models 集合）。
		mocks.builtinModels.mockImplementation(() => ({
			getModel: mocks.getModel,
			completeSimple: mocks.completeSimple,
		}));
		mocks.getModel.mockReturnValue({});
		mocks.completeSimple.mockResolvedValue(assistantMessage());
		mocks.contentText.mockReturnValue("ok");
		await a(request());
		await b(request());
		expect(mocks.builtinModels).toHaveBeenCalledTimes(1);
		expect(mocks.completeSimple).toHaveBeenCalledTimes(2);
	});
});

describe("isPiAiAvailable", () => {
	it("mirrors whether the peer is resolvable, never throws, and caches the probe", () => {
		// 独立解算器：真包在 devDependencies 里（本仓库）→ true。
		let resolvable = true;
		try {
			import.meta.resolve("@earendil-works/pi-ai");
		} catch {
			resolvable = false;
		}

		expect(isPiAiAvailable()).toBe(resolvable);
		expect(isPiAiAvailable()).toBe(true); // 重复调用稳定（进程内缓存）
	});
});
