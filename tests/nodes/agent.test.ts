/**
 * M3/T2：`agentNode` 工厂与 `bindAgentNode` 绑定（D20/D22——D12 的 agent 镜像）。
 *
 * 全部用例注入 fake `AgentExecutor`（无网络、无 pi CLI——subprocess 适配器归 T3，
 * 本任务的 compile 解析对自定义函数直接绑定）。重试分类用内部模块
 * `src/core/retry.js` 的 `isRetryableError` 断言：JSON/schema 失败的消息本身都不落
 * D3 的正则族，命中即证明靠 `markRetryable` 标记。
 */

import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { TemplateError } from "../../src/core/errors.js";
import { StateGraph } from "../../src/core/graph.js";
import { isRetryableError } from "../../src/core/retry.js";
import {
	END,
	type NodeContext,
	type NodeDefinition,
	START,
} from "../../src/core/types.js";
import {
	agentExecutorOf,
	agentNode,
	bindAgentNode,
} from "../../src/nodes/agent.js";
import type { AgentExecutor, TokenUsage } from "../../src/runtime/executor.js";

type Verdict = { risk: string; score: number };
type State = {
	question: string;
	user: string;
	verdict: Verdict | null;
	conclusion: string;
};

const verdictSchema = Type.Object({
	risk: Type.String(),
	score: Type.Number(),
});

const VALID = '{"risk":"low","score":2}';
const FENCED = `\`\`\`json\n${VALID}\n\`\`\``;
// D22 逐字的 schema 指令（拼在 task 插值结果之后，不参与插值）。
const INSTRUCTION =
	"\n\n输出约束：最终输出只包含一个符合以下 JSON Schema 的 JSON 对象，不要包含任何其他文本或代码栅栏：\n" +
	JSON.stringify(verdictSchema);
const INPUT: State = {
	question: "life",
	user: "alice",
	verdict: null,
	conclusion: "",
};

function makeCtx(overrides?: Partial<NodeContext>): NodeContext {
	return {
		runId: "run-1",
		superstep: 0,
		instanceId: "verdict#1",
		seq: 1,
		signal: new AbortController().signal,
		...overrides,
	};
}

/** 记录请求、固定回答的 fake executor。 */
function fakeExecutor(
	output: string,
	usage?: TokenUsage,
): { executor: AgentExecutor; calls: Parameters<AgentExecutor>[0][] } {
	const calls: Parameters<AgentExecutor>[0][] = [];
	const executor: AgentExecutor = async (req) => {
		calls.push(req);
		return usage === undefined ? { output } : { output, usage };
	};
	return { executor, calls };
}

/** 绑定一个最简 schema 模式定义（字符串 task 走插值，writeTo: "verdict"）。
 *  声明形态的 executor 填 "subprocess" 占位——handler 层测试不经过 compile 解析，
 *  绑定用下面的 fake executor 显式完成。 */
function boundSchemaDef(executor: AgentExecutor): NodeDefinition<State> {
	return bindAgentNode(
		agentNode<State, "verdict">({
			task: "check {question}",
			schema: verdictSchema,
			writeTo: "verdict",
			executor: "subprocess",
		}),
		executor,
	);
}

/** 取 rejection 的抛值（fulfil 时是 undefined——调用方必须断言其为 Error）。 */
async function rejectionOf(value: unknown): Promise<unknown> {
	return Promise.resolve(value).then(
		() => undefined,
		(error: unknown) => error,
	);
}

