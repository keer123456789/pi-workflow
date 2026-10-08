/**
 * Task 13：包公开面验收（设计 §4/§7.5/§10、§13 M1"公开面见 src/index.ts"）。
 *
 * 两条腿：
 * 1. **运行期值名不增不漏**：`Object.keys(import * as api)` 的精确集合（M2 增 `llmNode`、
 *    M3 增 `agentNode`）
 *    ——多导（内部设施泄漏）或少导（调用方拿不到）都直接红；
 * 2. **公开类型名在类型位置可用**：25 个类型名各用一次（含一个走公开 API 的最小图；
 *    M2 增 `TokenUsage`/`CompleteFn`/`RunLogger`；M3 增 `AgentExecutor`/
 *    `PiSubprocessConfig`；M4 增 `PiSdkConfig`），名字缺失/改名时 `npm run typecheck`
 *    失败——类型没有运行期痕迹，只能这样钉。
 *
 * 第三个用例把公开面**当包用**：只用 `src/index.js` 的导出构建并跑通一张图
 * （Send 扇出 + append 合并 + 错误类实例判定），确认导出之间彼此自洽。
 */

import { describe, expect, it } from "vitest";
import type {
	AgentExecutor,
	ChannelUpdate,
	CompiledGraph,
	CompiledGraphData,
	CompileOptions,
	CompleteFn,
	GraphCfg,
	NodeContext,
	NodeDefinition,
	NodeHandler,
	PiSdkConfig,
	PiSubprocessConfig,
	Reducer,
	ResolvedServices,
	Router,
	RouterResult,
	RunEvent,
	RunHandle,
	RunLogger,
	RunOptions,
	RunResult,
	Services,
	SleepResult,
	StateSchema,
	TokenUsage,
} from "../src/index.js";
import * as api from "../src/index.js";
import {
	append,
	END,
	fnNode,
	RouterError,
	Send,
	START,
	StateGraph,
	WorkflowError,
} from "../src/index.js";

type PublicState = { items: number[]; seen: number[] };

