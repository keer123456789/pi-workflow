/**
 * 执行引擎：超步（BSP）循环、触发/去重、条件边与 Send、状态提交、信号层级与取消
 * （设计 §5.1/§5.2/§5.3/§5.4/§5.5、§7.1–§7.4、§4.4）。
 *
 * 结构（T12 在同一骨架上扩展）：
 * (a) 超步编排 —— runGraph（executeRun 的 async 本体）：pending 循环、recursionLimit、
 *     下一批激活（普通边 + router）；
 * (b) 实例执行 —— executeInstance：NodeContext 构造、输入冻结、handler 调用、重试/超时、事件；
 * (c) 事件发射 —— src/log/emitter.ts（内存、完成序、全局 eventSeq）；
 * (d) 状态提交 —— commitSuperstep：结果按全局实例序（instanceSeq）排序后 foldUpdates。
 *
 * 信号层级（T11，§7.4）——三级单向派生，任何一级的 abort 都不会反向传播：
 * - **run signal**：`AbortController`，触发条件 = 调用方 `options.signal`、`RunHandle.cancel()`、
 *   `runTimeoutMs` 到期（§4.4）。`executeRun` 返回 `RunHandle`（promise + cancel 方法）
 *   让调用方能中止运行中的 run；
 * - **instance signal**：`AbortSignal.any([run signal, 每实例取消源])`——run 取消透传，
 *   或同超步任一兄弟实例**重试耗尽后**失败时由引擎主动 abort（fail-fast，§7.1）；
 * - **attempt signal**：`AbortSignal.any([instance signal, 本尝试超时源])`，每次尝试新建。
 *   它才是 `ctx.signal`（types.ts 的 NodeContext 注释）。本尝试超时只 abort 它，
 *   不影响下一次尝试，也不会反向 abort 实例/run。节点**必须**尊重它（§7.4:440）。
 *
 * fail-fast 取消与 collateral（T11，§7.1）：
 * - 实例重试耗尽（或形状非法 / 未注册 / 退避服务故障）→ 立刻 abort 其余**仍在运行**的
 *   兄弟实例（已 settle 的实例的信号不再被碰）；
 * - 被取消且**未完成**的实例不是"失败"：不发 `node_failed`、不重试、不进根因选举，
 *   只记进根因错误的 `NodeExecutionError.collateral`（按实例序）；
 * - 根因 = 实例序最小的真失败（T10 的确定性选举不变）；已完成的兄弟结果照旧丢弃（不提交）；
 * - run 取消/超时优先于实例失败：本超步整体不提交（`superstep_aborted`），run 以
 *   `WorkflowError("run cancelled" / "run timed out after Xms")` 拒绝——不包 NodeExecutionError。
 *
 * 重试（T11，§7.2）：`retry.maxAttempts` 是**总尝试次数**（含首次，默认 1 = 不重试）。
 * 非取消失败后按 full jitter 退避 `min(500 * 2^已重试次数 * random(), 30_000)`（注入的
 * sleep/random，时序可测），每次重试前发 `node_retry`（attempt = 刚失败的那次尝试编号）。
 * 取消类失败（实例信号已 abort 时到达的**任何**失败，与错误形状/类型无关，R20a）**不重试**。
 *
 * 超时（T11，§7.3）：只有节点显式配置 `timeoutMs` 才有单次尝试超时（fn 无默认超时；
 * llm/agent 的 120s/600s 默认值 M2 由节点工厂落进该字段）。到期 abort attempt signal，
 * 且引擎不等待不检查信号的 handler——"handler settle vs 计时器"竞速，超时分支胜出即判失败
 * （超时 = 可重试失败）；被放弃的 handler promise 已挂双回调 then，日后 reject 不会变成
 * unhandled rejection。节点若不检查信号，其工作仍在后台继续——引擎只保证自己不再等它。
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
 * onEvent 监听器异常策略（T10/R1）：监听器是调用方代码，抛错既不改变状态机、也不吞事件；
 * 首个错误被记住，run_finished 之后以 `WorkflowError`（cause 为原错误）报告。若 run
 * 自身也失败，**主失败优先**（监听器 bug 不得掩盖 NodeExecutionError 的错误身份），
 * 但监听器错误不静默：挂到主错误的 `listenerError` 字段上（emitter 对调用方不可达）。
 *
 * 触发规则（§5.4）：普通边目标与 router 字符串结果共享同一去重表（按节点名，保留最早
 * 实例）；Send 实例不去重，input 即 Send 载荷（§5.3）。router 每节点每超步求值一次，
 * 读提交后的合并 state 与该节点本超步自身写入的 fold（§4.2）。
 *
 * 预算护栏与 I/O 并发（T12，§5.1:325-327/§5.3/§4.4）：检查点在**生成下一批之后、执行
 * 之前**（循环顶部，pending 已含本超步要跑的全部实例）——
 * - `maxInstancesPerSuperstep`（默认 1000）：`pending.length > limit` → 抛
 *   `InstanceBudgetError{kind: "superstep"}`；
 * - `maxTotalInstances`（默认 10000）：累计**创建**数（createInstance 的计数器，
 *   含排队未启动的）> limit → `InstanceBudgetError{kind: "total"}`；
 * 越限的那一批一个实例都不执行（没有 node_started/node_failed），也没有超步边界
 * （什么都没跑，superstep_aborted 无意义）：事件流以 `run_finished{failed}` 收尾，
 * `superstep` = 该批**将被执行**的超步号（与 recursionLimit 的"尝试超步"同一编号规则）。
 * 两个预算的非有限值回落默认（与 recursionLimit 同一策略）。
 * `maxConcurrency`（默认 8）按"槽位 + 队列"调度：同超步同时执行的实例封顶，超出的
 * 排队等槽位、槽位一空按实例序启动；排队中的实例不是"已启动"（不发事件），其信号
 * 被 fail-fast/run 取消 abort 后永不执行——executeInstance 入口守卫直接归为
 * InstanceCancelledError（记进 collateral）。并发是 **I/O 并发**（§10 的并发模型说明）：
 * CPU 密集的 fn 节点会阻塞事件循环，这个上限对它无效。
 * 仍不含：JSONL 落盘（log/runlog.ts）。
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
	InstanceBudgetError,
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
	type RunHandle,
	type RunOptions,
	type RunResult,
	type Services,
	type SleepResult,
	START,
} from "./types.js";

/** 退避基数（§7.2）：500ms。 */
const BASE_BACKOFF_MS = 500;
/** 退避上限（§7.2）：30s。 */
const MAX_BACKOFF_MS = 30_000;

