/**
 * StateGraph：图构建器（设计 §4.2）；compile 期校验与封印见设计 §6。
 *
 * 职责边界：
 * - addXxx 内只做"即时"校验——重复注册、保留名——立刻抛 `GraphValidationError`
 *   （单条 issue，`issues.length === 1`）；
 * - 跨节点校验（边/router 引用存在性、START 出边、writeTo……）集中在 compile：
 *   **全量收集，一次报完**——issues 非空则抛一条 `GraphValidationError("graph invalid")`；
 * - 警告（不可达节点 / 终态节点）不算错误（R4）：挂 `CompiledGraphData.warnings`，
 *   compile 照常返回；
 * - compile 成功即封印 builder：后续 addNode/addEdge/addConditionalEdges 抛
 *   `GraphSealedError`（§6.8）。封印是纯标志位——不 freeze 数据、节点或调用方对象（R11）；
 * - compile 期把可选 services 归一为必填 ResolvedServices（R3），run/invoke 接引擎（executeRun）；
 * - compile 期解析 llm 节点的补全实现（§6.6/D12）：`def.complete ?? services.complete ??
 *   pi-ai 默认（可用时）`——解析结果绑定进 `CompiledGraphData.nodes` 的**定义副本**
 *   （bindLlmNode，Task 6）；三级全缺、非 llm 节点声明 `complete` 都是校验错误（全量收集）；
 * - compile 期解析 agent 节点的执行器（§4.6/D20，D12 的镜像）：`cfg.executor` 为函数
 *   → 原样绑定；`"subprocess"` → `services.agent.subprocess` 配置存在才合法（空对象
 *   `{}` 合法，spawn 适配器由 Task 3 在 resolveAgentExecutors 接线）；`"sdk"` → M4 前
 *   报错；手工 agent 定义无从声明 executor → 报错（kind 即契约）。全量收集。
 */

import type { TSchema } from "typebox";

import { agentExecutorOf, bindAgentNode } from "../nodes/agent.js";
import { bindLlmNode } from "../nodes/llm.js";
import type { AgentExecutor, CompleteFn } from "../runtime/executor.js";
import { defaultPiAiComplete, isPiAiAvailable } from "../runtime/llm-pi-ai.js";
import { executeRun, resolveServices } from "./engine.js";
import { GraphSealedError, GraphValidationError } from "./errors.js";
import { type StateSchema, stateKeyUniverse } from "./state.js";
import {
	type CompiledGraph,
	type CompiledGraphData,
	type CompileOptions,
	END,
	type GraphCfg,
	type NodeDefinition,
	type Router,
	type RunHandle,
	type RunOptions,
	type Services,
	START,
} from "./types.js";

export class StateGraph<S extends object> {
	private readonly name: string | undefined;
	private readonly channels: StateSchema<S>;
	private readonly stateSchema: TSchema | undefined;
	// biome-ignore lint/suspicious/noExplicitAny: 注册表按任务 brief verbatim 存 NodeDefinition<S, any>
	private readonly nodes = new Map<string, NodeDefinition<S, any>>();
	private readonly plainEdges = new Map<string, string[]>();
	// biome-ignore lint/suspicious/noExplicitAny: 同上（Router<S, any>，I 只用于 Send 输入的类型标注）
	private readonly routers = new Map<string, Router<S, any>>();
	/**
	 * 显式连到 END 的 from 集合。
	 * plainEdges 不含 END（构建器契约）：END 边不触发节点、没有实例，
	 * 但"登记过的 END 边"这一事实要保留下来——一是重复 addEdge(from, END) 要即时拒，
	 * 二是 Task 6 判定"无出边且无 router"的警告时必须区分"显式连 END"与"真的没有出边"。
	 */
	private readonly endEdgeSources = new Set<string>();
	/** compile 成功后置位：图不可变（§6.8），任何 addXxx 抛 `GraphSealedError`。 */
	private sealed = false;

