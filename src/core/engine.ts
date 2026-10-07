/**
 * 执行引擎：超步（BSP）循环、触发/去重、条件边与 Send、状态提交
 * （设计 §5.1/§5.2/§5.3/§5.4/§5.5）。
 *
 * 结构（T11/T12 在同一骨架上扩展）：
 * (a) 超步编排 —— executeRun：pending 循环、recursionLimit、下一批激活（普通边 + router）；
 * (b) 实例执行 —— executeInstance：NodeContext 构造、输入冻结、handler 调用、事件；
 * (c) 事件发射 —— src/log/emitter.ts（内存、完成序、全局 eventSeq）；
 * (d) 状态提交 —— commitSuperstep：结果按全局实例序（instanceSeq）排序后 foldUpdates。
 *
 * 超步原子性（T10，§5.1:323-332）：
 * - 本超步全部实例跑完再决策（BSP）：任一实例失败 → **不提交**，事件边界
 *   `superstep_aborted`，主失败（实例序最小的那个）原样抛出；
 * - 提交期折叠失败（reducer-less 冲突 / reducer 抛错 / 未知 key）同样不提交、
 *   发 `superstep_aborted`，`InvalidWriteError` 原样透传（不包 NodeExecutionError）；
 * - committed 判定不做逐事件打标：消费方按最近的 `superstep_committed` /
 *   `superstep_aborted` 边界判定（见 types.ts 的 RunEvent 注释）。
 *
 * 运行期 stateSchema（T10，§6.7）：run 开始时校验初始 state；提交时校验"节点返回的
 * update key 在 schema 的 properties 内"。开发模式（`NODE_ENV !== "production"`）深冻结
 * 每个实例的输入（§5.1:352，原地冻结、不克隆）。
 *
 * onEvent 监听器异常策略（T10）：监听器是调用方代码，抛错既不改变状态机、也不吞事件；
 * 首个错误被记住，run_finished 之后以 `WorkflowError`（cause 为原错误）报告。若 run
 * 自身也失败，**主失败优先**（监听器 bug 不得掩盖 NodeExecutionError 的错误身份）。
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

import { Value } from "typebox/value";

import { createEmitter, type RunEmitter } from "../log/emitter.js";
import {
	GraphRecursionError,
	GraphValidationError,
	InvalidWriteError,
	NodeExecutionError,
	RouterError,
	WorkflowError,
} from "./errors.js";
import { Send } from "./send.js";
import {
	type ChannelUpdate,
	foldUpdates,
	type Reducer,
	type StateSchema,
	stateKeyUniverse,
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

/**
 * 实例执行产物：`update` 是**归一化后的写入表**——节点定义了 `writeTo` 时是
 * `{ [writeTo]: 返回值 }`（§5.1:354），否则就是 handler 返回的 partial。
 * 提交（commitSuperstep）与 router 的 lastUpdate 都消费它，两条路径对 writeTo
 * 的处理因此天然一致（普通实例与 Send 实例同样适用）。
 */