/** 单超步实例数上限的默认值（§4.4/§5.3）：1000。 */
const DEFAULT_MAX_INSTANCES_PER_SUPERSTEP = 1000;
/** 整 run 实例总数上限的默认值（§4.4/§5.3）：10000。 */
const DEFAULT_MAX_TOTAL_INSTANCES = 10_000;
/** 同超步 I/O 并发上限的默认值（§4.4/§5.1:327）：8。 */
const DEFAULT_MAX_CONCURRENCY = 8;

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

/** compile 期把可选 services 归一为必填，缺省 Date.now / 可取消的 setTimeout / Math.random（R3/R20）。 */
export function resolveServices(services?: Services): ResolvedServices {
	return {
		clock: services?.clock ?? Date.now,
		sleep: services?.sleep ?? defaultSleep,
		random: services?.random ?? Math.random,
	};
}

/**
 * 默认 sleep（R3）：真实 setTimeout，返回值额外带一个非枚举的 `cancel()`
 * 清掉未到期的定时器（R20）。
 *
 * 计时器**保持 ref'd**：退避是"进度等待"，unref 会让单节点重试的 run 在退避期间
 * 直接没有活着的句柄、进程提前退出。取消只发生在"引擎已不再等待"之后（竞速分出胜负、
 * run 结束），因此不影响等待语义。
 */
function defaultSleep(ms: number): SleepResult {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms);
	});
	Object.defineProperty(promise, "cancel", {
		value: () => {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		},
		enumerable: false,
	});
	return promise;
}

/**
 * 取消一个睡眠句柄（R20，能力探测）：默认 sleep 带 `cancel()`；注入的 sleep 没有就跳过
 * ——`(ms) => Promise<void>` 的公开契约不受影响。只对**已不再等待**的句柄调用。
 */
function cancelSleep(sleepResult: SleepResult): void {
	if (typeof sleepResult.cancel === "function") {
		sleepResult.cancel();
	}
}

/**
 * run 入口（T11 起返回 RunHandle，§4.4 的实现层细化）：{@link runGraph} 是 async 本体，
 * 这里在外面持有 run 级 AbortController，把 `cancel()` 挂到 promise 对象上。
 * promise 本体不被替换——`await` / `then` 的语义与从前完全一致。
 */
export function executeRun<S extends object>(
	graph: CompiledGraphData<S>,
	initial: S,
	options: RunOptions,
	services: ResolvedServices,
): RunHandle<S> {
	const runController = new AbortController();
	// run 级资源的归置点（见 RunScope）：run 本体 settle 后由 handle 统一触发。
	const runScope: RunScope = { finished: false, cleanups: [] };
	const promise = runGraph(
		graph,
		initial,
		options,
		services,
		runController,
		runScope,
	);
	return toRunHandle(promise, runController, () => {
		runScope.finished = true;
		for (const cleanup of runScope.cleanups) {
			cleanup();
		}
	});
}

/**
 * run 级资源的清理开关（T11/R20）：run 取消/超时都建立在"run 还没结束"这个前提上，而
 * "结束"只有 async 本体 settle 才知道——由 executeRun 在 promise settle 时统一触发，
 * 避免在每个退出路径（正常返回 / 各类 throw）上各写一遍清理。
 */
type RunScope = {
	/** run 本体已结束：之后到点的 run 级定时器与外部 signal 都不再 abort。 */
	finished: boolean;
	/**
	 * run settle 时执行的清理（按注册序）：摘除外部 signal 监听（调用方可能复用该 signal）、
	 * 清掉未到期的 run 级定时器（R20——run 结束后没有引擎持有的计时器）。
	 */
	cleanups: (() => void)[];
};

