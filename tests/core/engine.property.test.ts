/**
 * Task 13：属性测试（设计 §12："随机图 + reducer 组合，验证确定性"；§13 M1 验收）。
 *
 * 生成器（种子化 PRNG，mulberry32，固定常数派生每个迭代的种子 → 完全可复现）：
 * - 3–8 个节点；随机普通边（含回边/自环 → 循环）与随机条件边（router 返回
 *   string / string[] / Send / Send[] / null / END / 抛错）；
 * - 每个 state key 随机挑 reducer：overwrite / append / concat / setOnce，或
 *   不声明（reducer-less：同超步多写 → InvalidWriteError）；
 * - handler 的写入 key 与值类型各自随机（多数相容、少数故意错配），另有
 *   输入派生值（inc / join）与 0–2 个微任务跳（扰动完成序，无真实计时器）；
 * - **两个分层**（每 3 个迭代换一次，见 FORWARD_EVERY）：`mixed` 全随机（覆盖
 *   "图会合法地失败"），`forward` 的目标只在更靠后的节点里挑（激活链索引严格递增
 *   → 必然终止）——后者专门供给"完成 + 两次 run 全轨迹逐位一致"的高价值样本。
 *
 * 断言（每个种子跑两次，两次都是从同一 spec 独立装配 + 独立 compile）：
 * 1. **没有非预期错误类型**：任何失败都必须是 `WorkflowError` 家族（RouterError /
 *    InstanceBudgetError / GraphRecursionError / InvalidWriteError / NodeExecutionError
 *    都是合法结局），非 WorkflowError 的平台错误 = 失败；
 * 2. 两次 run 的**结局一致**（同为完成、同为失败、同为跳过——混杂本身就是不确定性；
 *    一次跳过另一次照跑同样不许）；
 * 3. 完成的图：两次 run 的最终 state 与整条轨迹（handler 调用、router 求值、
 *    reducer 折叠，均带 `structuredClone` 后的输入/输出）deep-equal 逐位一致；
 *    失败的图：两次失败的**错误类名 + 消息逐字一致**；
 * 4. 构造期非法的图（GraphValidationError / GraphSealedError）跳过。
 *
 * 轨迹采集在测试内（闭包 recorder），不是引擎设施：handler 记录 `{seq, superstep,
 * node, input, output}`，router 记录 `{node, state, lastUpdate, result}`，reducer 由
 * 包装层记录 `{key, current, update, outcome}`。所有产物都是纯数据（无时间戳/无随机），
 * 因此"逐位一致"是可判定的强断言。
 */

import { describe, expect, it } from "vitest";

import {
	GraphSealedError,
	GraphValidationError,
	WorkflowError,
} from "../../src/core/errors.js";
import { StateGraph } from "../../src/core/graph.js";
import { Send } from "../../src/core/send.js";
import { append, concat, overwrite, setOnce } from "../../src/core/state.js";
import {
	type CompiledGraph,
	END,
	type NodeHandler,
	type Router,
	type RouterResult,
	START,
} from "../../src/core/types.js";
import { fnNode } from "../../src/nodes/fn.js";

// ---------------------------------------------------------------------------
// 种子化随机源
// ---------------------------------------------------------------------------

type Rng = () => number;

