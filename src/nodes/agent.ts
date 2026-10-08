/**
 * agentNode：把"一次 agent 任务"包装成节点定义（设计 §4.3；绑定机制 D20——D12 的
 * agent 镜像）。
 *
 * 工厂产出的只是**待绑定**的 agent 定义：真正的 handler 需要知道用哪个执行器
 * （`AgentExecutor`），而这一解析发生在 compile 期（D20：`cfg.executor` 为函数 →
 * 原样绑定；`"subprocess"` → services.agent.subprocess 配置存在才合法，spawn 适配器
 * 由 Task 3 在 graph.ts 接线；`"sdk"` → services.agent.sdk 配置存在才合法，SDK 适配器
 * 由 graph.ts 接线）——所以工厂把配置
 * （task / schema / tools / model / executor / 归一后的 timeoutMs）存进本模块的
 * WeakMap，`bindAgentNode(def, executor)` 用它造出真正的 handler（graph.ts 在装配
 * `CompiledGraphData.nodes` 副本时调用，`agentExecutorOf` 供解析/校验读声明）。
 * 与 llm 的差异：工厂**不**因 cfg.executor 是函数而预绑定——解析统一发生在 compile
 * 期（三种形态同一路径）；`bindAgentNode` 幂等且可覆盖——返回**新定义对象**，不改
 * 原件。
 *
 * WeakMap 的键有两种形态（同一份 cfg 登记两次）：
 * - **定义对象**（D20 口径）；
 * - **handler 函数**——addNode 注册时对定义做浅拷贝 `{ ...node, name }`（graph.ts），
 *   副本与原件**共享 handler 引用**但不再是同一个对象；compile 期绑定拿到的正是
 *   注册副本，按 def 查不到时按 handler 查，绑定信息才能跨注册存活。
 *
 * handler 每次尝试的流程（§4.3/§9.3/D22）：
 * `task 求值（函数形态直接调用；字符串走 interpolate）→ schema 存在则在插值之后拼
 * {@link schemaInstruction}（指令不参与插值，§5.6）→ executor({...}) → schema 存在：
 * 剥栅栏 → JSON.parse → Value.Check（JSON/schema 违规 markRetryable(throw)，D3 同
 * task 重发）→ usage 存在则 ctx.reportUsage（D21——仅解析/校验成功后，I2 口径）→
 * 返回**产出值本身**（schema 缺省 = executor 的 output 原文，不解析）——
 * `{ [writeTo]: 值 }` 的包裹由引擎 `updateOf` 完成（§5.1:354）。
 *
 * 注意（§5.6）：string task 含字面 JSON 花括号（如 `Return {"answer": …}`）会被当作
 * 模板插值并抛**不可重试**的 `TemplateError`——字面花括号必须转义为 `{{` / `}}`
 * （与 llmNode 的 prompt 同一姿态）。
 *
 * 未绑定的定义其 handler 是占位函数：直接调用抛 "agent node is not bound"（compile
 * 保证编译产物里的 agent 节点都已绑定——函数路径直接绑，subprocess 路径由 Task 3 在
 * graph.ts 接线；手工直接调用属误用）。
 */

import type { TSchema } from "typebox";
import { Value } from "typebox/value";

import { markRetryable } from "../core/retry.js";
import type {
	NodeContext,
	NodeDefinition,
	NodeHandler,
} from "../core/types.js";
import type { AgentExecutor } from "../runtime/executor.js";
import { interpolate } from "../template.js";
import {
	parseJsonOutput,
	schemaErrorDetail,
	schemaInstruction,
} from "./output-parse.js";

/** 单次尝试的默认超时（设计 §7.3：agent 任务默认 600s，比 llm 的 120s 宽）。 */
const DEFAULT_TIMEOUT_MS = 600_000;

/** 绑定所需的最小配置：与公开 cfg 的差异只在 `timeoutMs` 已归一。 */
type AgentCfg = {
	task: string | ((input: unknown) => string);
	schema: TSchema | undefined;
	tools: string[] | undefined;
	model: string | undefined;
	executor: "subprocess" | "sdk" | AgentExecutor;
	timeoutMs: number;
};

/** 待绑定配置（D20）：键 = 定义对象或 handler 函数（见文件头注释）。 */
const pending = new WeakMap<object, AgentCfg>();

/**
 * agent 节点工厂（签名按计划 verbatim）。
 *
 * 返回 `kind: "agent"` 的定义：`name` 留空串占位（由 `addNode` 回填，与 fnNode 一致）；
 * `timeoutMs` 缺省 600_000（§7.3）；`retry` / `model` / `tools` 原样带上——model/tools
 * 只透传给 executor（D23 的 `--model` / `--tools` 落地是适配器的事；model 不在这里做
 * defaultModel 兜底，那是 subprocess 适配器构造时按 services 配置解析的）。
 */