/**
 * RunHandle 装配：`Object.assign` 给 promise 附加 `cancel`（不引入 Promise 子类——
 * 子类要处理 `Object.setPrototypeOf` 之类的杂技，而调用方只用到 then/catch/cancel）。
 *
 * `cancel()`（§4.4）：abort run signal（reason 为 `WorkflowError("run cancelled")`），
 * 幂等（AbortController 本身幂等）且 run 已 settle 后是 no-op。用一个只在记账的
 * `then` 记录 settle——双回调让派生 promise 恒 resolve，不产生 unhandled rejection。
 */
function toRunHandle<S>(
	promise: Promise<RunResult<S>>,
	runController: AbortController,
	onSettled: () => void,
): RunHandle<S> {
	let settled = false;
	const markSettled = (): void => {
		settled = true;
		onSettled();
	};
	void promise.then(markSettled, markSettled);
	return Object.assign(promise, {
		cancel: (): void => {
			if (settled) {
				return;
			}
			runController.abort(new WorkflowError("run cancelled"));
		},
	});
}

async function runGraph<S extends object>(
	graph: CompiledGraphData<S>,
	initial: S,
	options: RunOptions,
	services: ResolvedServices,
	runController: AbortController,
	runScope: RunScope,
): Promise<RunResult<S>> {
	// 开跑前就已 abort 的外部 signal（§7.4）：什么都没开始——零事件（连 run_started 都没有），
	// 直接以 WorkflowError 拒绝。先于 stateSchema 校验：取消是调用方更强的意图表达。
	const externalSignal = options.signal;
	if (externalSignal?.aborted === true) {
		throw new WorkflowError("run cancelled");
	}
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

	// 预算与 I/O 并发（T12，§4.4/§5.1:325-327）：默认 1000 / 10000 / 8。非有限值一律
	// 回落默认——NaN 会让所有比较失效、Infinity 会让界限形同虚设（与 recursionLimit 同一策略）。
	const maxInstancesPerSuperstep = resolveBudgetLimit(
		options.maxInstancesPerSuperstep,
		DEFAULT_MAX_INSTANCES_PER_SUPERSTEP,
	);
	const maxTotalInstances = resolveBudgetLimit(
		options.maxTotalInstances,
		DEFAULT_MAX_TOTAL_INSTANCES,
	);
	const maxConcurrency = resolveMaxConcurrency(options.maxConcurrency);

	// run 级信号（§7.4）：三条触发路径——外部 signal、RunHandle.cancel()、runTimeoutMs。
	const runSignal = runController.signal;
	/**
	 * run 取消/超时的统一拒绝体（§4.4）：三条触发路径都以 WorkflowError 作为 abort reason，
	 * 这里原样取回（同时把调用方自己的 abort 理由留在 cause 上）。
	 */
	const cancellationError = (): WorkflowError => {
		const reason: unknown = runSignal.reason;
		return reason instanceof WorkflowError
			? reason
			: new WorkflowError("run cancelled");
	};

	// 外部 signal 直达透传；run 结束即摘除监听（调用方可能把同一个 signal 复用到下一个 run）。
	if (externalSignal !== undefined) {
		const onExternalAbort = (): void => {
			const error = new WorkflowError("run cancelled");
			error.cause = externalSignal.reason;
			runController.abort(error);
		};
		externalSignal.addEventListener("abort", onExternalAbort);
		runScope.cleanups.push(() => {
			externalSignal.removeEventListener("abort", onExternalAbort);
		});
	}

	// run 级超时（§7.3/§4.4）：到期 abort run signal。非有限 / <= 0 视为"无超时"
	// （与 recursionLimit 的 NaN 兜底同一策略）；注入的 sleep 抛错时定时器直接不参与。
	const runTimeoutMs = options.runTimeoutMs;
	if (
		runTimeoutMs !== undefined &&
		Number.isFinite(runTimeoutMs) &&
		runTimeoutMs > 0
	) {
		const deadline = services.sleep(runTimeoutMs);
		void deadline.then(
			() => {
				if (!runScope.finished) {
					runController.abort(
						new WorkflowError(`run timed out after ${runTimeoutMs}ms`),
					);
				}
			},
			() => {},
		);
		// R20：run 结束即清掉未到期的 run 级定时器（默认实现提供 cancel；注入的没有就跳过）
		runScope.cleanups.push(() => {
			cancelSleep(deadline);
		});
	}

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
	 * `listenerError` 字段与失败路径的附随字段同义（错误本体自身即报告时也带上）。
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
		error.listenerError = listenerError;
		throw error;
	};

	/**
	 * 失败路径的监听器错误附随（R1）：主失败优先——错误身份、消息、cause 全不变，
	 * 但监听器的 bug 不静默。emitter 对调用方不可达，故把首个监听器错误挂到主错误的
	 * `listenerError` 字段上（非对象抛值挂不了，只能保持静默）。
	 */
	const attachListenerError = (error: unknown): void => {
		const { threw, error: listenerError } = emitter.listenerError();
		if (!threw || typeof error !== "object" || error === null) {
			return;
		}
		(error as { listenerError?: unknown }).listenerError = listenerError;
	};

	/**
	 * run 取消/超时的收尾（T11，§7.4）：`run_finished{failed}` + 抛 WorkflowError。
	 * - `superstep` 即 run_finished.superstep——超步内取消 = 正在执行的超步编号，
	 *   超步之间取消 = 已跑完的超步编号（R1 的"已执行"语义）；
	 * - `boundary` 为真时补发 `superstep_aborted`：取消发生在超步内部，该超步整体不提交
	 *   （与实例失败/提交失败的边界语义一致，消费方按最近的边界判定 committed）；
	 * - 取消/超时**不包** NodeExecutionError（taxonomy 冻结，用 WorkflowError 基类）。
	 */
	const finishCancelledRun = (superstep: number, boundary: boolean): never => {
		if (boundary) {
			emitter.emit({ type: "superstep_aborted", superstep });
		}
		finishRun(superstep, "failed");
		const error = cancellationError();
		attachListenerError(error);
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
		attachListenerError(error);
		throw error;
	}

	for (;;) {
		if (pending.length === 0) {
			// 正常结束：分支全部终止（到达 END / 无后继，§5.5）。
			finishRun(lastSuperstep, "completed");
			reportListenerError();
			return { state, runId };
		}

		// run 取消/超时（§7.4）在超步边界生效：本超步不开始，事件里只有 run_finished{failed}
		// （没有实例被激活，也就没有 superstep_aborted 边界）。
		if (runSignal.aborted) {
			finishCancelledRun(lastSuperstep, false);
		}

		const superstep = lastSuperstep + 1;
		if (superstep > recursionLimit) {
			// 只数"执行过的超步数"：limit 内跑满才越限（§5.1 的 step >= recursionLimit）。
			finishRun(superstep, "failed");
			const error = new GraphRecursionError(
				`recursion limit of ${recursionLimit} supersteps exceeded (attempted superstep ${superstep})`,
				{ superstep, limit: recursionLimit },
			);
			attachListenerError(error);
			throw error;
		}

		// 预算护栏（T12，§5.1:325-326/§5.3）：检查点在**生成下一批之后、执行之前**
		// （pending 已含本超步要跑的全部实例）。越限的这一批一个实例都不执行——没有
		// node_started / node_failed，也没有 superstep_aborted 边界（什么都没跑，没有
		// "被中止的超步"可言）；事件流以 run_finished{failed} 收尾，superstep = 该批
		// **将被执行**的超步号（attempted superstep，与 recursionLimit 同一编号规则）。
		if (pending.length > maxInstancesPerSuperstep) {
			finishRun(superstep, "failed");
			const error = new InstanceBudgetError(
				`superstep ${superstep} (attempted) would run ${pending.length} instances, exceeding maxInstancesPerSuperstep of ${maxInstancesPerSuperstep}`,
				{ kind: "superstep", limit: maxInstancesPerSuperstep },
			);
			attachListenerError(error);
			throw error;
		}
		// 累计预算数的是**创建**而不是执行（createInstance 分配的 seq 数）：排队中的实例
		// 同样占额度——否则 maxConcurrency 会成为绕开整 run 预算的后门。
		const instancesCreated = nextInstanceSeq - 1;
		if (instancesCreated > maxTotalInstances) {
			finishRun(superstep, "failed");
			const error = new InstanceBudgetError(
				`this run has created ${instancesCreated} instances by attempted superstep ${superstep}, exceeding maxTotalInstances of ${maxTotalInstances}`,
				{ kind: "total", limit: maxTotalInstances },
			);
			attachListenerError(error);
			throw error;
		}

		// (b) 本超步实例并发执行（I/O 并发，maxConcurrency 封顶，§5.1:327）。每个实例一个
		// 取消源（fail-fast 用，§7.4）：**整批实例的取消源先全部建好**——包括还在队列里
		// 等待启动的那些。兄弟失败时排队中的实例也一起 abort，它们因此永远不会执行
		// （executeInstance 入口守卫直接归为 InstanceCancelledError → collateral）。
		// 实例 settle 即从表里摘除——"仍在运行的兄弟实例"是 abort 的具体范围（已完成的
		// 实例信号不再被碰）；下标与 pending 对齐（调度器按 pending 下标取取消源）。
		const instanceControllers: AbortController[] = [];
		const instanceAborts = new Map<string, AbortController>();
		for (const instance of pending) {
			const controller = new AbortController();
			instanceControllers.push(controller);
			instanceAborts.set(instance.instanceId, controller);
		}
		const abortSiblingInstances = (failedInstanceId: string): void => {
			const reason = new WorkflowError(
				`instance "${failedInstanceId}" failed: cancelling sibling instances (fail-fast)`,
			);
			for (const [instanceId, controller] of instanceAborts) {
				if (instanceId === failedInstanceId) {
					continue;
				}
				controller.abort(reason);
			}
		};

		// 全部 settle 后再决策：失败候选取实例序最小的那个（完成序不参与选择，确定性 §5.2）。
		// 调度：最多 maxConcurrency 个实例同时在跑，超出的按实例序排队等槽位（§4.4）。
		const settled = await settleWithConcurrencyLimit(
			pending,
			maxConcurrency,
			(instance, index) =>
				executeInstance({
					graph,
					instance,
					superstep,
					runId,
					runSignal,
					instanceController: instanceControllers[index],
					abortSiblings: () => abortSiblingInstances(instance.instanceId),
					emitter,
					services,
				}).finally(() => {
					instanceAborts.delete(instance.instanceId);
				}),
		);

		// run 取消/超时优先于实例失败（§7.4）：本超步整体不提交，边界 superstep_aborted。
		if (runSignal.aborted) {
			finishCancelledRun(superstep, true);
		}

		let failure: unknown;
		let hasFailure = false;
		let failureSeq = Number.POSITIVE_INFINITY;
		const succeeded: InstanceResult<S>[] = [];
		/** 被 fail-fast 取消、未完成的实例（按实例序）——即 NodeExecutionError.collateral。 */
		const collateral: string[] = [];
		settled.forEach((settledResult, index) => {
			const instance = pending[index];
			if (settledResult.status === "fulfilled") {
				succeeded.push(settledResult.value);
				return;
			}
			if (settledResult.reason instanceof InstanceCancelledError) {
				// 被取消（不是失败）：不发 node_failed、不参与根因选举，只记进 collateral
				collateral.push(instance.instanceId);
				return;
			}
			if (instance.seq < failureSeq) {
				failureSeq = instance.seq;
				failure = settledResult.reason;
				hasFailure = true;
			}
		});

		if (hasFailure) {
			// 任一实例真失败（含形状/未注册节点）→ 本超步**整体不提交**（原子性，
			// §5.1:323-325）：已完成的兄弟结果被丢弃，事件边界 superstep_aborted
			// （node_failed 已在实例内逐个发出）。主失败原样抛出——监听器错误不在这里掩盖它；
			// collateral（被连带取消的兄弟实例）补进根因错误（failNode 先给空表，见其注释）。
			if (failure instanceof NodeExecutionError) {
				failure.collateral = collateral;
			}
			emitter.emit({ type: "superstep_aborted", superstep });
			finishRun(superstep, "failed");
			attachListenerError(failure);
			throw failure;
		}

		if (collateral.length > 0) {
			// 防御：取消必伴随 run 取消或某个兄弟的真失败，两者都在上面处理掉了。
			// 走到这里说明内部不变量被破坏——响亮报错（事件边界照旧补全），
			// 绝不把"没跑完"当"成功"提交。
			emitter.emit({ type: "superstep_aborted", superstep });
			finishRun(superstep, "failed");
			const error = new WorkflowError(
				`superstep ${superstep} has cancelled instances (${collateral.join(", ")}) but no failure to attribute them to`,
			);
			attachListenerError(error);
			throw error;
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
			attachListenerError(error);
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
			attachListenerError(error);
			throw error;
		}
	}
}

