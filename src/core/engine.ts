/**
 * 执行引擎：超步（BSP）循环、触发/去重、条件边与 Send、状态提交
 * （设计 §5.1/§5.2/§5.3/§5.4/§5.5）。
 *
 * 结构（T10–T12 在同一骨架上扩展）：
 * (a) 超步编排 —— executeRun：pending 循环、recursionLimit、下一批激活（普通边 + router）；
 * (b) 实例执行 —— executeInstance：NodeContext 构造、handler 调用、node_started/finished/failed；
 * (c) 事件发射 —— src/log/emitter.ts（内存、完成序、全局 eventSeq）；
 * (d) 状态提交 —— commitSuperstep：结果按全局实例序（instanceSeq）排序后 foldUpdates。
 *
 * 触发规则（§5.4）：普通边目标与 router 字符串结果共享同一去重表（按节点名，保留最早
 * 实例）；Send 实例不去重，input 即 Send 载荷（§5.3）。router 每节点每超步求值一次，
 * 读提交后的合并 state 与该节点本超步自身写入的 fold（§4.2）。
 * 仍不含：预算/并发上限/取消信号层级（T11）、重试与超时（T12）。
 *
 * 两个计数器互不相干（R2），都在 run 内全局单调：
 * - `instanceSeq`：NodeDefinition 的激活序 —— instanceId = `${name}#${seq}`，也是合并顺序（§5.2）；
 * - `eventSeq`：RunEvent 的发出序（在 emitter 里分配，引擎不碰）。
 */

import { createEmitter, type RunEmitter } from "../log/emitter.js";
import {
	GraphRecursionError,
	NodeExecutionError,
	RouterError,
} from "./errors.js";
import { Send } from "./send.js";
import {
	type ChannelUpdate,
	foldUpdates,
	type Reducer,
	type StateSchema,
} from "./state.js";
import {
	type CompiledGraphData,
	END,
	type NodeContext,
	type ResolvedServices,
	type Router,
	type RouterResult,
	type RunOptions,
	type RunResult,
	type Services,
	START,
} from "./types.js";

/** 待执行实例；input 是激活时刻 state 的只读快照（普通触发，设计 §5.1）。 */
type Instance = {
	node: string;
	seq: number;
	instanceId: string;
	// biome-ignore lint/suspicious/noExplicitAny: 注册表里 I 泛型已擦除（NodeDefinition<S, any>），实例输入同样按 any 承接
	input: any;
};

/** 实例执行产物：output 为 handler 返回的原始 partial（尚未提交）。 */
type InstanceResult<S extends object> = {
	instance: Instance;
	output: Partial<S>;
};