	constructor(cfg?: GraphCfg<S>) {
		this.name = cfg?.name;
		this.channels = cfg?.channels ?? {};
		this.stateSchema = cfg?.stateSchema;
	}

	addNode<I = S>(name: string, node: NodeDefinition<S, I>): StateGraph<S> {
		this.assertNotSealed("addNode");
		// 保留名：既有 "START"/"END" 字面量，也有哨兵值本身（R10）——名为 "__end__"
		// 的节点永远跑不到（连向它的边会被并进 endEdgeSources，router 也分不清它与 END）。
		if (name === "START" || name === "END" || name === START || name === END) {
			throw singleIssue(`node name "${name}" is reserved`);
		}
		if (this.nodes.has(name)) {
			throw singleIssue(`duplicate node name "${name}"`);
		}
		// name 回填：fnNode 产出 name:"" 的占位对象，注册时落名。
		// 只改写仍是占位的对象——已注册过的定义对象不再被后续 addNode 改写；
		// 注册表里始终存一份浅拷贝，图数据与调用方持有的对象互不别名。
		if (node.name === "") {
			node.name = name;
		}
		this.nodes.set(name, { ...node, name });
		return this;
	}

	addEdge(from: typeof START | string, to: typeof END | string): StateGraph<S> {
		this.assertNotSealed("addEdge");
		if (to === END) {
			if (this.endEdgeSources.has(from)) {
				throw singleIssue(`duplicate edge "${from}" -> "${to}"`);
			}
			this.endEdgeSources.add(from);
			return this;
		}
		const targets = this.plainEdges.get(from);
		if (targets === undefined) {
			this.plainEdges.set(from, [to]);
			return this;
		}
		if (targets.includes(to)) {
			throw singleIssue(`duplicate edge "${from}" -> "${to}"`);
		}
		targets.push(to);
		return this;
	}

	addConditionalEdges<I = unknown>(
		from: string,
		router: Router<S, I>,
	): StateGraph<S> {
		this.assertNotSealed("addConditionalEdges");
		if (this.routers.has(from)) {
			throw singleIssue(`node "${from}" already has a conditional edge router`);
		}
		this.routers.set(from, router);
		return this;
	}