/**
 * I/O 并发上限（T12，§4.4/§5.1:327）：最多 `limit` 个实例同时执行，其余按数组顺序
 * （实例 seq 升序）排队，槽位一空就启动下一个——启动顺序恒为实例序，与完成顺序无关。
 * 产物与 `Promise.allSettled` 同形（按下标对齐），失败候选的确定性选举（§5.2）不变。
 *
 * 排队中的实例不算"已启动"：不占槽位、不发事件；轮到它时才走 `start`（executeInstance），
 * 入口守卫在信号已 abort 时立即抛 InstanceCancelledError——handler 不会被调用。
 * 每个下标恰被一个 worker 领取一次（领取与计数之间没有 await），因此不会漏项或重复。
 */
async function settleWithConcurrencyLimit<T, R>(
	items: readonly T[],
	limit: number,
	start: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
	const results: PromiseSettledResult<R>[] = new Array(items.length);
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = nextIndex;
			if (index >= items.length) {
				return;
			}
			nextIndex += 1;
			try {
				const value = await start(items[index], index);
				results[index] = { status: "fulfilled", value };
			} catch (reason) {
				results[index] = { status: "rejected", reason };
			}
		}
	};
	const workers = Math.min(limit, items.length);
	await Promise.all(Array.from({ length: workers }, () => worker()));
	return results;
}

