/**
 * Task 13：包公开面验收（设计 §4/§7.5/§10、§13 M1"公开面见 src/index.ts"）。
 *
 * 两条腿：
 * 1. **运行期值名不增不漏**：`Object.keys(import * as api)` 的精确集合——多导（内部设施
 *    泄漏）或少导（调用方拿不到）都直接红；
 * 2. **公开类型名在类型位置可用**：19 个类型名各用一次（含一个走公开 API 的最小图），
 *    名字缺失/改名时 `npm run typecheck` 失败——类型没有运行期痕迹，只能这样钉。
 *
 * 第三个用例把公开面**当包用**：只用 `src/index.js` 的导出构建并跑通一张图
 * （Send 扇出 + append 合并 + 错误类实例判定），确认导出之间彼此自洽。
 */

import { describe, expect, it } from "vitest";
import type {
	ChannelUpdate,
	CompiledGraph,
	CompiledGraphData,
	CompileOptions,
	GraphCfg,
	NodeContext,
	NodeDefinition,
	NodeHandler,
	Reducer,
	ResolvedServices,
	Router,
	RouterResult,
	RunEvent,
	RunHandle,
	RunOptions,
	Services,
	SleepResult,
	StateSchema,
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
	it("exports exactly the M1 public value names — no leaks, no gaps", () => {
		// 9 个错误类 + 图构建/执行 5 名（StateGraph/Send/START/END/fnNode）+ 4 reducer
		// + interpolate = 19 个运行期导出
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
			"append",
			"concat",
			"fnNode",
			"interpolate",
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
		// —— 每一个公开类型名都被真实使用一次；缺名/改名的代价是 typecheck 失败 ——
		const channels: StateSchema<PublicState> = { seen: append };
		const reducer: Reducer<number[]> = append as Reducer<number[]>;
		const nodeHandler: NodeHandler<PublicState, { item: number }> = (
			_input,
			ctx,
		) => {
			const context: NodeContext = ctx;
			return { seen: [context.seq] };
		};
		const nodeDefinition: NodeDefinition<PublicState, { item: number }> =
			fnNode(nodeHandler);
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

		const result = await handle;

		expect(result.state.seen).toHaveLength(2);
		expect(typeof result.runId).toBe("string");
		expect(events.map((event) => event.type)).toContain("superstep_committed");
		expect(update.key).toBe("seen");
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