	compile(opts?: CompileOptions): CompiledGraph<S> {
		// §6.6/D12：llm 补全解析先于校验——collectIssues 与 nodes 绑定共用同一份结果
		// （探测/取默认实现在每次 compile 里只发生一次，见 resolveLlmCompletions）。
		const completions = resolveLlmCompletions(this.nodes, opts?.services);
		// §4.6/D20：agent executor 解析与 llm 补全解析同旁——collectIssues 与 nodes
		// 绑定共用同一份结果（同步纯查表，无探测/无 spawn，D18）。
		const agentExecutors = resolveAgentExecutors(this.nodes, opts?.services);
		// 全量校验：一次报完，绝不 fail-fast（设计 §6）。
		const issues = this.collectIssues(completions, opts?.services);
		if (issues.length > 0) {
			throw new GraphValidationError("graph invalid", { issues });
		}
		// 只有校验通过才算"编译成功"——此时才有产物需要保持不可变（§6.8）。
		// 校验失败不封印：调用方要能改完图再 compile。
		this.sealed = true;

		// 节点表拷贝（D12/D20）：llm / agent 节点在**副本**上绑定真正的 handler——工厂把
		// 待绑定配置挂在定义对象与 handler 上，而 addNode 存的副本共享 handler 引用，
		// 按副本查得到（src/nodes/llm.ts、src/nodes/agent.ts 的 WeakMap 双键）。绑定产出
		// 新对象：构建器注册表与调用方持有的定义都不被改写。
		// biome-ignore lint/suspicious/noExplicitAny: 与 CompiledGraphData.nodes 同口径（注册表里 I 泛型已擦除）
		const nodes = new Map<string, NodeDefinition<S, any>>();
		for (const [name, def] of this.nodes) {
			const complete = def.kind === "llm" ? completions.get(name) : undefined;
			const executor =
				def.kind === "agent" ? agentExecutors.get(name) : undefined;
			let bound = def;
			if (complete !== undefined) {
				bound = bindLlmNode(bound, complete);
			}
			if (executor !== undefined) {
				bound = bindAgentNode(bound, executor);
			}
			nodes.set(name, bound);
		}

		// 装配图数据：与构建器状态解耦（拷贝），后续 addXxx 不影响已 compile 的产物。
		const plainEdges = new Map<string, string[]>();
		for (const [from, targets] of this.plainEdges) {
			plainEdges.set(from, [...targets]);
		}
		const data: CompiledGraphData<S> = {
			name: opts?.name ?? this.name ?? "graph",
			// R11：channels 浅拷贝——调用方之后改自己的对象不会渗进图数据；
			// stateSchema 按引用共享，但不 freeze、不修改（对象归调用方所有）。
			channels: { ...this.channels },
			stateSchema: this.stateSchema,
			nodes,
			plainEdges,
			routers: new Map(this.routers),
			warnings: this.collectWarnings(),
		};

		// 依赖解析（R3）：compile 期一次性把可选 services 归一为必填 ResolvedServices，
		// run 期（executeRun 第 4 参）不再碰缺省值。
		const resolvedServices = resolveServices(opts?.services);

		// 引擎接线（Task 8）：run 与 invoke 同一入口，options 缺省为 {}。
		// 返回 RunHandle（T11）：promise 本体 + cancel()（中止运行中的 run，§4.4/§7.4）。
		const run = (initial: S, options?: RunOptions): RunHandle<S> =>
			executeRun(data, initial, options ?? {}, resolvedServices);

		// 具体对象额外携带装配好的 data（结构子类型，公开面仍是 CompiledGraph<S>）：
		// 测试靠它观测编译产物（warnings/plainEdges……）。
		const compiled: CompiledGraph<S> & { readonly data: CompiledGraphData<S> } =
			{
				name: data.name,
				run,
				invoke: run,
				data,
			};
		return compiled;
	}

	/**
	 * 封印闸门（§6.8）：每个 addXxx 的**第一件事**——封印后调用方拿到的必须是
	 * `GraphSealedError`，而不是别的 add-time 校验错误（保留名/重复注册）。
	 */
	private assertNotSealed(method: string): void {
		if (this.sealed) {
			throw new GraphSealedError(
				`cannot call ${method} after compile(): the graph is sealed`,
			);
		}
	}