describe("public surface: src/index.ts (设计 §10)", () => {
	it("exports exactly the M1+M2+M3 public value names — no leaks, no gaps", () => {
		// 9 个错误类 + 图构建/执行 7 名（StateGraph/Send/START/END/fnNode/llmNode/agentNode）+ 4 reducer
		// + interpolate = 21 个运行期导出
		expect(Object.keys(api).sort()).toEqual([
			"END",
			"GraphRecursionError",
			"GraphSealedError",
			"GraphValidationError",
			"InstanceBudgetError",
			"InvalidWriteError",
			"NodeExecutionError",
			"RouterError",
			"START",
			"Send",
			"StateGraph",
			"TemplateError",
			"WorkflowError",
			"agentNode",
			"append",
			"concat",
			"fnNode",
			"interpolate",
			"llmNode",
			"overwrite",
			"setOnce",
		]);
		// 内部设施不泄漏（抽查：引擎/发射器/reducer 折叠辅助）
		for (const internal of [
			"executeRun",
			"resolveServices",
			"createEmitter",
			"foldUpdates",
			"stateKeyUniverse",
		]) {
			expect(internal in api).toBe(false);
		}
	});

	it("exports every public type name at type position (compile-time check)", async () => {
		// —— M2 三个新公开类型名（D4/D5/D6）各在类型位置真实使用一次 ——
		const usage: TokenUsage = {
			input: 3,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 8,
			cost: {
				input: 0.1,
				output: 0.2,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0.3,
			},
		};
		const complete: CompleteFn = async (req) => ({ text: req.prompt, usage });
		const loggerCalls: string[] = [];
		const runLogger: RunLogger = {
			onRunStart: (info) => {
				loggerCalls.push(`start:${info.graph}`);
			},
			onEvent: (event) => {
				loggerCalls.push(event.type);
			},
			onRunFinish: (info) => {
				loggerCalls.push(`finish:${info.status}`);
			},
		};

		// —— M3 两个新公开类型名（§9.1 AgentExecutor / §4.6 PiSubprocessConfig）——
		// 最小合法形状：req 由 handler 层构造（D20/D22），executor 只消费并回产出
		const executor: AgentExecutor = async (req) => ({ output: req.task });
		// 字段全可选——空对象 {} 合法（D20：compile 期只校验配置存在）
		const subCfg: PiSubprocessConfig = {};

		// —— M4 新公开类型名（§4.6/§9.3 PiSdkConfig）——
		// 字段全可选（D25/D27：agentDir/cwd/defaultModel 各有缺省），空对象 {} 合法
		const sdkCfg: PiSdkConfig = {};

		// —— 每一个公开类型名都被真实使用一次；缺名/改名的代价是 typecheck 失败 ——
		const channels: StateSchema<PublicState> = { seen: append };
		const reducer: Reducer<number[]> = append as Reducer<number[]>;
		const nodeHandler: NodeHandler<PublicState, { item: number }> = (
			_input,
			ctx,
		) => {
			const context: NodeContext = ctx;
			// NodeContext.reportUsage（D11）——引擎总是提供；这里运行时是 no-op（M1 引擎未接线）
			context.reportUsage?.(usage);
			return { seen: [context.seq] };
		};
		const nodeDefinition: NodeDefinition<PublicState, { item: number }> =
			fnNode(nodeHandler);
		// NodeDefinition.complete（D12，仅 llm kind 合法）——手工定义、不进图
		// （compile 对 llm 的校验属 M2 后续任务）
		const llmDefinition: NodeDefinition<PublicState> = {
			kind: "llm",
			name: "classify",
			handler: async () => ({}),
			complete,
		};
		const router: Router<PublicState> = (state) => {
			const result: RouterResult = state.items.map(
				(item) => new Send("worker", { item }),
			);
			return result;
		};
		const graphCfg: GraphCfg<PublicState> = {
			name: "public-surface",
			channels,
		};
		// Services.complete / Services.logger（D12/D2/R2）——不再是 unknown 占位
		const services: Services = { complete, logger: runLogger };
		const compileOptions: CompileOptions = {
			services: {} satisfies Services,
		};
		const graph = new StateGraph<PublicState>(graphCfg)
			.addNode(
				"seed",
				fnNode<PublicState>(() => ({})),
			)
			.addNode("worker", nodeDefinition)
			.addEdge(START, "seed")
			.addConditionalEdges("seed", router)
			.addEdge("worker", END);

		const events: RunEvent[] = [];
		const runOptions: RunOptions = { onEvent: (event) => events.push(event) };
		// M2 正例 pin（D2，替代 R21 的 @ts-expect-error）：三字段已回归 RunOptions；
		// 任一字段被删/改名，下面的对象字面量因 excess property 检查失败 → typecheck 红。
		const m2RunOptions: RunOptions = {
			logDir: ".pi-workflow/runs/",
			logOutputs: "hash",
			onLogError: "warn",
		};
		const compiled: CompiledGraph<PublicState> = graph.compile(compileOptions);
		const handle: RunHandle<PublicState> = compiled.run(
			{ items: [1, 2], seen: [] },
			runOptions,
		);
		const update: ChannelUpdate = { key: "seen", value: [1], writer: "worker" };
		const resolved: ResolvedServices = {
			clock: () => 0,
			sleep: (ms) => {
				const pending: SleepResult = new Promise<void>((resolve) =>
					setTimeout(resolve, ms),
				);
				return pending;
			},
			random: () => 0.5,
		};
		// CompiledGraphData 是公开类型：手工装配一份最小图数据（引擎的 run 入口签名用它）
		const data: CompiledGraphData<PublicState> = {
			name: "hand-built",
			channels,
			nodes: new Map([["worker", nodeDefinition]]),
			plainEdges: new Map([[START, ["worker"]]]),
			routers: new Map(),
			warnings: [],
		};
		// RunEvent.node_finished.usage?: TokenUsage（D11）——带 usage 的完成事件字面量
		const finishedWithUsage: RunEvent = {
			seq: 0,
			superstep: 0,
			ts: 0,
			runId: "r",
			type: "node_finished",
			node: "classify",
			instanceId: "classify#1",
			output: null,
			usage,
			durationMs: 0,
		};

		const runResult: RunResult<PublicState> = await handle;
		const result = runResult;

		expect(result.state.seen).toHaveLength(2);
		expect(typeof result.runId).toBe("string");
		expect(events.map((event) => event.type)).toContain("superstep_committed");
		expect(update.key).toBe("seen");
		// M2 类型引用同时避免 unused 告警（运行期值只是类型 pin 的载体）
		expect(m2RunOptions.logDir).toBe(".pi-workflow/runs/");
		expect(services.complete).toBe(complete);
		expect(services.logger).toBe(runLogger);
		expect(llmDefinition.complete).toBe(complete);
		// M3/M4 类型引用同时避免 unused 告警（运行期值只是类型 pin 的载体）
		expect(typeof executor).toBe("function");
		expect(subCfg).toEqual({});
		expect(sdkCfg).toEqual({});
		expect(finishedWithUsage.type).toBe("node_finished");
		expect(resolved.clock()).toBe(0);
		expect(reducer([1], [2])).toEqual([1, 2]);
		expect(data.nodes.has("worker")).toBe(true);
		expect(data.plainEdges.get(START)).toEqual(["worker"]);
	});

	it("works end-to-end through the package surface (Send fan-out + append + error class)", async () => {
		type S = { items: number[]; seen: number[] };
		const graph = new StateGraph<S>({ channels: { seen: append } })
			.addNode(
				"seed",
				fnNode<S>((input) => ({ items: [...input.items] })),
			)
			.addNode(
				"worker",
				fnNode<S, { item: number }>((input) => ({
					seen: [input.item * 10],
				})),
			)
			.addEdge(START, "seed")
			.addConditionalEdges("seed", (state) =>
				state.items.map((item) => new Send("worker", { item })),
			)
			.addEdge("worker", END);

		const { state, runId } = await graph
			.compile()
			.run({ items: [1, 2, 3], seen: [] });

		expect(state.seen).toEqual([10, 20, 30]);
		expect(runId).toBeTruthy();

		// 错误类经包面可用：非法路由（未知节点）→ RouterError，且是 WorkflowError 家族
		const broken = new StateGraph<S>({ channels: { seen: append } })
			.addNode(
				"seed",
				fnNode<S>(() => ({})),
			)
			.addEdge(START, "seed")
			.addConditionalEdges("seed", () => "nope");

		const failure: unknown = await broken
			.compile()
			.run({ items: [], seen: [] })
			.then(
				() => undefined,
				(error: unknown) => error,
			);

		expect(failure).toBeInstanceOf(RouterError);
		expect(failure).toBeInstanceOf(WorkflowError);
		expect((failure as RouterError).result).toBe("nope");
	});
});