export function agentNode<S, K extends keyof S & string>(cfg: {
	task: string | ((input: unknown) => string);
	schema?: TSchema;
	writeTo: K;
	tools?: string[];
	model?: string;
	executor: "subprocess" | "sdk" | AgentExecutor;
	retry?: { maxAttempts: number };
	timeoutMs?: number;
}): NodeDefinition<S> {
	const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const agentCfg: AgentCfg = {
		task: cfg.task,
		schema: cfg.schema,
		tools: cfg.tools,
		model: cfg.model,
		executor: cfg.executor,
		timeoutMs,
	};
	// 占位 handler（每次调用都是新函数——WeakMap 键不跨定义串味）：绑定前被调用即误用。
	// 措辞面向节点作者（不引导去调内部函数 bindAgentNode）：绑定发生在 compile 期。
	const handler: NodeHandler<S, S> = () => {
		throw new Error(
			"agent node is not bound: agent nodes are bound at compile time — compile the graph before running it",
		);
	};
	const def: NodeDefinition<S> = {
		kind: "agent",
		name: "",
		handler,
		writeTo: cfg.writeTo,
		retry: cfg.retry,
		timeoutMs,
	};
	pending.set(def, agentCfg);
	pending.set(handler, agentCfg);
	return def;
}

/**
 * 生成真正的 handler 并返回**新定义对象**（D20；graph.ts 在复制 nodes 时绑定）。
 *
 * - 幂等 / 可覆盖：不修改传入的 def；重复绑定、换一个 executor 重绑都只产出新对象，
 *   绑定结果自己也登记进 WeakMap（可再次绑定）；
 * - `.executor` **不落**定义对象（D20：executor 引用不是 NodeDefinition 字段，公开
 *   面没有它）——实际生效的实现只能经 {@link agentExecutorOf} 读声明、由绑定参数
 *   体现；
 * - 工厂产出的定义（含 addNode 注册副本）**总能**查到待绑定配置；查不到 = 这份定义
 *   不是工厂产物（NodeDefinition 是公开类型，手工定义合法）——那它自己的 handler
 *   就是既定行为，原样返回（no-op）：既不替换也没法替换，抛错反而会拒绝合法用法。
 *   手工 agent 定义在 compile 期由 graph.ts 按 D20 报 issue（kind 即契约）；工厂定义
 *   若因异常克隆丢了配置，症状是明确的运行期 "agent node is not bound"，不静默。
 */
export function bindAgentNode<S, I = S>(
	def: NodeDefinition<S, I>,
	executor: AgentExecutor,
): NodeDefinition<S, I> {
	const cfg = pending.get(def) ?? pending.get(def.handler);
	if (cfg === undefined) {
		return def;
	}
	const handler = createHandler<S, I>(cfg, executor);
	const bound: NodeDefinition<S, I> = { ...def, handler };
	pending.set(bound, cfg);
	pending.set(handler, cfg);
	return bound;
}

/**
 * 读一份 agent 定义**声明形态**的 executor（D20）：`"subprocess"` / `"sdk"` / 自定义
 * 函数；非工厂产物 → undefined。graph.ts 的解析（resolveAgentExecutors）与校验
 * （collectIssues 的 agent 分支）都经它读声明——executor 引用不是 NodeDefinition
 * 字段，只能走 WeakMap（def 与 handler 双键，同 bindAgentNode 的查找口径）。
 */
export function agentExecutorOf<S, I>(
	def: NodeDefinition<S, I>,
): "subprocess" | "sdk" | AgentExecutor | undefined {
	return pending.get(def)?.executor ?? pending.get(def.handler)?.executor;
}

/**
 * 真正的 handler：task 求值（+schema 指令）→ executor → 解析/校验 → 上报 usage →
 * 返回产出值。
 */
function createHandler<S, I>(
	cfg: AgentCfg,
	executor: AgentExecutor,
): NodeHandler<S, I> {
	return async (input: Readonly<I>, ctx: NodeContext) => {
		const evaluated =
			typeof cfg.task === "function"
				? cfg.task(input)
				: interpolate(cfg.task, input);
		// D22：schema 指令拼在**插值之后**——指令文本里的花括号不参与模板插值（§5.6）。
		const task =
			cfg.schema === undefined
				? evaluated
				: evaluated + schemaInstruction(cfg.schema);
		const result = await executor({
			task,
			tools: cfg.tools,
			model: cfg.model,
			schema: cfg.schema,
			signal: ctx.signal,
			timeoutMs: cfg.timeoutMs,
			runId: ctx.runId,
			instanceId: ctx.instanceId,
		});
		let output: unknown;
		if (cfg.schema === undefined) {
			// schema 缺省：产出 = 最终文本原样（不解析，D22）。
			output = result.output;
		} else {
			const parsed = parseJsonOutput("agent", result.output);
			if (!Value.Check(cfg.schema, parsed)) {
				throw markRetryable(
					new Error(
						`agent output does not match schema: ${schemaErrorDetail(cfg.schema, parsed)}`,
					),
				);
			}
			output = parsed;
		}
		// D21/I2：仅解析/校验成功后才上报——失败尝试的 usage 不进 node_finished
		//（同 llm.ts 的 complete.usage 口径）。
		if (result.usage !== undefined) {
			ctx.reportUsage?.(result.usage);
		}
		// writeTo 的包裹是引擎的事（§5.1:354 / engine.ts 的 updateOf）：返回产出值本身。
		return output as Partial<S>;
	};
}