/** compile 期把可选 services 归一为必填，缺省 Date.now / setTimeout / Math.random（R3）。 */
export function resolveServices(services?: Services): ResolvedServices {
	return {
		clock: services?.clock ?? Date.now,
		sleep:
			services?.sleep ??
			((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
		random: services?.random ?? Math.random,
	};
}

export async function executeRun<S extends object>(
	graph: CompiledGraphData<S>,
	initial: S,
	options: RunOptions,
	services: ResolvedServices,
): Promise<RunResult<S>> {
	const runId = crypto.randomUUID();
	const emitter = createEmitter({
		runId,
		clock: services.clock,
		onEvent: options.onEvent,
	});
	const startedAt = services.clock();
	const recursionLimit = options.recursionLimit ?? 25;
	// T11 在这里接 run 级信号（options.signal / runTimeoutMs / 兄弟实例失败取消）：
	// 本任务给节点的信号永不触发（节点仍应按 §7.4 的约定尊重 ctx.signal）。
	const runSignal = new AbortController().signal;

	let state: S = initial;
	/** 已跑完的超步数（0 = 一个都没跑）；run_started 用 superstep 0。 */
	let lastSuperstep = 0;
	/** 全局实例序（R2）：首个实例为 1。 */
	let nextInstanceSeq = 1;

	emitter.emit({
		type: "run_started",
		superstep: 0,
		graph: graph.name,
		input: initial,
	});

	const finishRun = (
		superstep: number,
		status: "completed" | "failed",
	): void => {
		emitter.emit({
			type: "run_finished",
			superstep,
			status,
			durationMs: elapsedMs(services, startedAt),
		});
	};

	/** 构造实例：分配全局实例序（R2），instanceId = `${name}#${seq}`。 */
	const createInstance = (node: string, input: unknown): Instance => {
		const seq = nextInstanceSeq;
		nextInstanceSeq += 1;
		return { node, seq, instanceId: `${node}#${seq}`, input };
	};

	/**
	 * 生成下一批（设计 §5.1 末段、§5.4）：
	 * 1) 先普通边：按实例 seq 升序扫描本超步完成的实例，目标经 `activated`
	 *    去重（同一节点名只保留最早 seq 的一个实例）；
	 * 2) 后 router：按"该节点最早实例的 seq"升序、每节点至多求值一次；
	 *    字符串结果并入**同一** `activated` 去重表（与普通边同规则）；
	 *    Send 不进去重表——逐个追加，实例输入即 Send 载荷（§5.3）。
	 * 普通触发实例的输入 = 合并后 state 的只读快照（BSP，同批共享）。
	 * 结果按 seq 升序（普通实例在前、Send 实例在后，§5.1）。
	 */
	const composeNextBatch = (
		results: readonly InstanceResult<S>[],
	): Instance[] => {
		const bySeq = [...results].sort((a, b) => a.instance.seq - b.instance.seq);
		const activated = new Map<string, Instance>();
		const sends: Instance[] = [];
		const activatePlain = (target: string): void => {
			if (activated.has(target)) {
				return;
			}
			activated.set(target, createInstance(target, state));
		};

		for (const { instance } of bySeq) {
			for (const target of plainSuccessors(graph, instance.node)) {
				activatePlain(target);
			}
		}

		// bySeq 已按实例 seq 升序：节点首次出现 = 它的最早实例（求值序确定性，§5.2）。
		const routed = new Set<string>();
		for (const { instance } of bySeq) {
			if (routed.has(instance.node)) {
				continue;
			}
			const router = graph.routers.get(instance.node);
			if (router === undefined) {
				continue;
			}
			routed.add(instance.node);
			const lastUpdate = lastUpdateOf(instance.node, bySeq, graph.channels);
			for (const item of normalizeRoute(
				callRouter(router, instance.node, state, lastUpdate),
				instance.node,
			)) {
				if (typeof item === "string") {
					assertRoutableString(graph, instance.node, item);
					activatePlain(item);
					continue;
				}
				assertSendTarget(graph, instance.node, item);
				sends.push(createInstance(item.node, item.input));
			}
		}

		return [...activated.values(), ...sends].sort((a, b) => a.seq - b.seq);
	};

	// 超步 1：START 的普通边目标（R7）。router 只在实例完成后求值，
	// 因此挂在 START 上的 router 不会被求值（§5.1 的求值循环遍历的是实例）。
	let pending = plainSuccessors(graph, START).map((target) =>
		createInstance(target, initial),
	);

	for (;;) {
		if (pending.length === 0) {
			// 正常结束：分支全部终止（到达 END / 无后继，§5.5）。
			finishRun(lastSuperstep, "completed");
			return { state, runId };
		}

		const superstep = lastSuperstep + 1;
		if (superstep > recursionLimit) {
			// 只数"执行过的超步数"：limit 内跑满才越限（§5.1 的 step >= recursionLimit）。
			finishRun(superstep, "failed");
			throw new GraphRecursionError(
				`recursion limit of ${recursionLimit} supersteps exceeded (attempted superstep ${superstep})`,
				{ superstep, limit: recursionLimit },
			);
		}

		// (b) 本超步实例并发执行（I/O 并发）。全部 settle 后再决策：
		// 失败候选取实例序最小的那个（完成序不参与选择，确定性 §5.2）；
		// 失败不取消兄弟实例——取消信号层级是 T11，未提交的写入在这里不会落地。
		const settled = await Promise.allSettled(
			pending.map((instance) =>
				executeInstance({
					graph,
					instance,
					superstep,
					runId,
					signal: runSignal,
					emitter,
					services,
				}),
			),
		);
		let failure: unknown;
		let hasFailure = false;
		let failureSeq = Number.POSITIVE_INFINITY;
		const succeeded: InstanceResult<S>[] = [];
		settled.forEach((settledResult, index) => {
			if (settledResult.status === "fulfilled") {
				succeeded.push(settledResult.value);
				return;
			}
			const seq = pending[index].seq;
			if (seq < failureSeq) {
				failureSeq = seq;
				failure = settledResult.reason;
				hasFailure = true;
			}
		});

		if (hasFailure) {
			finishRun(superstep, "failed");
			throw failure;
		}

		// (d) 提交：按全局实例序升序折叠（§5.2），与完成顺序无关。
		let committed: S;
		try {
			committed = commitSuperstep(state, succeeded, graph.channels);
		} catch (error) {
			// 提交失败（如 reducerless key 同超步冲突）：本超步整体不提交（原子性），run 失败。
			// superstep_aborted 的发射路径在这里先落地（T10 再补 committed 标记等细节）。
			emitter.emit({ type: "superstep_aborted", superstep });
			finishRun(superstep, "failed");
			throw error;
		}
		state = committed;
		emitter.emit({ type: "superstep_committed", superstep });
		lastSuperstep = superstep;

		// 生成下一批：普通边 → router（§5.1 末段），输入 = 合并后 state 的快照。
		try {
			pending = composeNextBatch(succeeded);
		} catch (error) {
			// 路由失败（RouterError，§7.5）：本超步已提交（superstep_committed 已发），
			// 但不再有后续超步——fail-fast 原样抛出。router 不是节点，不包 NodeExecutionError。
			finishRun(superstep, "failed");
			throw error;
		}
	}
}

/**
 * (b) 单个实例：node_started → handler(input, ctx) → node_finished；
 * handler 抛错则 node_failed + NodeExecutionError（fail-fast）。
 * 本任务不重试（T12）、不因兄弟失败取消（T11），collateral 恒为空。
 */
async function executeInstance<S extends object>(args: {
	graph: CompiledGraphData<S>;
	instance: Instance;
	superstep: number;
	runId: string;
	signal: AbortSignal;
	emitter: RunEmitter;
	services: ResolvedServices;
}): Promise<InstanceResult<S>> {
	const { graph, instance, superstep, runId, signal, emitter, services } = args;

	const definition = graph.nodes.get(instance.node);
	if (definition === undefined) {
		// compile 校验保证激活目标都已注册（§6.1）；这里只防御手搓的图数据（不崩）。
		throw new NodeExecutionError(
			`node "${instance.node}" (${instance.instanceId}) is not registered`,
			{
				node: instance.node,
				instanceId: instance.instanceId,
				cause: undefined,
				collateral: [],
			},
		);
	}

	const ctx: NodeContext = {
		runId,
		superstep,
		instanceId: instance.instanceId,
		seq: instance.seq,
		signal,
	};

	emitter.emit({
		type: "node_started",
		superstep,
		node: instance.node,
		instanceId: instance.instanceId,
		kind: definition.kind,
	});

	const startedAt = services.clock();
	let output: Partial<S>;
	try {
		output = await definition.handler(instance.input, ctx);
	} catch (cause) {
		const message = messageOf(cause);
		emitter.emit({
			type: "node_failed",
			superstep,
			node: instance.node,
			instanceId: instance.instanceId,
			error: message,
		});
		throw new NodeExecutionError(
			`node "${instance.node}" (${instance.instanceId}) failed: ${message}`,
			{
				node: instance.node,
				instanceId: instance.instanceId,
				cause,
				collateral: [],
			},
		);
	}

	emitter.emit({
		type: "node_finished",
		superstep,
		node: instance.node,
		instanceId: instance.instanceId,
		output,
		durationMs: elapsedMs(services, startedAt),
	});

	return { instance, output };
}

/** (d) 提交单个超步：按全局实例序、实例内 key 升序收集 updater，再折叠进 state。 */
function commitSuperstep<S extends object>(
	state: S,
	results: readonly InstanceResult<S>[],
	channels: StateSchema<S>,
): S {
	const updates: ChannelUpdate[] = [];
	for (const { instance, output } of [...results].sort(
		(a, b) => a.instance.seq - b.instance.seq,
	)) {
		const partial = asUpdateRecord(output);
		// key 升序（稳定序，§5.1）：同一实例内多 key 的写入顺序不随 V8 属性序摇摆。
		for (const key of Object.keys(partial).sort()) {
			updates.push({ key, value: partial[key], writer: instance.node });
		}
	}
	return foldUpdates(state, updates, channels);
}

/**
 * handler 返回值归一化为写入表：null/undefined（JS 调用方的"没有返回"）、
 * 数组与非对象一律视为"没有写入"，不让提交路径抛原生 TypeError。
 */
function asUpdateRecord(output: unknown): Record<string, unknown> {
	if (typeof output !== "object" || output === null || Array.isArray(output)) {
		return {};
	}
	return output as Record<string, unknown>;
}

/**
 * 普通边后继：END 与未注册目标不进激活表（§5.4）。
 * 已 compile 的图不会有未注册目标（§6.1）；这里防御手搓图数据，按"无后继"处理。
 */
function plainSuccessors<S extends object>(
	graph: CompiledGraphData<S>,
	from: string,
): string[] {
	const targets = graph.plainEdges.get(from) ?? [];
	return targets.filter((to) => to !== END && graph.nodes.has(to));
}

/** 归一化后的路由单项：字符串目标或 Send（END 已在归一化时丢弃）。 */
type RouteItem = string | Send;

/**
 * 路由结果归一化（§5.4）：`null`/`undefined` → []（等价 END）；字符串 → [r]，
 * 其中 END → []（不激活）；`Send` → [r]；数组逐项同法展开——数组里的 END 项
 * 只终止该项，其余项照常处理。
 * 类型系统之外的值（JS 调用方）：抛 `RouterError`（§7.5），不静默忽略。
 */
function normalizeRoute(result: RouterResult, nodeId: string): RouteItem[] {
	if (result === null || result === undefined) {
		return [];
	}
	if (typeof result === "string") {
		return result === END ? [] : [result];
	}
	if (result instanceof Send) {
		return [result];
	}
	if (Array.isArray(result)) {
		return result.flatMap((item) => normalizeRoute(item, nodeId));
	}
	throw new RouterError(
		`router of node "${nodeId}" returned an invalid result item`,
		{ nodeId, result },
	);
}

/**
 * router 求值（§4.2）：`state` 为提交后的合并 state，`lastUpdate` 为该节点本超步
 * 自身写入的 fold（见 lastUpdateOf）。router 自身抛错 → `RouterError`（§7.5），
 * 原始错误放进标准 cause 槽位（与 foldUpdates 对 reducer 错误的处理同法）。
 */
function callRouter<S extends object>(
	router: Router<S, unknown>,
	nodeId: string,
	state: S,
	lastUpdate: Partial<S>,
): RouterResult {
	try {
		return router(state, lastUpdate);
	} catch (cause) {
		const error = new RouterError(
			`router of node "${nodeId}" threw: ${messageOf(cause)}`,
			{ nodeId, result: undefined },
		);
		error.cause = cause;
		throw error;
	}
}

/**
 * 字符串路由目标的合法性（§7.5）：START 哨兵与未注册节点都抛 `RouterError`，
 * `nodeId` 为 router 的所属节点，`result` 为违规的原始项。
 */
function assertRoutableString<S extends object>(
	graph: CompiledGraphData<S>,
	nodeId: string,
	target: string,
): void {
	if (target === START) {
		throw new RouterError(
			`router of node "${nodeId}" returned the START sentinel`,
			{ nodeId, result: target },
		);
	}
	if (!graph.nodes.has(target)) {
		throw new RouterError(
			`router of node "${nodeId}" returned unregistered node "${target}"`,
			{ nodeId, result: target },
		);
	}
}

/** Send 目标的合法性（§5.3/§7.5）：END 或未注册节点都抛 `RouterError`（`result` = 该 Send）。 */
function assertSendTarget<S extends object>(
	graph: CompiledGraphData<S>,
	nodeId: string,
	send: Send,
): void {
	if (send.node === END) {
		throw new RouterError(
			`router of node "${nodeId}" returned a Send targeting END`,
			{ nodeId, result: send },
		);
	}
	if (!graph.nodes.has(send.node)) {
		throw new RouterError(
			`router of node "${nodeId}" returned a Send targeting unregistered node "${send.node}"`,
			{ nodeId, result: send },
		);
	}
}

/**
 * router 的第二参数（§4.2/§5.5）：该节点本超步全部实例写入、按实例序与实例内
 * key 升序折叠的结果——**只含该节点自身的写入**（不含其他节点，也不含历史累积
 * 值），未写任何 key 时为 `{}`。
 *
 * 折叠起点为空：每个 key 的首个写入直接成为该值，后续写入经该 key 的 reducer
 * 折叠（与 commit 同一套 reducer）。起点若取累积 state，append 类 channel 会得到
 * "旧值 + 新值"，正是 §5.5 要避免的重复扇出（lastUpdate 的存在意义）。
 */
function lastUpdateOf<S extends object>(
	node: string,
	results: readonly InstanceResult<S>[],
	channels: StateSchema<S>,
): Partial<S> {
	const updates: ChannelUpdate[] = [];
	// results 已按实例 seq 升序（调用方保证）；实例内 key 升序 = commit 的稳定序（§5.1）。
	for (const { instance, output } of results) {
		if (instance.node !== node) {
			continue;
		}
		const partial = asUpdateRecord(output);
		for (const key of Object.keys(partial).sort()) {
			updates.push({ key, value: partial[key], writer: node });
		}
	}
	return foldOwnWrites(updates, channels);
}

/**
 * 按 key 折叠单个节点的写入（updates 已按实例序、key 升序排好）。
 * 与 `foldUpdates` 同规则地应用 reducer（无 reducer 的 key 直写），区别只在起点：
 * 首写直接落值，不拿"外部基值"去 reduce。同 key 2+ 次无 reducer 写入在 commit
 * 阶段已抛 `InvalidWriteError`，到不了这里。
 */
function foldOwnWrites<S extends object>(
	updates: readonly ChannelUpdate[],
	channels: StateSchema<S>,
): Partial<S> {
	const folded: Record<string, unknown> = {};
	const reducers = channels as Partial<Record<string, Reducer<unknown>>>;
	for (const { key, value } of updates) {
		// hasOwn 而非原型链查找（与 foldUpdates 一致）：key 叫 "constructor" 时不吃原型成员。
		const reducer = Object.hasOwn(reducers, key) ? reducers[key] : undefined;
		if (reducer === undefined || !Object.hasOwn(folded, key)) {
			folded[key] = value;
			continue;
		}
		folded[key] = reducer(folded[key], value);
	}
	return folded as Partial<S>;
}

/** 时长取非负：注入时钟可以回拨，durationMs 契约上不允许为负。 */
function elapsedMs(services: ResolvedServices, since: number): number {
	return Math.max(0, services.clock() - since);
}

/** 取任意 thrown 值的消息文本（handler 允许抛非 Error 值）。 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