type InstanceResult<S extends object> = {
	instance: Instance;
	update: Partial<S>;
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
	// §6.7：初始 state 校验在 run 开始前做——不合法则整个 run 不发生（一个事件都不发），
	// 报错形态与 compile 期一致（GraphValidationError + issues）。
	assertInitialState(graph, initial);

	const runId = crypto.randomUUID();
	const emitter = createEmitter({
		runId,
		clock: services.clock,
		onEvent: options.onEvent,
	});
	const startedAt = services.clock();
	// NaN / ±Infinity 会让 `superstep > recursionLimit` 的比较全部失效（界限形同虚设）：
	// 非有限值一律回落默认 25（T8 review）。
	const requestedLimit = options.recursionLimit;
	const recursionLimit =
		requestedLimit !== undefined && Number.isFinite(requestedLimit)
			? requestedLimit
			: 25;
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
	 * run_finished 之后的监听器错误报告（T10 策略）：只在 run 本身成功时调用——
	 * run 失败时主失败优先，监听器错误不得掩盖 NodeExecutionError 的身份（见文件头）。
	 */
	const reportListenerError = (): void => {
		const { threw, error: listenerError } = emitter.listenerError();
		if (!threw) {
			return;
		}
		const error = new WorkflowError(
			`onEvent listener threw: ${messageOf(listenerError)}`,
		);
		error.cause = listenerError;
		throw error;
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
	// 未注册目标在手搓图数据下会抛内部不变量错误：run_started 已发，补上失败的
	// run_finished 让事件边界完整，再原样抛出。
	let pending: Instance[];
	try {
		pending = plainSuccessors(graph, START).map((target) =>
			createInstance(target, initial),
		);
	} catch (error) {
		finishRun(0, "failed");
		throw error;
	}

	for (;;) {
		if (pending.length === 0) {
			// 正常结束：分支全部终止（到达 END / 无后继，§5.5）。
			finishRun(lastSuperstep, "completed");
			reportListenerError();
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
			// 任一实例 handler 失败（含形状/未注册节点）→ 本超步**整体不提交**（原子性，
			// §5.1:323-325）：已完成的兄弟结果被丢弃，事件边界 superstep_aborted
			// （node_failed 已在实例内逐个发出）。主失败原样抛出——监听器错误不在这里掩盖它。
			// collateral（被连带取消的兄弟实例）与信号取消是 T11。
			emitter.emit({ type: "superstep_aborted", superstep });
			finishRun(superstep, "failed");
			throw failure;
		}

		// (d) 提交：按全局实例序升序折叠（§5.2），与完成顺序无关。
		let committed: S;
		try {
			committed = commitSuperstep(graph, state, succeeded);
		} catch (error) {
			// 提交失败（reducer-less 同超步冲突 / reducer 抛错 / 节点返回未知 key）：
			// 本超步整体不提交（原子性），InvalidWriteError **原样**传播（不包 NodeExecutionError）。
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
			// 路由失败（RouterError，§7.5）/ 内部不变量被破坏（未注册的普通边目标）：
			// 本超步已提交（superstep_committed 已发），但不再有后续超步——fail-fast 原样抛出。
			// router 不是节点，不包 NodeExecutionError。
			finishRun(superstep, "failed");
			throw error;
		}
	}
}

/**
 * (b) 单个实例：node_started →（开发模式冻结输入）→ handler(input, ctx) → node_finished；
 * 失败（handler 抛错 / 返回形状非法）走 node_failed + NodeExecutionError（fail-fast）。
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

	// §5.1:352 开发模式深冻结实例输入（普通/字符串激活 = state 快照，Send = 载荷）：
	// 修改输入属未定义行为，冻结让它尽早暴露。原地冻结（不克隆）——handler 拿到的
	// 仍是同一个对象，引用相等性不受影响。
	if (isDevMode()) {
		deepFreeze(instance.input);
	}

	const startedAt = services.clock();
	let output: unknown;
	try {
		output = await definition.handler(instance.input, ctx);
	} catch (cause) {
		throw failNode({
			emitter,
			superstep,
			node: instance.node,
			instanceId: instance.instanceId,
			cause,
		});
	}

	// 返回形状：数组 / 原始值不是合法的 Partial<S>——曾经被静默当无写入（T8 review），
	// 掩盖 bug，现在按节点失败处理（有 writeTo 的节点例外，见 shapeFailureOf）。
	const shapeError = shapeFailureOf(definition, output);
	if (shapeError !== undefined) {
		throw failNode({
			emitter,
			superstep,
			node: instance.node,
			instanceId: instance.instanceId,
			cause: shapeError,
		});
	}

	emitter.emit({
		type: "node_finished",
		superstep,
		node: instance.node,
		instanceId: instance.instanceId,
		output,
		durationMs: elapsedMs(services, startedAt),
	});

	return { instance, update: updateOf(definition, output) };
}

/**
 * 节点失败路径（§7.1）：发 `node_failed` 并返回待抛的 `NodeExecutionError`
 * （根因节点 + instanceId + cause）。collateral 与信号取消是 T11，这里恒为空。
 */
function failNode(args: {
	emitter: RunEmitter;
	superstep: number;
	node: string;
	instanceId: string;
	cause: unknown;
}): NodeExecutionError {
	const message = messageOf(args.cause);
	args.emitter.emit({
		type: "node_failed",
		superstep: args.superstep,
		node: args.node,
		instanceId: args.instanceId,
		error: message,
	});
	return new NodeExecutionError(
		`node "${args.node}" (${args.instanceId}) failed: ${message}`,
		{
			node: args.node,
			instanceId: args.instanceId,
			cause: args.cause,
			collateral: [],
		},
	);
}

/**
 * §6.7：初始 state 必须通过 `stateSchema`（typebox 对象即 JSON Schema）。
 * 失败抛 `GraphValidationError`（validation-flavored；设计 §7.5 未单列类名），
 * `issues` 为 `Value.Errors` 的可读文本（`路径: 消息`）。
 * 非对象 schema（JS 调用方传 null / 原始值）跳过——与 compile 期"宁漏勿误报"一致，
 * 也不让裸 TypeError 逃出 run 边界。
 */
function assertInitialState<S extends object>(
	graph: CompiledGraphData<S>,
	initial: S,
): void {
	const schema = graph.stateSchema;
	if (schema === undefined || typeof schema !== "object" || schema === null) {
		return;
	}
	if (Value.Check(schema, initial)) {
		return;
	}
	const issues = Value.Errors(schema, initial).map((error) =>
		error.instancePath === ""
			? error.message
			: `${error.instancePath}: ${error.message}`,
	);
	throw new GraphValidationError("initial state does not match stateSchema", {
		issues,
	});
}

/**
 * handler 返回形状（T8 review）：`undefined` / `null` = "没有写入"（合法，空写入表）；
 * 无 `writeTo` 的节点返回数组或原始值不是 `Partial<S>` → TypeError（该值曾静默变
 * no-op）。有 `writeTo` 的节点返回任意值都合法——它就是"写往 writeTo 的单值"
 * （§5.1:354），数组/原始值正是其载荷形态。
 */
function shapeFailureOf(
	definition: { writeTo?: string },
	output: unknown,
): TypeError | undefined {
	if (output === undefined || output === null) {
		return undefined;
	}
	if (definition.writeTo !== undefined) {
		return undefined;
	}
	if (typeof output === "object" && !Array.isArray(output)) {
		return undefined;
	}
	const kind = Array.isArray(output) ? "an array" : `a ${typeof output}`;
	return new TypeError(`handler must return Partial<S> object, got ${kind}`);
}

/**
 * 归一化写入表：有 `writeTo` → 整个返回值写往该 key（单值，§5.1:354）；
 * 无 `writeTo` → 返回值本身就是 Partial<S>（形状已由 shapeFailureOf 保证）。
 * `undefined` / `null` → 空写入表（两条规则都适用）。
 */
function updateOf<S extends object>(
	definition: { writeTo?: string },
	output: unknown,
): Partial<S> {
	if (output === undefined || output === null) {
		return {};
	}
	if (definition.writeTo !== undefined) {
		return { [definition.writeTo]: output } as Partial<S>;
	}
	return output as Partial<S>;
}

/**
 * (d) 提交单个超步：按全局实例序、实例内 key 升序收集 updater，再折叠进 state。
 * 提供 `stateSchema` 时逐 key 校验"key 在宇宙内"（§6.7）：未知 key 抛
 * `InvalidWriteError`（`key` = 冒犯的 key，`writers: [节点名]`）——与折叠失败同样
 * 走"不提交 + superstep_aborted"的原样透传路径，不包 NodeExecutionError。
 * 检查顺序（实例序、key 升序）确定，首个冒犯者胜出。
 */
function commitSuperstep<S extends object>(
	graph: CompiledGraphData<S>,
	state: S,
	results: readonly InstanceResult<S>[],
): S {
	const universe = stateKeyUniverse(graph.stateSchema);
	const updates: ChannelUpdate[] = [];
	for (const { instance, update } of [...results].sort(
		(a, b) => a.instance.seq - b.instance.seq,
	)) {
		const partial = update as Record<string, unknown>;
		// key 升序（稳定序，§5.1）：同一实例内多 key 的写入顺序不随 V8 属性序摇摆。
		for (const key of Object.keys(partial).sort()) {
			if (universe !== undefined && !universe.has(key)) {
				throw new InvalidWriteError(
					`node "${instance.node}" (${instance.instanceId}) returned unknown state key "${key}"`,
					{ key, writers: [instance.node] },
				);
			}
			updates.push({ key, value: partial[key], writer: instance.node });
		}
	}
	return foldUpdates(state, updates, graph.channels);
}

/**
 * 普通边后继：END 是"该分支终止"的标记，不进激活表（§5.4）。
 * 未注册目标在已 compile 的图上不可能出现（§6.1 校验过）；拿到的是手搓图数据时，
 * 这是**内部不变量被破坏**——响亮报错（带源节点与目标），绝不静默丢边（T8 review）。
 * 没有节点失败，因此不发光 `node_failed`；router 的未注册目标仍走 RouterError（§7.5）。
 */
function plainSuccessors<S extends object>(
	graph: CompiledGraphData<S>,
	from: string,
): string[] {
	const targets = graph.plainEdges.get(from) ?? [];
	const activated: string[] = [];
	for (const to of targets) {
		if (to === END) {
			continue;
		}
		if (!graph.nodes.has(to)) {
			throw new WorkflowError(
				`edge "${from}" -> "${to}": target node "${to}" is not registered on this graph (compile forbids unregistered edge targets)`,
			);
		}
		activated.push(to);
	}
	return activated;
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
 * 值），未写任何 key 时为 `{}`。writeTo 节点的写入表同样先归一化（`{ [writeTo]: 值 }`），
 * 与 commit 一致。
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
	for (const { instance, update } of results) {
		if (instance.node !== node) {
			continue;
		}
		const partial = update as Record<string, unknown>;
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

/** 开发模式（§5.1:352）：production 之外一律冻结实例输入（含测试环境）。 */
function isDevMode(): boolean {
	return process.env.NODE_ENV !== "production";
}

/**
 * 深冻结（§5.1:352）：原地冻结值本身（**不克隆**——handler 拿到的引用不变），
 * 递归冻结自有可枚举属性。WeakSet 记账已访问对象，循环引用不会栈溢出。
 * 原始值与函数不是输入数据的载体，跳过。
 */
function deepFreeze(
	value: unknown,
	seen: WeakSet<object> = new WeakSet(),
): void {
	if (typeof value !== "object" || value === null) {
		return;
	}
	if (seen.has(value)) {
		return;
	}
	seen.add(value);
	Object.freeze(value);
	for (const key of Object.keys(value)) {
		deepFreeze((value as Record<string, unknown>)[key], seen);
	}
}

/**
 * 取任意 thrown 值的消息文本（handler 允许抛非 Error 值）。
 * Error → message；其他对象先试 `JSON.stringify`（`throw {code: 429}` 不该渲染成
 * "[object Object]"）；序列化失败（循环引用 / BigInt / 抛错的 toJSON）回落
 * `String()`——渲染失败绝不能让 run 本身崩掉（T8 review）。
 */
function messageOf(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "object" && error !== null) {
		try {
			return JSON.stringify(error) ?? String(error);
		} catch {
			return String(error);
		}
	}
	return String(error);
}