/** mulberry32：32 位种子 → [0,1) 均匀分布；同种子逐位可复现（无 Math.random）。 */
function mulberry32(seed: number): Rng {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(rng: Rng, items: readonly T[]): T {
	return items[Math.floor(rng() * items.length)];
}

// ---------------------------------------------------------------------------
// 图规格（纯数据；两次 run 从同一 spec 各自装配）
// ---------------------------------------------------------------------------

/**
 * 4 个 channel 的字段类型是 `unknown`：初始值与具体 reducer 的"空值约定"一致
 * （append→[]、concat→""、setOnce→undefined、其余用自然初值），因此同一个 key 在不同的
 * reducer 组合下承载的值类型不同——这正是"随机 reducer 组合"的意义所在。
 */
type PState = { list: unknown; text: unknown; n: unknown; once: unknown };
const CHANNEL_KEYS = ["list", "text", "n", "once"] as const;
type ChannelKey = (typeof CHANNEL_KEYS)[number];

const BASE_REDUCERS = { overwrite, append, concat, setOnce } as const;
type ReducerName = keyof typeof BASE_REDUCERS;

const VALUE_KINDS = [
	"array",
	"string",
	"number",
	"boolean",
	"inc",
	"join",
] as const;
type ValueKind = (typeof VALUE_KINDS)[number];

/** key 的"自然类型"对应的取值方式（overwrite / setOnce / reducer-less 时的相容值）。 */
const NATURAL_KINDS: Record<ChannelKey, readonly ValueKind[]> = {
	list: ["array", "join"],
	text: ["string"],
	n: ["number", "inc"],
	once: ["string"],
};

/** 自然初值（对 overwrite / reducer-less：什么都不写的空状态）。 */
const NATURAL_INITIAL: Record<ChannelKey, unknown> = {
	list: [],
	text: "",
	n: 0,
	once: undefined,
};

/**
 * channel 初值 = 该 reducer 的空值约定：append 的当前值必须是数组、concat 必须是字符串、
 * setOnce 必须是未写过（undefined，§4.5 的约定）；其余用自然初值。初值与 reducer 不相容
 * 的图（如 append 挂在初始为 number 的 key 上）会在第一次写入就必败——那是无信息的噪音，
 * 不是随机组合的价值所在。
 */
function initialValue(
	key: ChannelKey,
	reducer: ReducerName | undefined,
): unknown {
	if (reducer === "append") {
		return [];
	}
	if (reducer === "concat") {
		return "";
	}
	if (reducer === "setOnce") {
		return undefined;
	}
	return NATURAL_INITIAL[key];
}

/**
 * 与 channel 的 **reducer** 相容的取值方式（写入值必须过 reducer 这一关）：
 * append 只吃数组；concat 任意（JS 字符串拼接不强类型）；其余偏好 key 的自然类型。
 * 88% 用相容值、12% 随机 → 错配（InvalidWriteError）是有意的少数派。
 */
function compatibleKinds(
	key: ChannelKey,
	reducer: ReducerName | undefined,
): readonly ValueKind[] {
	if (reducer === "append") {
		return ["array", "join"];
	}
	if (reducer === "concat") {
		return ["string"];
	}
	return NATURAL_KINDS[key];
}

type WriteRule = { key: ChannelKey; kind: ValueKind; constant: number };

type NodeSpec = { name: string; writes: WriteRule[]; spin: number };

const ROUTER_MODES = [
	"string",
	"list",
	"sendConst",
	"sendList",
	"mixed",
	"null",
	"throw",
] as const;
type RouterMode = (typeof ROUTER_MODES)[number];

/** 会真的扇出实例（Send）的模式——统计"完成图里有多少带 Send 扇出"。 */
const SEND_MODES: readonly RouterMode[] = ["sendConst", "sendList", "mixed"];

/**
 * 生成分层（R1，评审：随机图默认太容易撞环）。两个分层各司其职：
 * - `mixed`：全随机（含回边/自环/任意 router 目标）——覆盖"图会合法地失败"的一面；
 * - `forward`：目标只在**更靠后的节点**里挑（边与 router 都是），沿任何激活链索引严格
 *   递增 → 必然终止（最后一个节点的 router 只可能返回 null/END）。这个分层专门供给
 *   "完成 + 两次 run 全轨迹逐位一致"的高价值样本，同时保留随机 reducer 组合与
 *   错配写入（InvalidWriteError 仍然会发生）。
 */
type Strat = "mixed" | "forward";

type RouterSpec = {
	mode: RouterMode;
	/** 字符串目标（6% 概率掺入未注册名 → 运行期 RouterError，合法结局）。 */
	targets: string[];
	sendTarget: string;
	sendCount: number;
	constant: number;
};

type Spec = {
	nodes: NodeSpec[];
	channels: Partial<Record<ChannelKey, ReducerName>>;
	plainEdges: [string, string][];
	routers: { from: string; router: RouterSpec }[];
};

const NODE_NAMES = ["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7"] as const;

function generateWrites(
	rng: Rng,
	channels: Partial<Record<ChannelKey, ReducerName>>,
): WriteRule[] {
	// 25% 的节点不写任何 key（纯路由节点也是一种形状）
	const count = rng() < 0.25 ? 0 : 1 + Math.floor(rng() * 2);
	// 每个节点有一个"偏好 key"：多数写它（不同节点写不同 key → 同超步冲突是例外而非常态），
	// 少数写随机 key（覆盖同 key 多写 → 冲突/reducer 折叠路径）
	const preferred = pick(rng, CHANNEL_KEYS);
	const rules: WriteRule[] = [];
	for (let i = 0; i < count; i += 1) {
		const key = rng() < 0.75 ? preferred : pick(rng, CHANNEL_KEYS);
		const kind =
			rng() < 0.88
				? pick(rng, compatibleKinds(key, channels[key]))
				: pick(rng, VALUE_KINDS);
		rules.push({ key, kind, constant: Math.floor(rng() * 100) });
	}
	return rules;
}

/** router 目标池 = `pool`（mixed 分层是整个图；forward 分层是"更靠后的节点"）。 */
function generateRouter(
	rng: Rng,
	pool: readonly string[],
	from: string,
): RouterSpec {
	const mode = pick(rng, ROUTER_MODES);
	const targetCount = 1 + Math.floor(rng() * 3);
	const targets = Array.from({ length: targetCount }, () =>
		rng() < 0.06 ? "ghost" : pick(rng, pool),
	);
	// Send 目标 70% 避开自己（打到自己的 sendConst = 每轮自我复制直到预算/递归兜底）
	const others = pool.filter((name) => name !== from);
	const sendPool = others.length > 0 && rng() < 0.7 ? others : pool;
	return {
		mode,
		targets,
		sendTarget: rng() < 0.06 ? "ghost" : pick(rng, sendPool),
		sendCount: 1 + Math.floor(rng() * 3),
		constant: Math.floor(rng() * 100),
	};
}

function generateSpec(rng: Rng, injectInvalid: boolean, strat: Strat): Spec {
	const nodeCount = 3 + Math.floor(rng() * 6); // 3..8
	const names = NODE_NAMES.slice(0, nodeCount);

	// channels 先定：节点的取值方式要按各自 reducer 的相容类型来选
	const channels: Partial<Record<ChannelKey, ReducerName>> = {};
	for (const key of CHANNEL_KEYS) {
		// 10% 不声明 reducer（reducer-less 默认覆盖；同超步多写即冲突）
		channels[key] =
			rng() < 0.1
				? undefined
				: pick(rng, [
						"overwrite",
						"overwrite",
						"overwrite",
						"append",
						"append",
						"concat",
						"concat",
						"setOnce",
					] as const);
	}

	const nodes: NodeSpec[] = names.map((name) => ({
		name,
		writes: generateWrites(rng, channels),
		spin: Math.floor(rng() * 3), // 0..2 个微任务跳
	}));

	// 普通边：START → 随机节点（保证图非空、至少跑一个超步）；每个节点 0..2 条出边。
	// mixed 分层：目标 85% 向前、7.5% 任意（回边）、7.5% 自环——环内没有收敛机制的图
	// 必然撞 recursionLimit（§5.5），这是合法结局，但刻意是少数派。
	// forward 分层：只连更靠后的节点（链到尾）——终止性由分层保证。
	const plainEdges: [string, string][] = [[START, pick(rng, names)]];
	const seenEdges = new Set<string>([`${START}->${plainEdges[0][1]}`]);
	const addEdgeSpec = (from: string, to: string): void => {
		const id = `${from}->${to}`;
		if (seenEdges.has(id)) {
			return;
		}
		seenEdges.add(id);
		plainEdges.push([from, to]);
	};
	for (const [index, name] of names.entries()) {
		const forward = names.slice(index + 1);
		const others = names.filter((other) => other !== name);
		const edgeCount = Math.floor(rng() * 3); // 0..2
		for (let i = 0; i < edgeCount; i += 1) {
			const roll = rng();
			if (strat === "forward") {
				if (forward.length > 0) {
					addEdgeSpec(name, pick(rng, forward));
				}
				continue;
			}
			addEdgeSpec(
				name,
				forward.length > 0 && roll < 0.85
					? pick(rng, forward)
					: roll < 0.925
						? pick(rng, others)
						: name,
			);
		}
	}

	const routers: { from: string; router: RouterSpec }[] = [];
	for (const [index, name] of names.entries()) {
		const forward = names.slice(index + 1);
		if (strat === "forward" && forward.length === 0) {
			// 最后一个节点：router 只可能终止（否则它与自己的入边就能成环）
			if (rng() < 0.5) {
				routers.push({
					from: name,
					router: {
						mode: "null",
						targets: [],
						sendTarget: name,
						sendCount: 1,
						constant: Math.floor(rng() * 100),
					},
				});
			}
			continue;
		}
		if (rng() < 0.5) {
			routers.push({
				from: name,
				router: generateRouter(
					rng,
					strat === "forward" ? forward : names,
					name,
				),
			});
		}
	}

	// 少数迭代（见 SEED_BASE 旁的 INVALID_EVERY）故意制造 compile 期非法的图（未注册的
	// 边目标）：必须被 SKIP（不算失败、不执行），让"跳过构造期非法图"这条要求有活体覆盖
	if (injectInvalid) {
		plainEdges.push([pick(rng, names), "ghost"]);
	}

	return { nodes, channels, plainEdges, routers };
}

/** 图规格的自然语言摘要（调试/报告用；不参与断言）。 */
function describeSpec(spec: Spec): string {
	const channels = Object.entries(spec.channels)
		.filter(([, name]) => name !== undefined)
		.map(([key, name]) => `${key}:${name}`)
		.join(",");
	return [
		`nodes=[${spec.nodes.map((n) => `${n.name}(${n.writes.length}w,spin${n.spin})`).join(" ")}]`,
		`edges=[${spec.plainEdges.map(([from, to]) => `${from}>${to}`).join(" ")}]`,
		`routers=[${spec.routers.map((r) => `${r.from}:${r.router.mode}`).join(" ")}]`,
		`channels={${channels}}`,
	].join(" ");
}

// ---------------------------------------------------------------------------
// 装配（每次 run 一份全新的 recorder / 闭包 / builder）
// ---------------------------------------------------------------------------

type HandlerCall = {
	seq: number;
	superstep: number;
	node: string;
	input: unknown;
	output: unknown;
};
type RouterCall = {
	node: string;
	state: unknown;
	lastUpdate: unknown;
	result: unknown;
};
type ReducerCall = {
	key: string;
	current: unknown;
	update: unknown;
	outcome: { ok: true; next: unknown } | { ok: false; message: string };
};

type Recorder = {
	handlerCalls: HandlerCall[];
	routerCalls: RouterCall[];
	reducerCalls: ReducerCall[];
};

function clone(value: unknown): unknown {
	// 轨迹里全部是纯数据（数字/字符串/布尔/null/数组/普通对象）→ 可安全深克隆
	return structuredClone(value);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 动态装配用的宽 reducer：channel 的 reducer 由 key 决定，泛型在运行时已擦除。 */
// biome-ignore lint/suspicious/noExplicitAny: 属性测试的动态装配，签名不参与公开面
type LooseReducer = (current: any, update: any) => any;

function wrapReducer(
	key: string,
	base: LooseReducer,
	recorder: Recorder,
): LooseReducer {
	return (current, update) => {
		try {
			const next = base(current, update);
			recorder.reducerCalls.push({
				key,
				current: clone(current),
				update: clone(update),
				outcome: { ok: true, next: clone(next) },
			});
			return next;
		} catch (error) {
			recorder.reducerCalls.push({
				key,
				current: clone(current),
				update: clone(update),
				outcome: { ok: false, message: messageOf(error) },
			});
			throw error;
		}
	};
}

/** rule → 具体值；输入派生值（inc/join）只读输入的同名字段，读到非预期形状时回落常数。 */
function valueFor(rule: WriteRule, input: unknown): unknown {
	const record = isRecord(input) ? input : {};
	switch (rule.kind) {
		case "array":
			return [rule.constant];
		case "string":
			return `s${rule.constant}`;
		case "number":
			return rule.constant;
		case "boolean":
			return rule.constant % 2 === 0;
		case "inc":
			return (typeof record.n === "number" ? record.n : 0) + 1;
		case "join":
			return [
				...(Array.isArray(record.list) ? record.list : []),
				rule.constant,
			].slice(-3);
	}
}

function materializeHandler(
	node: NodeSpec,
	recorder: Recorder,
): NodeHandler<PState, unknown> {
	return async (input, ctx) => {
		for (let hop = 0; hop < node.spin; hop += 1) {
			await Promise.resolve();
		}
		const partial: Record<string, unknown> = {};
		for (const rule of node.writes) {
			partial[rule.key] = valueFor(rule, input);
		}
		recorder.handlerCalls.push({
			seq: ctx.seq,
			superstep: ctx.superstep,
			node: node.name,
			input: clone(input),
			output: clone(partial),
		});
		return partial as Partial<PState>;
	};
}

/** router 结果的可比较投影（Send 不是可克隆对象 → 展开成 `{send, input}`）。 */
function projectRoute(result: RouterResult): unknown {
	if (result instanceof Send) {
		return { send: result.node, input: result.input };
	}
	if (Array.isArray(result)) {
		return result.map((item) => projectRoute(item));
	}
	return result;
}

function materializeRouter(
	from: string,
	spec: RouterSpec,
	recorder: Recorder,
): Router<PState> {
	return (state, lastUpdate) => {
		let result: RouterResult;
		switch (spec.mode) {
			case "string":
				result = spec.targets[0];
				break;
			case "list":
				result = spec.targets;
				break;
			case "sendConst":
				result = Array.from(
					{ length: spec.sendCount },
					(_, index) =>
						new Send(spec.sendTarget, { k: index, c: spec.constant }),
				);
				break;
			case "sendList": {
				// 扇出宽度由数据规模决定（§5.3 的 map-reduce 形态；循环里 list 增长会撞预算）
				const list = Array.isArray(state.list) ? state.list : [];
				result = list
					.slice(0, 3)
					.map((value) => new Send(spec.sendTarget, { v: value }));
				break;
			}
			case "mixed":
				result = [
					spec.targets[0],
					new Send(spec.sendTarget, { c: spec.constant }),
					END,
				];
				break;
			case "null":
				result = null;
				break;
			case "throw": {
				const error = new Error(`router boom ${spec.constant}`);
				recorder.routerCalls.push({
					node: from,
					state: clone(state),
					lastUpdate: clone(lastUpdate),
					result: { threw: messageOf(error) },
				});
				throw error;
			}
		}
		recorder.routerCalls.push({
			node: from,
			state: clone(state),
			lastUpdate: clone(lastUpdate),
			result: projectRoute(result),
		});
		return result;
	};
}

function buildGraph(spec: Spec, recorder: Recorder): StateGraph<PState> {
	const channels: Record<string, LooseReducer> = {};
	for (const [key, name] of Object.entries(spec.channels)) {
		if (name === undefined) {
			continue; // reducer-less：默认 last-value 覆盖 + 同折叠冲突检查
		}
		channels[key] = wrapReducer(
			key,
			BASE_REDUCERS[name as ReducerName] as LooseReducer,
			recorder,
		);
	}

	const builder = new StateGraph<PState>({ name: "property", channels });
	for (const node of spec.nodes) {
		builder.addNode(
			node.name,
			fnNode<PState, unknown>(materializeHandler(node, recorder)),
		);
	}
	for (const [from, to] of spec.plainEdges) {
		builder.addEdge(from, to);
	}
	for (const { from, router } of spec.routers) {
		builder.addConditionalEdges(
			from,
			materializeRouter(from, router, recorder),
		);
	}
	return builder;
}

function initialState(spec: Spec): PState {
	return {
		list: initialValue("list", spec.channels.list),
		text: initialValue("text", spec.channels.text),
		n: initialValue("n", spec.channels.n),
		once: initialValue("once", spec.channels.once),
	};
}

type Attempt =
	| { status: "completed"; state: PState; recorder: Recorder }
	| { status: "failed"; error: unknown }
	| { status: "skipped"; error: unknown };

/**
 * 一次独立装配 + 独立 compile + 一次 run。构造期非法图 → skipped；
 * 运行期错误原样带出（由调用方断言"是 WorkflowError 家族"）。
 * run 选项刻意收紧：小预算让失控图（循环/扇出爆炸）快速以合法错误结束。
 */
async function attempt(spec: Spec): Promise<Attempt> {
	const recorder: Recorder = {
		handlerCalls: [],
		routerCalls: [],
		reducerCalls: [],
	};
	let compiled: CompiledGraph<PState>;
	try {
		compiled = buildGraph(spec, recorder).compile();
	} catch (error) {
		if (
			error instanceof GraphValidationError ||
			error instanceof GraphSealedError
		) {
			return { status: "skipped", error };
		}
		throw error;
	}
	try {
		const { state } = await compiled.run(initialState(spec), {
			recursionLimit: 10,
			maxInstancesPerSuperstep: 32,
			maxTotalInstances: 128,
			maxConcurrency: 4,
		});
		return { status: "completed", state, recorder };
	} catch (error) {
		return { status: "failed", error };
	}
}

// ---------------------------------------------------------------------------
// 属性断言
// ---------------------------------------------------------------------------

const ITERATIONS = 30;
/** 2026-10-07：固定基准种子——每个迭代的种子 = 基准 + i，完全可复现。 */
const SEED_BASE = 20_261_007;
/** 每 7 个迭代生成一张 compile 期非法的图（`iteration % 7 === 3`）→ SKIP 路径有活体覆盖。 */
const INVALID_EVERY = 7;
/** 每 3 个迭代换用 `forward` 分层（~1/3 的种子专门供给"完成图"的全轨迹比较，R1）。 */
const FORWARD_EVERY = 3;

/** 失败的可比较指纹：类名 + 消息（两次 run 的失败必须逐字一致）。 */
function failureFingerprint(error: unknown): string {
	if (error instanceof Error) {
		return `${error.constructor.name}: ${error.message}`;
	}
	return `non-error: ${String(error)}`;
}

describe("property: seeded random graphs are deterministic (设计 §12)", () => {
	it("random graphs are deterministic (seeded, 30 iterations)", async () => {
		const stats = {
			/** 两次 run 都完成 → 做了 state + 全轨迹的逐位比较。 */
			completed: 0,
			/** 完成图里带 router / 带 Send 扇出的数量（保证高价值样本不是"光杆链"）。 */
			completedWithRouter: 0,
			completedWithSendFanout: 0,
			/** 两次 run 都以（合法的）WorkflowError 失败 → 比较错误类 + 消息。 */
			failed: 0,
			/** 构造期非法的图 → 跳过（不算失败）。 */
			skipped: 0,
			withRouters: 0,
			withSendFanout: 0,
			multiSuperstep: 0,
		};

		for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
			const seed = SEED_BASE + iteration;
			const spec = generateSpec(
				mulberry32(seed),
				iteration % INVALID_EVERY === 3,
				iteration % FORWARD_EVERY === 2 ? "forward" : "mixed",
			);
			const label = `seed ${seed} (iteration ${iteration}): ${describeSpec(spec)}`;

			const hasRouter = spec.routers.length > 0;
			const hasSendFanout = spec.routers.some(({ router }) =>
				SEND_MODES.includes(router.mode),
			);

			if (hasRouter) {
				stats.withRouters += 1;
			}
			if (hasSendFanout) {
				stats.withSendFanout += 1;
			}

			// 两次 run：同一 spec、各自独立装配 + 独立 compile
			const first = await attempt(spec);
			const second = await attempt(spec);

			// (0) 结局一致（含 SKIP）：同一 spec 两次装配不允许一次跳过、另一次照跑
			expect(second.status, `${label} [outcome]`).toBe(first.status);
			if (first.status === "skipped" && second.status === "skipped") {
				stats.skipped += 1;
				continue;
			}

			// (1) 没有非预期错误类型：任何失败都必须是 WorkflowError 家族
			if (first.status === "failed") {
				expect(first.error, `${label} [run A]`).toBeInstanceOf(WorkflowError);
			}
			if (second.status === "failed") {
				expect(second.error, `${label} [run B]`).toBeInstanceOf(WorkflowError);
			}

			if (first.status === "completed" && second.status === "completed") {
				stats.completed += 1;
				if (hasRouter) {
					stats.completedWithRouter += 1;
				}
				if (hasSendFanout) {
					stats.completedWithSendFanout += 1;
				}
				const supersteps = first.recorder.handlerCalls.map(
					(call) => call.superstep,
				);
				if (supersteps.some((step) => step > 1)) {
					stats.multiSuperstep += 1;
				}
				// 完成图必然执行过节点（recorder 非空 → 轨迹比较非空洞）
				expect(
					first.recorder.handlerCalls.length,
					`${label} [recorder]`,
				).toBeGreaterThan(0);

				// (2) 最终 state 与整条轨迹逐位一致
				expect(second.state, `${label} [state]`).toEqual(first.state);
				expect(second.recorder, `${label} [trace]`).toEqual(first.recorder);
			} else if (first.status === "failed" && second.status === "failed") {
				stats.failed += 1;
				// (3) 失败也要一模一样：合法错误类 + 消息逐字一致
				expect(failureFingerprint(second.error), `${label} [error]`).toBe(
					failureFingerprint(first.error),
				);
			} else {
				// 上一条 outcome 断言已经排除了这个分支；留在这里只为类型穷尽
				throw new Error(
					`${label}: mixed outcomes (${first.status} vs ${second.status})`,
				);
			}
		}

		// 反空洞下限（数值取实测产出并留余量；不得为了"好看"往下调）。
		// 随机图的失败是设计的一部分（环撞 recursionLimit、错配/冲突抛 InvalidWriteError、
		// 非法路由抛 RouterError——都是合法的 WorkflowError 结局），所以下限盯的是
		// "高价值样本（完成 + 两次全轨迹一致）足够多"，低于它说明生成器退化成只有失败图。
		expect(stats.completed + stats.failed + stats.skipped).toBe(ITERATIONS);
		expect(stats.completed).toBeGreaterThanOrEqual(7);
		expect(stats.completedWithRouter).toBeGreaterThanOrEqual(5);
		expect(stats.completedWithSendFanout).toBeGreaterThanOrEqual(2);
		expect(stats.multiSuperstep).toBeGreaterThanOrEqual(3);
		expect(stats.withRouters).toBeGreaterThanOrEqual(15);
		expect(stats.withSendFanout).toBeGreaterThanOrEqual(5);
		// SKIP 路径有活体覆盖（注入的非法图确实被跳过，而不是算成失败）
		expect(stats.skipped).toBeGreaterThanOrEqual(1);
		expect(stats.skipped).toBeLessThanOrEqual(8);
	});
});