/**
 * (b) 单个实例：node_started →（开发模式冻结输入）→ 尝试循环（handler + 重试/超时）→
 * node_finished；永久失败（重试耗尽 / 返回形状非法 / 未注册 / 退避服务故障）走
 * node_failed + NodeExecutionError，并 fail-fast 取消仍在运行的兄弟实例。
 *
 * 信号（§7.4）：`instanceSignal = any([run signal, 本实例取消源])`——run 取消透传，
 * 兄弟失败时由 abortSiblings 触发；`attemptSignal = any([instanceSignal, 本尝试超时源])`，
 * 每次尝试新建，它就是 ctx.signal（types.ts 的 NodeContext 注释）。
 * **尝试超时只 abort 本尝试**：不影响实例/run，也不影响下一次尝试。
 *
 * 取消（R20a）**不是失败**：实例信号已 abort 时，**任何**失败都判取消——与错误形状/
 * 类型无关（AbortError、`signal.reason` 本体、被取消的节点自己抛的普通错误、乃至"信号已
 * abort 后 handler 无视信号 fulfil 出非法形状"）。抛 InstanceCancelledError：不发
 * node_failed、不重试——由调用方记进 collateral。形状非法**未**伴随取消时仍按节点失败
 * 处理（那是不重试的代码错误，与 §7.1"fn 不自动重试"同源；llm 的 schema 重试走 M2 适配层）。
 */