	/**
	 * compile 期错误（设计 §6.1/§6.2/§6.5/§6.6）：全量收集，顺序即报错顺序。
	 * `completions` 是 llm 节点的补全解析结果（compile 在调用前算好，见
	 * resolveLlmCompletions）——表里没有该节点的名字 = 三级解析全缺。
	 * `services` 供 agent 分支读 `services.agent.subprocess` 配置存在性（D20：
	 * `executor: "subprocess"` 的合法条件；空对象 `{}` 合法）。
	 */
	private collectIssues(
		completions: ReadonlyMap<string, CompleteFn>,
		services: Services | undefined,
	): string[] {
		const issues: string[] = [];

		// §6.1：边/router 引用的节点必须已注册。
		// START/END 是哨兵不是节点：START 作边起点天然合法（起点必须是虚拟入口）；
		// router 只豁免 START——"END 的 router" 永远不可达，按未注册处理。
		// R23：哨兵位置的死边一律报错——END 作源（没有实例）与 START 作目标
		//（不是执行节点）产生的边永远不触发任何节点，静默接受是 footgun；
		// addEdge(START, END) 依然合法（START 作源、END 作目标）。
		// Minor 6：同一 from 同时有普通边与 END 边时，两条路径会报同一条"未注册源"
		// 消息——plainEdges 循环报过的 from 记进集合，endEdgeSources 循环跳过。
		const unregisteredSources = new Set<string>();
		for (const [from, targets] of this.plainEdges) {
			if (from === END) {
				issues.push(
					'edge source "END" is the exit sentinel and cannot have outgoing edges',
				);
			} else if (from !== START && !this.nodes.has(from)) {
				issues.push(`edge source "${from}" is not a registered node`);
				unregisteredSources.add(from);
			}
			for (const to of targets) {
				if (to === START) {
					issues.push(
						`edge target "START" (from "${from}") is the entry sentinel and cannot be an edge target`,
					);
				} else if (to !== END && !this.nodes.has(to)) {
					issues.push(
						`edge target "${to}" (from "${from}") is not a registered node`,
					);
				}
			}
		}
		// END 边不在 plainEdges 里（构建器契约），它们的 from 同样要查存在性——
		// 否则 addEdge("typo", END) 这类悬空引用会静默通过（§6.1 的典型拼写错误）。
		// R23：END 作起点是永久死边 → 报错（原 R1 的豁免被 R23 取代）。
		for (const from of this.endEdgeSources) {
			if (from === END) {
				issues.push(
					'edge source "END" is the exit sentinel and cannot have outgoing edges',
				);
			} else if (
				from !== START &&
				!this.nodes.has(from) &&
				!unregisteredSources.has(from)
			) {
				issues.push(`edge source "${from}" is not a registered node`);
			}
		}
		for (const from of this.routers.keys()) {
			// R22：START 的 router 在 M1 永远不被求值（router 只对实例求值，START 没有
			// 实例）——静默死图，compile 期直接报错；END 的 router 走"未注册"分支。
			if (from === START) {
				issues.push(
					'router source "START" is not allowed: a router on START would never be evaluated (routers run only after node instances complete); use a plain edge from START to an entry node and register the router there',
				);
			} else if (!this.nodes.has(from)) {
				issues.push(`router source "${from}" is not a registered node`);
			}
		}

		// §6.2：START 必须有出边——普通边目标、显式 END 边、router 三者任一即可。
		// 注意 plainEdges 不含 END 边，所以 END 边单独查 endEdgeSources。
		// routers.has(START) 仍计入（START router 已由 R22 单报，不叠加第二条错误）。
		const startTargets = this.plainEdges.get(START);
		if (
			(startTargets === undefined || startTargets.length === 0) &&
			!this.endEdgeSources.has(START) &&
			!this.routers.has(START)
		) {
			issues.push(
				"START has no outgoing edge: add an edge from START to the entry node",
			);
		}

		// §6.5：非 fn 节点必须声明 writeTo；声明了 writeTo 就必须是已知的 State key
		//（key 宇宙只来自 stateSchema，R14；未知则整条跳过——判定见 state.ts 的
		// stateKeyUniverse，与 run 期的"未知 key"校验共用同一份实现）。
		// （"schema 必须合法"一条在 M1 是真空的——NodeDefinition 还没有 schema 字段，
		// llm/agent 工厂要到 M2 才落地；typebox 对象本身即 JSON Schema，无需额外校验。）
		const universe = stateKeyUniverse(this.stateSchema);
		for (const [name, def] of this.nodes) {
			if (def.writeTo === undefined) {
				if (def.kind !== "fn") {
					issues.push(
						`node "${name}" (kind "${def.kind}") must declare writeTo`,
					);
				}
				continue;
			}
			// R24："__proto__" 是原型污染面（foldUpdates 写入侧同样拒）——单独报，
			// 并跳过宇宙校验（避免同一 key 双报）。
			if (def.writeTo === "__proto__") {
				issues.push(`node "${name}" writeTo key "__proto__" is forbidden`);
				continue;
			}
			if (universe !== undefined && !universe.has(def.writeTo)) {
				issues.push(
					`node "${name}" writeTo key "${def.writeTo}" is not in the state key universe`,
				);
			}
		}

		// §6.6/D12：`complete` 是 llm 专用。其他 kind 声明它 = 作者错误（注入写错了位置，
		// 静默忽略会掩盖）；llm 节点的补全在 resolveLlmCompletions 里解析，解析不出
		// （节点级 / services / pi-ai 三级全缺）在这里报硬错误——把"llm node is not bound"
		// 的运行期爆炸提前到 compile（§9.4：未注入 complete 且 pi-ai 不可用 → compile 报错）。
		// §4.6/D20：agent 节点的 executor 同姿态——声明经 agentExecutorOf 读 WeakMap
		// （executor 引用不是 NodeDefinition 字段）：工厂产物总能查到；手工 agent 定义
		// 无从声明 → "has no executor implementation"（kind 即契约）；"sdk" M4 前未实现；
		// "subprocess" 需 `services.agent.subprocess` 已配置（空对象 `{}` 合法——字段全有
		// 默认）。配置在的 subprocess 节点此处放行（spawn 适配器 Task 3 才接线，见
		// resolveAgentExecutors）。
		for (const [name, def] of this.nodes) {
			if (def.kind === "llm") {
				if (!completions.has(name)) {
					issues.push(
						`node "${name}" (kind "llm") has no completion implementation: declare complete on the node, pass services.complete to compile(), or install @earendil-works/pi-ai (npm i @earendil-works/pi-ai) to use the default pi-ai completion`,
					);
				}
				continue;
			}
			if (def.kind === "agent") {
				const declared = agentExecutorOf(def);
				if (declared === undefined) {
					issues.push(
						`node "${name}" (kind "agent") has no executor implementation: pass executor: "subprocess" with services.agent.subprocess configured, or a custom AgentExecutor function to agentNode`,
					);
				} else if (declared === "sdk") {
					issues.push(
						`node "${name}" (kind "agent") declares executor "sdk" but the sdk adapter is not implemented until M4`,
					);
				} else if (
					declared === "subprocess" &&
					services?.agent?.subprocess === undefined
				) {
					issues.push(
						`node "${name}" (kind "agent") declares executor "subprocess" but services.agent.subprocess is not configured (an empty object {} is enough to accept defaults)`,
					);
				}
				// 不 continue（T2 R1）：落入下方 complete 声明检查——complete 是 llm
				// 专用（§4.3），agent 节点声明它同样报"must not declare complete"；
				// executor issue 与 complete issue 全量同批收集（§6），不互斥。
			}
			if (def.complete !== undefined) {
				issues.push(
					`node "${name}" (kind "${def.kind}") must not declare complete: it is only supported on kind "llm" nodes`,
				);
			}
		}

		return issues;
	}

