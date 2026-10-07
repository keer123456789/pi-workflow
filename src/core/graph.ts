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
 * - run/invoke 仍是占位实现（引擎接线在 Task 8）。
 */

import type { TSchema } from "typebox";

import { GraphSealedError, GraphValidationError } from "./errors.js";
import type { StateSchema } from "./state.js";
import {
	type CompiledGraph,
	type CompiledGraphData,
	type CompileOptions,
	END,
	type GraphCfg,
	type NodeDefinition,
	type Router,
	type RunOptions,
	type RunResult,
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
		// 全量校验：一次报完，绝不 fail-fast（设计 §6）。
		const issues = this.collectIssues();
		if (issues.length > 0) {
			throw new GraphValidationError("graph invalid", { issues });
		}
		// 只有校验通过才算"编译成功"——此时才有产物需要保持不可变（§6.8）。
		// 校验失败不封印：调用方要能改完图再 compile。
		this.sealed = true;

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
			nodes: new Map(this.nodes),
			plainEdges,
			routers: new Map(this.routers),
			warnings: this.collectWarnings(),
		};

		// 占位实现：Task 8 用 data 接引擎（本任务只负责校验与封印）。
		const run = async (
			_initial: S,
			_options?: RunOptions,
		): Promise<RunResult<S>> => {
			throw new Error("not implemented");
		};

		// 具体对象额外携带装配好的 data（结构子类型，公开面仍是 CompiledGraph<S>）：
		// Task 8 用 data 接引擎，测试也靠它观测编译产物（warnings/plainEdges……）。
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

	/** compile 期错误（设计 §6.1/§6.2/§6.5）：全量收集，顺序即报错顺序。 */
	private collectIssues(): string[] {
		const issues: string[] = [];

		// §6.1：边/router 引用的节点必须已注册。
		// START/END 是哨兵不是节点：START 作边起点天然合法（起点必须是虚拟入口）；
		// router 只豁免 START——"END 的 router" 永远不可达，按未注册处理。
		for (const [from, targets] of this.plainEdges) {
			if (from !== START && from !== END && !this.nodes.has(from)) {
				issues.push(`edge source "${from}" is not a registered node`);
			}
			for (const to of targets) {
				if (to !== START && to !== END && !this.nodes.has(to)) {
					issues.push(
						`edge target "${to}" (from "${from}") is not a registered node`,
					);
				}
			}
		}
		// END 边不在 plainEdges 里（构建器契约），它们的 from 同样要查存在性——
		// 否则 addEdge("typo", END) 这类悬空引用会静默通过（§6.1 的典型拼写错误）。
		// END 作起点按 R1 裁定保持豁免（与普通边的起点豁免一致）。
		for (const from of this.endEdgeSources) {
			if (from !== START && from !== END && !this.nodes.has(from)) {
				issues.push(`edge source "${from}" is not a registered node`);
			}
		}
		for (const from of this.routers.keys()) {
			if (from !== START && !this.nodes.has(from)) {
				issues.push(`router source "${from}" is not a registered node`);
			}
		}

		// §6.2：START 必须有出边——普通边目标、显式 END 边、router 三者任一即可。
		// 注意 plainEdges 不含 END 边，所以 END 边单独查 endEdgeSources。
		const startTargets = this.plainEdges.get(START);
		if (
			(startTargets === undefined || startTargets.length === 0) &&
			!this.endEdgeSources.has(START) &&
			!this.routers.has(START)
		) {
			issues.push(
				"START has no outgoing edge: add an edge from START to the entry node, or register a router from START",
			);
		}

		// §6.5：非 fn 节点必须声明 writeTo；声明了 writeTo 就必须是已知的 State key
		//（key 宇宙只来自 stateSchema，R14；未知则整条跳过）。
		// （"schema 必须合法"一条在 M1 是真空的——NodeDefinition 还没有 schema 字段，
		// llm/agent 工厂要到 M2 才落地；typebox 对象本身即 JSON Schema，无需额外校验。）
		const universe = this.stateKeyUniverse();
		for (const [name, def] of this.nodes) {
			if (def.writeTo === undefined) {
				if (def.kind !== "fn") {
					issues.push(
						`node "${name}" (kind "${def.kind}") must declare writeTo`,
					);
				}
				continue;
			}
			if (universe !== undefined && !universe.has(def.writeTo)) {
				issues.push(
					`node "${name}" writeTo key "${def.writeTo}" is not in the state key universe`,
				);
			}
		}

		return issues;
	}

	/**
	 * 已知的 State key 宇宙（§6.5 的 writeTo 校验用，R14）：**只来自 `stateSchema`**，
	 * 取其 `properties` 的 keys（typebox 对象 schema）。
	 *
	 * channels 不能当宇宙：`StateSchema<S>` 是 Partial 映射，只列"有自定义 reducer"的 key，
	 * 而没有 reducer 的 key 合法可写（§5.1 直接覆盖写入）——拿 channels 当全集会把
	 * `writeTo: "title"` + `channels: { logs: append }` 这类合法图判错。
	 * 无 stateSchema（或它不是对象、给不出可枚举的 properties）→ undefined = 宇宙未知，
	 * 跳过校验。非对象值（如 JS 调用方传的 `null`）也走这条路，绝不让裸 TypeError 逃出 compile。
	 * 原则：宁可漏报，绝不误报。
	 */
	private stateKeyUniverse(): Set<string> | undefined {
		if (!isRecord(this.stateSchema)) {
			return undefined;
		}
		const properties = this.stateSchema.properties;
		return isRecord(properties) ? new Set(Object.keys(properties)) : undefined;
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

/** 非 null、非数组的对象（用于识别 typebox object schema 的 `properties`）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** add-time 校验失败：单条 issue 也走 GraphValidationError（设计 §6.4）。 */
function singleIssue(issue: string): GraphValidationError {
	return new GraphValidationError(issue, { issues: [issue] });
}