describe("agentNode", () => {
	it("text mode: returns the raw output and the engine wraps it onto the writeTo key", async () => {
		const { executor, calls } = fakeExecutor("结论文本");

		// handler 层：返回产出值本身——`{ conclusion: 值 }` 的包裹是引擎 updateOf 的事。
		const out = await bindAgentNode(
			agentNode<State, "conclusion">({
				task: "check {question}",
				writeTo: "conclusion",
				executor,
			}),
			executor,
		).handler(INPUT, makeCtx());
		expect(out).toBe("结论文本");
		expect(out).not.toHaveProperty("conclusion");
		expect(calls[0].task).toBe("check life");
		expect(calls[0].schema).toBeUndefined(); // schema 缺省：不透传、不拼指令

		// 引擎层：writeTo 包裹落 state（§5.1:354）——compile 期按 D20 绑定自定义函数。
		const g = new StateGraph<State>()
			.addNode(
				"conclude",
				agentNode<State, "conclusion">({
					task: "check {question}",
					writeTo: "conclusion",
					executor,
				}),
			)
			.addEdge(START, "conclude")
			.addEdge("conclude", END);
		const { state } = await g.compile().run(INPUT);
		expect(state.conclusion).toBe("结论文本");
	});

	it("text mode never parses: even fenced JSON stays a raw string (D22)", async () => {
		const { executor, calls } = fakeExecutor(FENCED);

		const out = await bindAgentNode(
			agentNode<State, "conclusion">({
				task: "p",
				writeTo: "conclusion",
				executor,
			}),
			executor,
		).handler(INPUT, makeCtx());

		expect(out).toBe(FENCED);
		expect(calls[0].task).toBe("p"); // 无 schema → 不拼指令（D22）
	});

	it("schema mode: appends the instruction after interpolation, passes schema/model/tools through, parses fenced JSON", async () => {
		const { executor, calls } = fakeExecutor(FENCED);
		const ctx = makeCtx();
		const def = bindAgentNode(
			agentNode<State, "verdict">({
				task: "check {question} by {user}",
				schema: verdictSchema,
				writeTo: "verdict",
				model: "test/model",
				tools: ["read", "grep"],
				executor: "subprocess",
			}),
			executor,
		);

		const out = await def.handler(INPUT, ctx);

		expect(calls).toHaveLength(1);
		// D22：插值在前、指令在后——指令文本里的花括号不参与模板插值。
		expect(calls[0].task).toBe(`check life by alice${INSTRUCTION}`);
		expect(calls[0].schema).toBe(verdictSchema); // 原样透传（§9.3）
		expect(calls[0].model).toBe("test/model");
		expect(calls[0].tools).toEqual(["read", "grep"]);
		expect(calls[0].signal).toBe(ctx.signal);
		expect(calls[0].runId).toBe("run-1");
		expect(calls[0].instanceId).toBe("verdict#1");
		// 栅栏剥掉、解析值本身返回（writeTo 包裹是引擎的事）。
		expect(out).toEqual({ risk: "low", score: 2 });
		expect(out).not.toHaveProperty("verdict");
	});

	it("marks JSON failures retryable with the agent-prefixed message", async () => {
		const error = await rejectionOf(
			boundSchemaDef(fakeExecutor("我无法产出 JSON").executor).handler(
				INPUT,
				makeCtx(),
			),
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			"agent output is not valid JSON",
		);
		expect((error as Error).message).toContain("我无法产出 JSON");
		expect(isRetryableError(error)).toBe(true);
	});

	it("marks schema violations retryable with the compact detail", async () => {
		const error = await rejectionOf(
			boundSchemaDef(
				fakeExecutor('{"risk":42,"score":"high"}').executor,
			).handler(INPUT, makeCtx()),
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			"agent output does not match schema",
		);
		expect((error as Error).message).toContain("/risk");
		expect(isRetryableError(error)).toBe(true);
	});

	it("reports usage via ctx.reportUsage only after parse/validation succeeded (D21/I2)", async () => {
		const usage: TokenUsage = {
			input: 10,
			output: 5,
			cacheRead: 1,
			cacheWrite: 2,
			totalTokens: 15,
		};
		const reported: TokenUsage[] = [];

		// 成功尝试：以**同一对象**上报（原样透传）。
		await boundSchemaDef(fakeExecutor(FENCED, usage).executor).handler(
			INPUT,
			makeCtx({ reportUsage: (u) => reported.push(u) }),
		);
		expect(reported).toEqual([usage]);
		expect(reported[0]).toBe(usage);

		// 未返回 usage、或 ctx 没有 reportUsage（手工组装）→ 不上报、不炸。
		reported.length = 0;
		const noUsage = fakeExecutor(FENCED).executor;
		const collect = makeCtx({ reportUsage: (u) => reported.push(u) });
		await boundSchemaDef(noUsage).handler(INPUT, collect);
		await boundSchemaDef(noUsage).handler(INPUT, makeCtx());
		expect(reported).toEqual([]);

		// 解析失败的尝试即使 executor 回了 usage 也不上报（I2 澄清口径，同 llm.ts:160）。
		const failed: TokenUsage[] = [];
		await rejectionOf(
			boundSchemaDef(fakeExecutor("not json", usage).executor).handler(
				INPUT,
				makeCtx({ reportUsage: (u) => failed.push(u) }),
			),
		);
		expect(failed).toEqual([]);
	});

	it("throws a clear 'agent node is not bound' error when the definition was never bound", () => {
		const def = agentNode<State, "verdict">({
			task: "p",
			schema: verdictSchema,
			writeTo: "verdict",
			executor: "subprocess",
		});

		expect(() => def.handler(INPUT, makeCtx())).toThrowError(
			"agent node is not bound: agent nodes are bound at compile time — compile the graph before running it",
		);
	});

	it("defaults timeoutMs to 600_000 and passes retry through", async () => {
		const def = agentNode<State, "verdict">({
			task: "p",
			schema: verdictSchema,
			writeTo: "verdict",
			executor: "subprocess",
		});

		expect(def.kind).toBe("agent");
		expect(def.name).toBe("");
		expect(def.timeoutMs).toBe(600_000); // §7.3：agent 默认 600s
		expect(def.retry).toBeUndefined();

		const retried = agentNode<State, "verdict">({
			task: "p",
			schema: verdictSchema,
			writeTo: "verdict",
			retry: { maxAttempts: 3 },
			timeoutMs: 5_000,
			executor: "subprocess",
		});
		expect(retried.retry).toEqual({ maxAttempts: 3 });
		expect(retried.timeoutMs).toBe(5_000);

		// 归一后的超时同时传给 executor（适配器按同一预算自限）。
		const { executor, calls } = fakeExecutor(VALID);
		await bindAgentNode(def, executor).handler(INPUT, makeCtx());
		expect(calls[0].timeoutMs).toBe(600_000);
	});

	it("a function task receives the raw instance input (no interpolation)", async () => {
		const seen: unknown[] = [];
		const { executor, calls } = fakeExecutor(VALID);
		const def = bindAgentNode(
			agentNode<State, "verdict">({
				task: (input) => {
					seen.push(input);
					return `F:${(input as State).question}`;
				},
				schema: verdictSchema,
				writeTo: "verdict",
				executor: "subprocess",
			}),
			executor,
		);

		await def.handler(INPUT, makeCtx());

		// 同一引用：raw instance input——不克隆、不插值（函数 task 自己负责）；
		// schema 指令仍拼在函数返回值之后（D22 对两种形态一致）。
		expect(seen).toEqual([INPUT]);
		expect(seen[0]).toBe(INPUT);
		expect(calls[0].task).toBe(`F:life${INSTRUCTION}`);
	});

	it("does not mark task template failures retryable (authoring errors fail fast, no executor call)", async () => {
		const { executor, calls } = fakeExecutor(VALID);
		const def = bindAgentNode(
			agentNode<State, "verdict">({
				task: "missing {nope}",
				schema: verdictSchema,
				writeTo: "verdict",
				executor: "subprocess",
			}),
			executor,
		);

		const error = await rejectionOf(def.handler(INPUT, makeCtx()));

		expect(error).toBeInstanceOf(TemplateError);
		expect(isRetryableError(error)).toBe(false);
		expect(calls).toHaveLength(0); // 模板都求不出来 → 不调 executor
	});

	it("bindAgentNode returns a new object, keeps the original untouched, and can rebind (idempotent/overridable)", async () => {
		const first = fakeExecutor(VALID).executor;
		const second = fakeExecutor('{"risk":"high","score":9}').executor;
		const def = agentNode<State, "verdict">({
			task: "p",
			schema: verdictSchema,
			writeTo: "verdict",
			retry: { maxAttempts: 3 },
			executor: "subprocess",
		});

		const bound = bindAgentNode(def, first);
		expect(bound).not.toBe(def);
		expect(bound.writeTo).toBe("verdict");
		expect(bound.retry).toEqual({ maxAttempts: 3 });
		// executor 引用不是 NodeDefinition 字段（D20）：不落 def，走 WeakMap。
		expect(bound).not.toHaveProperty("executor");
		expect(await bound.handler(INPUT, makeCtx())).toEqual({
			risk: "low",
			score: 2,
		});

		// 原件未被改写：handler 仍是占位函数。
		expect(() => def.handler(INPUT, makeCtx())).toThrowError(
			"agent node is not bound",
		);

		// 重绑产出**新**定义（不改原件、不互相影响）：换一个 executor 覆盖。
		const rebound = bindAgentNode(def, second);
		expect(rebound).not.toBe(def);
		expect(await rebound.handler(INPUT, makeCtx())).toEqual({
			risk: "high",
			score: 9,
		});
		expect(await bound.handler(INPUT, makeCtx())).toEqual({
			risk: "low",
			score: 2,
		});
	});

	it("binds the addNode-registered shallow copy (pending config follows the shared handler)", async () => {
		const { executor, calls } = fakeExecutor(VALID);
		const def = agentNode<State, "verdict">({
			task: "copy {question}",
			schema: verdictSchema,
			writeTo: "verdict",
			executor: "subprocess",
		});
		// 模拟 StateGraph.addNode 的注册副本：`{ ...node, name }`——对象不同、
		// handler 引用共享（compile 期绑定拿到的正是注册副本）。
		const registered = { ...def, name: "check" };

		const out = await bindAgentNode(registered, executor).handler(
			INPUT,
			makeCtx(),
		);

		expect(calls[0].task).toBe(`copy life${INSTRUCTION}`);
		expect(out).toEqual({ risk: "low", score: 2 });
	});

	it("leaves a definition not produced by agentNode unchanged (no-op: its own handler stands)", () => {
		const handler = async (): Promise<Partial<State>> => ({
			verdict: { risk: "mine", score: 0 },
		});
		const foreign: NodeDefinition<State> = {
			kind: "agent",
			name: "hand-written",
			handler,
		};

		const bound = bindAgentNode(foreign, async () => ({ output: VALID }));

		// NodeDefinition 是公开类型：手工定义的 handler 就是既定行为，不替换
		//（它的 compile 命运由 graph.ts 按 D20 报 issue，不由 bind 静默改写）。
		expect(bound).toBe(foreign);
		expect(bound.handler).toBe(handler);
	});

	it("agentExecutorOf reports the declared executor (string or function); undefined for foreign defs", () => {
		const fn: AgentExecutor = async () => ({ output: VALID });
		expect(
			agentExecutorOf(
				agentNode<State, "verdict">({
					task: "p",
					writeTo: "verdict",
					executor: fn,
				}),
			),
		).toBe(fn);
		expect(
			agentExecutorOf(
				agentNode<State, "verdict">({
					task: "p",
					writeTo: "verdict",
					executor: "subprocess",
				}),
			),
		).toBe("subprocess");
		expect(
			agentExecutorOf(
				agentNode<State, "verdict">({
					task: "p",
					writeTo: "verdict",
					executor: "sdk",
				}),
			),
		).toBe("sdk");

		const foreign: NodeDefinition<State> = {
			kind: "agent",
			name: "hand-written",
			handler: async () => ({ verdict: null }),
		};
		expect(agentExecutorOf(foreign)).toBeUndefined();
	});

	it("pre-binding is not a factory concern: cfg.executor as a function still needs compile (or an explicit bind)", async () => {
		// D20 与 D12 的差异点：llm 工厂在 cfg.complete 给出时内部预绑定；agent 工厂
		// **不**预绑定——executor 的解析（含 "subprocess"/"sdk" 字符串形态）统一发生在
		// compile 期（resolveAgentExecutors）。工厂产物在绑定前调用即占位错误。
		const calls: Parameters<AgentExecutor>[0][] = [];
		const def = agentNode<State, "verdict">({
			task: "p",
			schema: verdictSchema,
			writeTo: "verdict",
			executor: async (req) => {
				calls.push(req);
				return { output: VALID };
			},
		});
		expect(() => def.handler(INPUT, makeCtx())).toThrowError(
			"agent node is not bound",
		);
		expect(calls).toHaveLength(0);
	});
});
