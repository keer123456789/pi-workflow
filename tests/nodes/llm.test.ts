/**
 * Task 6：`llmNode` 工厂与 `bindLlmNode` 绑定（D12/D15）。
 *
 * 全部用例注入 fake `complete`（无网络、无 pi-ai）——绑定机制的注入点就是
 * `bindLlmNode(def, complete)`。重试分类用内部模块 `src/core/retry.js` 的
 * `isRetryableError` 断言：JSON/schema 失败的消息本身都不落 D3 的正则族，
 * 命中即证明靠 `markRetryable` 标记。
 */

import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { TemplateError } from "../../src/core/errors.js";
import { isRetryableError } from "../../src/core/retry.js";
import type { NodeContext, NodeDefinition } from "../../src/core/types.js";
import { bindLlmNode, llmNode } from "../../src/nodes/llm.js";
import type { CompleteFn, TokenUsage } from "../../src/runtime/executor.js";

type Reply = { answer: string; confidence: number };
type State = { question: string; user: string; reply: Reply | null };

const replySchema = Type.Object({
	answer: Type.String(),
	confidence: Type.Number(),
});

const VALID_TEXT = '{"answer":"42","confidence":1}';
const INPUT: State = { question: "life", user: "alice", reply: null };

function makeCtx(overrides?: Partial<NodeContext>): NodeContext {
	return {
		runId: "run-1",
		superstep: 0,
		instanceId: "reply#1",
		seq: 1,
		signal: new AbortController().signal,
		...overrides,
	};
}

/** 记录请求、固定回答的 fake complete。 */
function fakeComplete(
	text: string,
	usage?: TokenUsage,
): { complete: CompleteFn; calls: Parameters<CompleteFn>[0][] } {
	const calls: Parameters<CompleteFn>[0][] = [];
	const complete: CompleteFn = async (req) => {
		calls.push(req);
		return usage === undefined ? { text } : { text, usage };
	};
	return { complete, calls };
}

/** 绑定一个最简 llm 定义（字符串 prompt 走插值，writeTo: "reply"）。 */
function boundDef(complete: CompleteFn): NodeDefinition<State> {
	return bindLlmNode(
		llmNode<State, "reply">({
			prompt: "answer {question}",
			schema: replySchema,
			writeTo: "reply",
		}),
		complete,
	);
}

/** 取 rejection 的抛值（fulfil 时是 undefined——调用方必须断言其为 Error）。 */
async function rejectionOf(value: unknown): Promise<unknown> {
	return Promise.resolve(value).then(
		() => undefined,
		(error: unknown) => error,
	);
}