async function executeInstance<S extends object>(args: {
	graph: CompiledGraphData<S>;
	instance: Instance;
	superstep: number;
	runId: string;
	runSignal: AbortSignal;
	instanceController: AbortController;
	abortSiblings: () => void;
	emitter: RunEmitter;
	services: ResolvedServices;
}): Promise<InstanceResult<S>> {
	const {
		graph,
		instance,
		superstep,
		runId,
		runSignal,
		instanceController,
		abortSiblings,
		emitter,
		services,
	} = args;

	// 实例在开跑前就已被取消：maxConcurrency 调度下，排队等待的实例会在轮到它之前
	// 因兄弟失败（fail-fast）或 run 取消被 abort——它必须**永不执行**。节点从未开始 →
	// 不发任何事件（连 node_started 都没有）：记进 collateral 即完整的交代。
	if (instanceController.signal.aborted || runSignal.aborted) {
		throw new InstanceCancelledError(instance.instanceId);
	}
	const instanceSignal = AbortSignal.any([
		runSignal,
		instanceController.signal,
	]);

	const definition = graph.nodes.get(instance.node);
	if (definition === undefined) {
		// compile 校验保证激活目标都已注册（§6.1）；这里只防御手搓的图数据（不崩）。
		// R20a 守卫（与形状判定 / 尝试失败两条兄弟路径同款）：实例信号已取消时，本分支的
		// 失败也归"被取消"（进 collateral、不参与根因选举）——被 fail-fast 连带取消的实例
		// 若能在这里以更小的实例序被选成根因，就会掩盖真正触发取消的那个失败。
		if (instanceSignal.aborted) {
			throw new InstanceCancelledError(instance.instanceId);
		}
		abortSiblings();
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

	/** 实例永久失败：先 fail-fast 取消仍在运行的兄弟，再抛 NodeExecutionError（§7.1）。 */
	const fail = (cause: unknown): never => {
		abortSiblings();
		throw failNode({
			emitter,
			superstep,
			node: instance.node,
			instanceId: instance.instanceId,
			cause,
		});
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
	const maxAttempts = resolveMaxAttempts(definition.retry);
	const timeoutMs = resolveTimeoutMs(definition.timeoutMs);

	for (let attempt = 1; ; attempt += 1) {
		// 实例信号已取消（run 取消 / 兄弟失败，含退避期间被打断）：本实例不再继续。
		if (instanceSignal.aborted) {
			throw new InstanceCancelledError(instance.instanceId);
		}

		const attemptController = new AbortController();
		const attemptSignal = AbortSignal.any([
			instanceSignal,
			attemptController.signal,
		]);
		const ctx: NodeContext = {
			runId,
			superstep,
			instanceId: instance.instanceId,
			seq: instance.seq,
			signal: attemptSignal,
		};

		const outcome = await raceAttempt({
			// async 包装：同步抛错的 handler 也变成 rejection（与 handler 返回 promise 同路）
			invoke: async () => definition.handler(instance.input, ctx),
			timeoutMs,
			makeTimeoutError: () =>
				new WorkflowError(
					`node "${instance.node}" (${instance.instanceId}) attempt ${attempt} timed out after ${timeoutMs}ms`,
				),
			abortAttempt: (error) => attemptController.abort(error),
			sleep: services.sleep,
		});

		if (outcome.status === "fulfilled") {
			const output = outcome.value;
			// 返回形状：数组 / 原始值不是合法的 Partial<S>——曾经被静默当无写入（T8 review），
			// 掩盖 bug，现在按节点失败处理（有 writeTo 的节点例外，见 shapeFailureOf）。
			// 取消判定先于形状判定（R20a）：实例信号已 abort 时，无视信号、fulfil 出非法
			// 形状的 handler 也算"被取消"——否则它会以更小的实例序被选成根因，掩盖真正
			// 触发取消的那个失败。
			const shapeError = shapeFailureOf(definition, output);
			if (shapeError !== undefined) {
				if (instanceSignal.aborted) {
					throw new InstanceCancelledError(instance.instanceId);
				}
				fail(shapeError);
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

		const cause = outcome.error;
		// 取消不是失败（§7.4，R20a）：实例信号已取消时，**任何**尝试失败都算"被取消"——
		// 判定与错误形状无关（被取消的节点可能 reject AbortError / `signal.reason`，也可能
		// reject ECONNRESET、客户端 CanceledError 这类 §7.2 的真实瞬态错误）。不发
		// node_failed、不重试，交给调用方记进 collateral，也不参与根因选举（T10 的实例序
		// 选举只在"未被取消"的失败之间进行）。节点自身内部的 AbortError（嵌套请求超时）
		// 不受影响：实例信号没有取消，它仍是可重试失败（§7.2 的 timeout 类）。
		if (instanceSignal.aborted) {
			throw new InstanceCancelledError(instance.instanceId);
		}
		if (attempt >= maxAttempts) {
			// 重试耗尽 = 实例失败（根因取最后一次尝试的错误）
			fail(cause);
		}

		// 重试（§7.2）：发 node_retry（attempt = 刚失败的那次尝试编号），退避后进入下一次尝试。
		// 上一行的取消判定与这里之间没有 await：node_retry 永远对应一次**真会发生的**重试，
		// 不会出现"发了重试事件却被取消"的幻觉条目（R20a 的回归点）。
		emitter.emit({
			type: "node_retry",
			superstep,
			node: instance.node,
			instanceId: instance.instanceId,
			attempt,
			error: messageOf(cause),
		});
		try {
			// 已取消就不要再武装退避定时器（下一轮循环顶部的检查直接收尾）；
			// 退避期间被打断则由 raceWithAbort 立刻返回，不必等满窗口。
			if (!instanceSignal.aborted) {
				await raceWithAbort(
					services.sleep(backoffMs(attempt, services)),
					instanceSignal,
				);
			}
		} catch (sleepError) {
			// 注入的 sleep 故障：按本节点失败处理（不再重试——退避服务坏了重试也一样）。
			if (instanceSignal.aborted) {
				throw new InstanceCancelledError(instance.instanceId);
			}
			fail(sleepError);
		}
	}
}

/**
 * 内部信号量（不出公开 API）：实例被取消、未完成。**不是**节点失败——不发 node_failed、
 * 不重试、不参与根因选举；调用方（runGraph）据此把它记进 collateral。
 */
class InstanceCancelledError extends Error {
	constructor(instanceId: string) {
		super(`instance "${instanceId}" was cancelled`);
		this.name = "InstanceCancelledError";
	}
}

/**
 * 单次尝试的判定：handler 的 settle 与超时二者抢先（§7.3/§7.4）。
 *
 * - 超时 = 本尝试失败（可重试），并被**统一渲染**成 `makeTimeoutError()`——即使 handler
 *   在信号 abort 的那一刻抢先 reject 了 AbortError，也不让"超时"退化成裸 AbortError；
 * - 注入的 sleep 抛错时超时分支不参与竞争（handler 的结果说了算）；
 * - **引擎不因超时永远挂起**：handler 永不 settle 时靠超时分支返回。被放弃的 handler
 *   promise 已挂双回调 then——它此后 reject 也不会变成 unhandled rejection；
 * - 尝试 settle 后到点的定时器不再 abort（armed 闸门）：不惊扰已结束的尝试，更不影响
 *   下一次尝试（每次尝试的超时源都是新的）。
 */
async function raceAttempt(args: {
	invoke: () => Promise<unknown>;
	timeoutMs: number | undefined;
	makeTimeoutError: () => WorkflowError;
	abortAttempt: (error: WorkflowError) => void;
	sleep: (ms: number) => Promise<void>;
}): Promise<AttemptOutcome> {
	// handler 的两种 settle 都在这里被消费（即便结果被放弃，也不会漏出 unhandled rejection）。
	const handlerOutcome = args.invoke().then(
		(value): AttemptOutcome => ({ status: "fulfilled", value }),
		(error): AttemptOutcome => ({ status: "failed", error }),
	);
	const timeoutMs = args.timeoutMs;
	if (timeoutMs === undefined) {
		return handlerOutcome;
	}

	/** armed = 本尝试仍在等待（定时器到点时若已 settle 就作废）。 */
	const timer: { armed: boolean; error: WorkflowError | undefined } = {
		armed: true,
		error: undefined,
	};
	const deadline = args.sleep(timeoutMs);
	const timeoutOutcome = new Promise<AttemptOutcome>((resolve) => {
		void deadline.then(
			() => {
				if (!timer.armed) {
					return; // 尝试已结束：本分支不参与竞争（也不 abort 任何东西）
				}
				timer.armed = false;
				const error = args.makeTimeoutError();
				timer.error = error;
				args.abortAttempt(error);
				resolve({ status: "failed", error });
			},
			() => {}, // 注入的 sleep 抛错：超时分支不参与竞争
		);
	});
	const outcome = await Promise.race([handlerOutcome, timeoutOutcome]);
	timer.armed = false;
	// R20：竞速已分出胜负——这个不再被等待的超时定时器清掉（`cancel` 可选，能力探测）。
	cancelSleep(deadline);
	return timer.error !== undefined
		? { status: "failed", error: timer.error }
		: outcome;
}

type AttemptOutcome =
	| { status: "fulfilled"; value: unknown }
	| { status: "failed"; error: unknown };

/**
 * 等待 `sleepResult`，但信号取消时立即返回——退避 sleep 因此可被打断，取消不必等满退避窗口。
 * rejection 原样传播（调用方按"退避服务故障 = 节点失败"处理）；信号监听器在结束时摘除
 * （多次重试不会在同一个信号上累积监听器）。
 * R20：竞速结束时把退避句柄清掉（睡着完成 / 被取消打断两种情况下它都已不再被等待）；
 * 等待期间定时器保持 ref'd——退避是进度等待，进程不得在退避中途退出。
 */
async function raceWithAbort(
	sleepResult: SleepResult,
	signal: AbortSignal,
): Promise<void> {
	if (signal.aborted) {
		cancelSleep(sleepResult);
		return;
	}
	let onAbort: (() => void) | undefined;
	try {
		await Promise.race([
			sleepResult,
			new Promise<void>((resolve) => {
				onAbort = () => resolve();
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort !== undefined) {
			signal.removeEventListener("abort", onAbort);
		}
		cancelSleep(sleepResult);
	}
}

/**
 * full jitter 退避（§7.2）：`min(500 * 2^已重试次数 * random(), 30_000)`。
 * 指数用"已重试次数"（0 起）——首次重试的基数即设计的 base 500ms。
 * random 越界（注入的假实现）夹到 [0, 1]、非有限归 0：退避时长永远是合法毫秒数。
 */
function backoffMs(failedAttempt: number, services: ResolvedServices): number {
	const retriesSoFar = failedAttempt - 1;
	const jitter = services.random();
	const safeJitter = Number.isFinite(jitter)
		? Math.min(1, Math.max(0, jitter))
		: 0;
	return Math.min(
		BASE_BACKOFF_MS * 2 ** retriesSoFar * safeJitter,
		MAX_BACKOFF_MS,
	);
}

/**
 * `retry.maxAttempts` 是**总尝试次数**（含首次，设计 §7.2）：默认 1（不重试）。
 * 非有限 / < 1 一律回落 1——NaN 会让 `attempt >= maxAttempts` 永远为假（无限重试）、
 * Infinity 同理，与 recursionLimit 的兜底同一策略；小数向下取整。
 */
function resolveMaxAttempts(
	retry: { maxAttempts: number } | undefined,
): number {
	const requested = retry?.maxAttempts;
	if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
		return 1;
	}
	return Math.floor(requested);
}

/**
 * 单次尝试的超时（§7.3）：只有节点显式配置 `timeoutMs` 才生效（fn 无默认超时；
 * llm/agent 的 120s/600s 默认值由 M2 的节点工厂落进该字段，引擎只认字段）。
 * 非有限 / <= 0 视为"无超时"（与 runTimeoutMs 同一兜底）。
 */
function resolveTimeoutMs(timeoutMs: number | undefined): number | undefined {
	if (
		timeoutMs === undefined ||
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0
	) {
		return undefined;
	}
	return timeoutMs;
}

/**
 * 实例预算（T12，§4.4/§5.3）：未指定或非有限 → 默认值（NaN 与 ±Infinity 都会让
 * `pending.length > limit` / `累计 > limit` 的比较失效，护栏形同虚设——与 recursionLimit
 * 同一兜底策略）。有限值原样用：`0`/负数 = "一个实例都不许有"（任何非空批次都越限）。
 */
function resolveBudgetLimit(
	requested: number | undefined,
	fallback: number,
): number {
	if (requested === undefined || !Number.isFinite(requested)) {
		return fallback;
	}
	return requested;
}

/**
 * I/O 并发上限（T12，§4.4）：未指定或非有限 → 默认 8（同上，"不限额"不是 M1 的契约）。
 * 有限值下限 1：0 / 负数若原样用，槽位数是 0——调度器一个实例都不会启动（死锁）。
 */
function resolveMaxConcurrency(requested: number | undefined): number {
	if (requested === undefined || !Number.isFinite(requested)) {
		return DEFAULT_MAX_CONCURRENCY;
	}
	return Math.max(1, Math.floor(requested));
}

/**
 * 节点失败路径（§7.1）：发 `node_failed` 并返回待抛的 `NodeExecutionError`
 * （根因节点 + instanceId + cause）。`collateral` 先给空表——被连带取消的兄弟实例要到
 * 本超步全部 settle 才清楚，由 runGraph 在根因错误上回填（同一对象，见那里的注释）。
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
 * handler 返回形状（T8 review / R1）：`undefined` / `null` = "没有写入"（合法，空写入表）；
 * 无 `writeTo` 的节点必须返回**普通对象**（`Partial<S>`）——数组、原始值、Map/Date/
 * 类实例等"非普通对象"都曾静默变 no-op（`Object.keys` 拿不到任何写入），掩盖 bug，
 * 现在一律按节点失败处理。有 `writeTo` 的节点返回值任意形状皆合法——它就是"写往
 * writeTo 的单值"（§5.1:354），数组/原始值正是其载荷形态。
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
	if (
		typeof output === "object" &&
		!Array.isArray(output) &&
		isPlainUpdateRecord(output)
	) {
		return undefined;
	}
	return new TypeError(
		`handler must return Partial<S> object, got ${describeOutput(output)}`,
	);
}

/**
 * `Partial<S>` 更新表必须是普通对象（原型为 `Object.prototype` 或 `null`）：
 * Map/Set/Date/RegExp/类实例都是 `typeof "object"` 但不是更新表（R1，与数组同一类
 * silent no-op）。跨 realm 对象的原型不同，同样按非普通对象处理（M1 不区分）。
 */
function isPlainUpdateRecord(value: object): boolean {
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		// 连取原型都抛错（如 revoked Proxy）：按非法处理，别让裸错误逃出校验路径。
		return false;
	}
}

/** 非法返回值的可读描述（TypeError 消息用）：数组 / 原始值 / 构造器名。 */
function describeOutput(value: unknown): string {
	if (Array.isArray(value)) {
		return "an array";
	}
	if (typeof value !== "object" || value === null) {
		return `a ${typeof value}`;
	}
	try {
		const name: unknown = (value as { constructor?: { name?: unknown } })
			.constructor?.name;
		return typeof name === "string" && name !== ""
			? `a ${name}`
			: "a non-plain object";
	} catch {
		return "a non-plain object";
	}
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
