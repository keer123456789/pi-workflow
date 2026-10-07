/**
 * 执行引擎：超步（BSP）循环、普通边去重、状态提交（设计 §5.1/§5.2/§5.4/§5.5）。
 *
 * 结构（T9–T12 在同一骨架上扩展）：
 * (a) 超步编排 —— executeRun：pending 循环、recursionLimit、下一批激活（去重表）；
 * (b) 实例执行 —— executeInstance：NodeContext 构造、handler 调用、node_started/finished/failed；
 * (c) 事件发射 —— src/log/emitter.ts（内存、完成序、全局 eventSeq）；
 * (d) 状态提交 —— commitSuperstep：结果按全局实例序（instanceSeq）排序后 foldUpdates。
 *
 * 本任务只有"普通边全部激活"：不含 router/Send（T9）、
 * 预算/并发上限/取消信号层级（T11）、重试与超时（T12）。
 *
 * 两个计数器互不相干（R2），都在 run 内全局单调：
 * - `instanceSeq`：NodeDefinition 的激活序 —— instanceId = `${name}#${seq}`，也是合并顺序（§5.2）；
 * - `eventSeq`：RunEvent 的发出序（在 emitter 里分配，引擎不碰）。
 */

import { createEmitter, type RunEmitter } from "../log/emitter.js";
import { GraphRecursionError, NodeExecutionError } from "./errors.js";
import { type ChannelUpdate, foldUpdates, type StateSchema } from "./state.js";
import {
	type CompiledGraphData,
	END,
	type NodeContext,
	type ResolvedServices,
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

	/**
	 * 普通触发（§5.4）：sources 按 seq 升序给出；同一超步内同名的目标只保留
	 * 最早 seq 的一个实例（去重表 = Map 的 key）。snapshot 为激活时刻的 state，
	 * 它同时是下一批全部实例的输入快照（BSP）。
	 */
	const activate = (sources: readonly string[], snapshot: S): Instance[] => {
		const activated = new Map<string, Instance>();
		for (const from of sources) {
			for (const target of plainSuccessors(graph, from)) {
				if (activated.has(target)) {
					continue;
				}
				const seq = nextInstanceSeq;
				nextInstanceSeq += 1;
				activated.set(target, {
					node: target,
					seq,
					instanceId: `${target}#${seq}`,
					input: snapshot,
				});
			}
		}
		return [...activated.values()];
	};

	// 超步 1：START 的普通边目标（R7）。
	let pending = activate([START], initial);

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

		// 生成下一批：结果按 seq 升序扫描（§5.1），输入 = 合并后 state 的快照。
		const bySeq = [...succeeded].sort(
			(a, b) => a.instance.seq - b.instance.seq,
		);
		pending = activate(
			bySeq.map((result) => result.instance.node),
			state,
		);
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

/** 时长取非负：注入时钟可以回拨，durationMs 契约上不允许为负。 */
function elapsedMs(services: ResolvedServices, since: number): number {
	return Math.max(0, services.clock() - since);
}

/** 取任意 thrown 值的消息文本（handler 允许抛非 Error 值）。 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