describe("llmNode", () => {
	it("interpolates a string prompt from the instance input and calls the bound complete", async () => {
		const { complete, calls } = fakeComplete(VALID_TEXT);
		const ctx = makeCtx();
		const def = bindLlmNode(
			llmNode<State, "reply">({
				prompt: "Q: {question} (by {user})",
				schema: replySchema,
				writeTo: "reply",
				model: "test/model",
			}),
			complete,
		);

		const out = await def.handler(INPUT, ctx);

		expect(calls).toHaveLength(1);
		expect(calls[0].prompt).toBe("Q: life (by alice)");
		expect(calls[0].model).toBe("test/model");
		expect(calls[0].schema).toBe(replySchema);
		expect(calls[0].signal).toBe(ctx.signal);
		expect(out).toEqual({ answer: "42", confidence: 1 });
	});

	it("parses JSON output, accepts it when the schema passes, and returns the raw value (writeTo wrapping is the engine's job)", async () => {
		const { complete } = fakeComplete(VALID_TEXT);

		const out = await boundDef(complete).handler(INPUT, makeCtx());

		expect(out).toEqual({ answer: "42", confidence: 1 });
		// 解析值本身即返回值——`{ reply: 值 }` 的包裹是引擎 updateOf 的职责（§5.1:354）。
		expect(out).not.toHaveProperty("reply");
	});

	it("strips ```json fences before parsing", async () => {
		const fenced = fakeComplete(`\`\`\`json\n${VALID_TEXT}\n\`\`\``);
		const bare = fakeComplete(`\`\`\`\n${VALID_TEXT}\n\`\`\``);

		expect(await boundDef(fenced.complete).handler(INPUT, makeCtx())).toEqual({
			answer: "42",
			confidence: 1,
		});
		expect(await boundDef(bare.complete).handler(INPUT, makeCtx())).toEqual({
			answer: "42",
			confidence: 1,
		});
	});

	it("marks JSON/schema failures retryable and throws a message carrying the schema error", async () => {
		// JSON 解析失败：消息带解析原因与原文预览。
		const jsonFail = await rejectionOf(
			boundDef(fakeComplete("I cannot produce JSON").complete).handler(
				INPUT,
				makeCtx(),
			),
		);
		expect(jsonFail).toBeInstanceOf(Error);
		expect((jsonFail as Error).message).toContain("not valid JSON");
		expect((jsonFail as Error).message).toContain("I cannot produce JSON");
		expect(isRetryableError(jsonFail)).toBe(true);

		// schema 违规：消息带紧凑的 schema 错误详情（路径 + 类型消息）。
		const schemaFail = await rejectionOf(
			boundDef(
				fakeComplete('{"answer":42,"confidence":"high"}').complete,
			).handler(INPUT, makeCtx()),
		);
		expect(schemaFail).toBeInstanceOf(Error);
		expect((schemaFail as Error).message).toContain("/answer");
		expect((schemaFail as Error).message).toContain("must be string");
		expect(isRetryableError(schemaFail)).toBe(true);
	});

	it("reports usage via ctx.reportUsage when complete returns usage", async () => {
		const usage: TokenUsage = {
			input: 10,
			output: 5,
			cacheRead: 1,
			cacheWrite: 2,
			totalTokens: 15,
		};
		const reported: TokenUsage[] = [];
		const { complete } = fakeComplete(VALID_TEXT, usage);

		await boundDef(complete).handler(
			INPUT,
			makeCtx({ reportUsage: (u) => reported.push(u) }),
		);
		expect(reported).toEqual([usage]);

		// 未返回 usage、或 ctx 没有 reportUsage（手工组装）→ 不上报、不炸。
		reported.length = 0;
		const noUsage = fakeComplete(VALID_TEXT).complete;
		const collect = makeCtx({ reportUsage: (u) => reported.push(u) });
		await boundDef(noUsage).handler(INPUT, collect);
		await boundDef(noUsage).handler(INPUT, makeCtx());
		expect(reported).toEqual([]);

		// 失败尝试不上报（D11：只有成功尝试的用量进 node_finished）。
		const failed: TokenUsage[] = [];
		await rejectionOf(
			boundDef(fakeComplete("not json", usage).complete).handler(
				INPUT,
				makeCtx({ reportUsage: (u) => failed.push(u) }),
			),
		);
		expect(failed).toEqual([]);
	});

	it("defaults timeoutMs to 120_000 and passes retry through", async () => {
		const { complete, calls } = fakeComplete(VALID_TEXT);
		const def = llmNode<State, "reply">({
			prompt: "p",
			schema: replySchema,
			writeTo: "reply",
		});

		expect(def.kind).toBe("llm");
		expect(def.name).toBe("");
		expect(def.timeoutMs).toBe(120_000);
		expect(def.retry).toBeUndefined();

		const retried = llmNode<State, "reply">({
			prompt: "p",
			schema: replySchema,
			writeTo: "reply",
			retry: { maxAttempts: 3 },
			timeoutMs: 5_000,
		});
		expect(retried.retry).toEqual({ maxAttempts: 3 });
		expect(retried.timeoutMs).toBe(5_000);

		// 归一后的超时同时传给 complete（适配器按同一预算自限）。
		await bindLlmNode(def, complete).handler(INPUT, makeCtx());
		expect(calls[0].timeoutMs).toBe(120_000);
	});

	it("a function prompt receives the raw instance input", async () => {
		const { complete, calls } = fakeComplete(VALID_TEXT);
		const seen: unknown[] = [];
		const def = bindLlmNode(
			llmNode<State, "reply">({
				prompt: (input) => {
					seen.push(input);
					return `P:${(input as { question: string }).question}`;
				},
				schema: replySchema,
				writeTo: "reply",
			}),
			complete,
		);

		await def.handler(INPUT, makeCtx());

		// 同一引用：raw instance input——不克隆、不插值（函数 prompt 自己负责）。
		expect(seen).toEqual([INPUT]);
		expect(seen[0]).toBe(INPUT);
		expect(calls[0].prompt).toBe("P:life");
	});

	it("does not mark prompt template failures retryable (authoring errors fail fast, no completion call)", async () => {
		const { complete, calls } = fakeComplete(VALID_TEXT);
		const def = bindLlmNode(
			llmNode<State, "reply">({
				prompt: "missing {nope}",
				schema: replySchema,
				writeTo: "reply",
			}),
			complete,
		);

		const error = await rejectionOf(def.handler(INPUT, makeCtx()));

		expect(error).toBeInstanceOf(TemplateError);
		expect(isRetryableError(error)).toBe(false);
		expect(calls).toHaveLength(0); // 模板都求不出来 → 不调补全（不烧 token）
	});

	it("throws a clear 'llm node is not bound' error when the definition was never bound", () => {
		const def = llmNode<State, "reply">({
			prompt: "p",
			schema: replySchema,
			writeTo: "reply",
		});

		expect(() => def.handler(INPUT, makeCtx())).toThrowError(
			/llm node is not bound/,
		);
	});

	it("pre-binds when cfg.complete is provided and lets bindLlmNode override it (idempotent/overridable)", async () => {
		const first = vi.fn(async () => ({ text: VALID_TEXT }));
		const second = vi.fn(async () => ({
			text: '{"answer":"other","confidence":2}',
		}));
		const def = llmNode<State, "reply">({
			prompt: "p",
			schema: replySchema,
			writeTo: "reply",
			complete: first,
		});

		expect(def.complete).toBe(first);
		expect(await def.handler(INPUT, makeCtx())).toEqual({
			answer: "42",
			confidence: 1,
		});
		expect(first).toHaveBeenCalledTimes(1);

		// 重绑产出**新**定义（不改原件）：换一个 complete 覆盖。
		const rebound = bindLlmNode(def, second);
		expect(rebound).not.toBe(def);
		expect(await rebound.handler(INPUT, makeCtx())).toEqual({
			answer: "other",
			confidence: 2,
		});
		expect(second).toHaveBeenCalledTimes(1);
		expect(def.complete).toBe(first);
	});

	it("binds the addNode-registered shallow copy (pending config follows the shared handler)", async () => {
		const { complete, calls } = fakeComplete(VALID_TEXT);
		const def = llmNode<State, "reply">({
			prompt: "copy {question}",
			schema: replySchema,
			writeTo: "reply",
		});
		// 模拟 StateGraph.addNode 的注册副本：`{ ...node, name }`——对象不同、
		// handler 引用共享（compile 期绑定拿到的正是注册副本，Task 8）。
		const registered = { ...def, name: "reply" };

		const out = await bindLlmNode(registered, complete).handler(
			INPUT,
			makeCtx(),
		);

		expect(calls[0].prompt).toBe("copy life");
		expect(out).toEqual({ answer: "42", confidence: 1 });
	});

	it("leaves a definition not produced by llmNode unchanged (no-op: its own handler stands)", () => {
		const handler = async (): Promise<Partial<State>> => ({
			reply: { answer: "mine", confidence: 0 },
		});
		const foreign: NodeDefinition<State> = {
			kind: "llm",
			name: "hand-written",
			handler,
		};

		const bound = bindLlmNode(foreign, async () => ({ text: VALID_TEXT }));

		// NodeDefinition 是公开类型：手工定义的 handler 就是既定行为，不替换。
		expect(bound).toBe(foreign);
		expect(bound.handler).toBe(handler);
	});
});