	/** compile 期警告（设计 §6.2/§6.3）：永不算错误，不会导致 throw（R4）。 */
	private collectWarnings(): string[] {
		const warnings: string[] = [];

		// §6.2 可达性（R13）：router/Send 的目标静态不可知——图里有**任何** router 时，
		// 任何节点都可能被 router 触达，此检查整体放弃（宁漏勿误报）。
		if (this.routers.size === 0) {
			// 从 START 出发按非 END 目标做可达闭包（END 是终点不是跳板；
			// 构建器契约保证 plainEdges 里本就没有 END）。
			const reached = new Set<string>([START]);
			const pending: string[] = [START];
			for (let i = 0; i < pending.length; i++) {
				const from = pending[i];
				for (const to of this.plainEdges.get(from) ?? []) {
					if (to === END || reached.has(to)) {
						continue;
					}
					reached.add(to);
					pending.push(to);
				}
			}
			for (const name of this.nodes.keys()) {
				if (!reached.has(name)) {
					warnings.push(`node "${name}" is not reachable from START`);
				}
			}
		}

		// §6.3 终态提示：无出边且无 router 的节点。
		// 显式连到 END 的节点由 endEdgeSources 记录——它们不算"没有出边"。
		for (const name of this.nodes.keys()) {
			if (name === START || this.endEdgeSources.has(name)) {
				continue;
			}
			const targets = this.plainEdges.get(name);
			if (targets !== undefined && targets.length > 0) {
				continue;
			}
			if (this.routers.has(name)) {
				continue;
			}
			warnings.push(
				`node "${name}" has no outgoing edge and no router: it is a terminal state — connect it to END explicitly with addEdge("${name}", END)`,
			);
		}

		return warnings;
	}
}

