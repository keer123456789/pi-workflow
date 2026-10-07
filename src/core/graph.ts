/**
 * StateGraph：图构建器（设计 §4.2；compile 的校验与封印在 Task 6）。
 *
 * 职责边界（本任务）：
 * - addXxx 内只做"即时"校验——重复注册、保留名——立刻抛 `GraphValidationError`
 *   （单条 issue，`issues.length === 1`）；
 * - 跨节点校验（边/router 引用存在性、START 出边、可达性……）留给 Task 6 的 compile，
 *   本任务在 add 时一律不查；
 * - compile() 只装配 `CompiledGraphData`（warnings 初始为空）并返回 `CompiledGraph`
 *   占位实现（run/invoke 抛 "not implemented"）；封印是 Task 6 的工作。
 */

import type { TSchema } from "typebox";

import { GraphValidationError } from "./errors.js";
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
	type START,
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

	constructor(cfg?: GraphCfg<S>) {
		this.name = cfg?.name;
		this.channels = cfg?.channels ?? {};
		this.stateSchema = cfg?.stateSchema;
	}

	addNode<I = S>(name: string, node: NodeDefinition<S, I>): StateGraph<S> {
		if (name === "START" || name === "END") {
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
		if (this.routers.has(from)) {
			throw singleIssue(`node "${from}" already has a conditional edge router`);
		}
		this.routers.set(from, router);
		return this;
	}

	compile(opts?: CompileOptions): CompiledGraph<S> {
		// 装配图数据：与构建器状态解耦（拷贝），后续 addXxx 不影响已 compile 的产物。
		const plainEdges = new Map<string, string[]>();
		for (const [from, targets] of this.plainEdges) {
			plainEdges.set(from, [...targets]);
		}
		const data: CompiledGraphData<S> = {
			name: opts?.name ?? this.name ?? "graph",
			channels: this.channels,
			stateSchema: this.stateSchema,
			nodes: new Map(this.nodes),
			plainEdges,
			routers: new Map(this.routers),
			warnings: [],
		};

		// 占位实现：Task 6 在此接入校验与封印，Task 8 用 data 接引擎。
		const run = async (
			_initial: S,
			_options?: RunOptions,
		): Promise<RunResult<S>> => {
			throw new Error("not implemented");
		};

		// 具体对象额外携带装配好的 data（结构子类型，公开面仍是 CompiledGraph<S>）：
		// Task 6 封印、Task 8 引擎接线，以及本任务的测试观测点。
		const compiled: CompiledGraph<S> & { readonly data: CompiledGraphData<S> } =
			{
				name: data.name,
				run,
				invoke: run,
				data,
			};
		return compiled;
	}
}

/** add-time 校验失败：单条 issue 也走 GraphValidationError（设计 §6.4）。 */
function singleIssue(issue: string): GraphValidationError {
	return new GraphValidationError(issue, { issues: [issue] });
}