/** add-time 校验失败：单条 issue 也走 GraphValidationError（设计 §6.4）。 */
function singleIssue(issue: string): GraphValidationError {
	return new GraphValidationError(issue, { issues: [issue] });
}

/**
 * llm 补全解析（§6.6/D12）：`def.complete ?? services.complete ?? pi-ai 默认（可用时）`。
 *
 * 返回"节点名 → 生效的补全实现"（**只收解析成功的 llm 节点**；解析失败的 llm 节点
 * 不在表里，collectIssues 据此报 issue）。非 llm 节点不入表。
 *
 * 探测闸门：`isPiAiAvailable()` 只在"某个 llm 节点两级都没给 complete"时才调用，
 * 且每次 compile 至多一次；默认实现也在本次解析里只取一次（defaultPiAiComplete 本身
 * 是懒建单例，这里再保证同一份结果发给所有 llm 节点）。
 */
function resolveLlmCompletions<S extends object>(
	nodes: Map<string, NodeDefinition<S, unknown>>,
	services: Services | undefined,
): Map<string, CompleteFn> {
	const resolved = new Map<string, CompleteFn>();
	let piAiDefault: CompleteFn | undefined;
	let probed = false;
	for (const [name, def] of nodes) {
		if (def.kind !== "llm") {
			continue;
		}
		let complete = def.complete ?? services?.complete;
		if (complete === undefined) {
			if (!probed) {
				probed = true;
				piAiDefault = isPiAiAvailable() ? defaultPiAiComplete() : undefined;
			}
			complete = piAiDefault;
		}
		if (complete !== undefined) {
			resolved.set(name, complete);
		}
	}
	return resolved;
}

/**
 * agent executor 解析（§4.6/D20，resolveLlmCompletions 的镜像）：返回"节点名 → 生效的
 * 执行器"。**同步纯查表**（D20：compile 不探测、不 spawn——D18 的版本探测归 Task 3
 * 的适配器，首次真正调用时才做）。按声明形态分派（经 agentExecutorOf 读 WeakMap）：
 * - 自定义函数 → 原样入表（不需要任何 services 配置，compile 期即可绑定）；
 * - `"subprocess"` → 配置在（空对象 `{}` 合法）= 合法但**本任务无可绑定函数**——
 *   spawn 适配器归 Task 3（`createPiSubprocessExecutor(services.agent.subprocess)`
 *   届时在此接线），节点 handler 暂保持未绑定占位；配置缺由 collectIssues 报；
 * - `"sdk"` → M4 才实现，collectIssues 报 issue。
 * 非工厂产物（查不到声明）不入表——collectIssues 报 "has no executor implementation"。
 */
function resolveAgentExecutors<S extends object>(
	nodes: Map<string, NodeDefinition<S, unknown>>,
	// biome-ignore lint/correctness/noUnusedFunctionParameters: 签名按计划 Task 2 Step 4 verbatim——services 是 Task 3 在此接线 createPiSubprocessExecutor(services.agent.subprocess) 的入参位；本任务同步解析（无探测/无 spawn，D18），只消费自定义函数，subprocess 配置存在性校验在 collectIssues。
	services: Services | undefined,
): Map<string, AgentExecutor> {
	const resolved = new Map<string, AgentExecutor>();
	for (const [name, def] of nodes) {
		if (def.kind !== "agent") {
			continue;
		}
		const declared = agentExecutorOf(def);
		if (typeof declared === "function") {
			resolved.set(name, declared);
		}
	}
	return resolved;
}
