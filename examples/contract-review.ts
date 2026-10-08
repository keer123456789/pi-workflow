/**
 * pi-workflow 完整示例：合同审查（design §4.1 图形态）
 *
 * 图：load_doc → extract ─(条件边 Send 扇出)→ review×K → gate ─(风险分级路由)→
 *     precedent_check(仅高风险) → aggregate；clauses / riskReports 为 append channel。
 *
 * 运行前置（npm self-reference）：
 *   1. `npm run build` —— 本示例经包名自引用导入 "@wangchengshi/pi-workflow"，
 *      Node 按 package.json 的 exports 解析到 dist/，必须先构建；
 *   2. `node examples/contract-review.ts` —— Node ≥22.18 原生类型剥离直接跑 .ts
 *      单文件，无需 ts-node / 先编译。示例不 import 仓库内 src 相对路径（类型剥离
 *      解析不了 .js→.ts 映射）。
 *
 * 双模运行（D35）：
 *   - mock（默认：PI_WORKFLOW_EXAMPLE_MOCK 未设或 ≠ "0"）——全程离线：llm 节点经
 *     `compile({ services: { complete: mockComplete } })` 注入冻结的 mock 补全
 *     （关键词映射见 D36 与 mockComplete 注释）；agent 节点 executor 用自定义函数
 *     （D20 扩展点的函数形态），不走 subprocess / sdk。
 *   - 真实（PI_WORKFLOW_EXAMPLE_MOCK=0）——需要 pi 凭据：llm 节点不注入 complete，
 *     走 pi-ai 默认实现（optional peer dep，缺失则 compile 报错）；agent 节点
 *     `executor: "sdk"` + `services.agent.sdk: {}`（M4 sdk 适配器，空对象 = 全默认）。
 *
 * run 日志（JSONL）固定写到 `os.tmpdir()/pi-workflow-example-runs/<时间戳>-<runId>/run.jsonl`
 * （D35：仓库零污染）。
 *
 * 与 §4.1 代码骨架的两处落地差异（骨架为示意，这里按真实 API 语义落地）：
 *   1. **产出 schema 为数组形态**：节点产出经 writeTo **原样**成为目标 channel 的
 *      更新值，而标准 append reducer 做数组拼接（要求更新值是数组）——所以
 *      extract / review / precedent_check 的产出 schema 落地为 T.Array(...)，
 *      §4.1 的 ClauseList（对象包一层）在此拆成 Clause 元素 schema + 数组产出；
 *   2. **补 START→load_doc→extract 普通边**：§4.1 数据流图里有、代码骨架省略了，
 *      没有这两条边图不会启动。
 */

import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	END,
	START,
	Send,
	StateGraph,
	agentNode,
	append,
	fnNode,
	llmNode,
} from "@wangchengshi/pi-workflow";
import type {
	AgentExecutor,
	CompleteFn,
	RunEvent,
	TokenUsage,
} from "@wangchengshi/pi-workflow";
import { Type as T, type Static } from "typebox";

// ---------------------------------------------------------------------------
// Schema（§4.1；数组形态的差异说明见文件头）
// ---------------------------------------------------------------------------

/** 单条条款。 */
const Clause = T.Object({ id: T.String(), text: T.String() });
/** extract 的产出 schema：条款数组（append channel 要求产出为可拼接的数组）。 */
const ClauseList = T.Array(Clause);
/** 单份风险报告（§4.1 的 RiskReport，原样保留为元素 schema）。 */
const RiskReport = T.Object({
	clauseId: T.String(),
	risks: T.Array(T.String()),
	severity: T.Union([T.Literal("high"), T.Literal("medium"), T.Literal("low")]),
});
/** review / precedent_check 的产出 schema：单元素数组（同 append 语义）。 */
const RiskReportList = T.Array(RiskReport);

type S = {
	path: string;
	contractText: string;
	clauses: Static<typeof ClauseList>; // append
	riskReports: Static<typeof RiskReportList>; // append
	finalReport: string;
};

// ---------------------------------------------------------------------------
// mock 模式（D35/D36）：冻结数据 + 按 prompt 节点关键词映射的 mock 实现
// ---------------------------------------------------------------------------

/** 与 fixtures/sample-contract.md 三条款一一对应的冻结抽取结果。 */
const MOCK_CLAUSES: Static<typeof ClauseList> = [
	{
		id: "c1",
		text: "甲方有权随时解除本合同，无需说明理由，无需提前通知，亦无需向乙方支付任何补偿；合同解除后，双方权利义务终止，乙方已提供服务的费用按甲方确认的工作量结算。",
	},
	{
		id: "c2",
		text: "本合同服务费共计人民币 50,000 元（大写：伍万元整）。乙方完成全部服务内容并经甲方验收合格后 10 个工作日内，甲方一次性向乙方支付。",
	},
	{
		id: "c3",
		text: "双方对履行本合同过程中知悉的对方商业秘密负有保密义务，未经对方书面同意不得向任何第三方披露。保密期限自本合同签署之日起两年。",
	},
];

/** review 的 severity 按 clauseId 映射：c1 = high，其余 = low（D36）。 */
const MOCK_REVIEWS: Record<string, Static<typeof RiskReport>> = {
	c1: {
		clauseId: "c1",
		severity: "high",
		risks: [
			"甲方享有随时、无条件、无补偿的单方解除权，双方权利义务显著失衡，乙方前期投入面临归零风险",
		],
	},
	c2: {
		clauseId: "c2",
		severity: "low",
		risks: ["付款金额、验收条件与支付期限约定明确，未发现明显风险"],
	},
	c3: {
		clauseId: "c3",
		severity: "low",
		risks: ["保密范围与两年保密期限属常见约定，未发现明显风险"],
	},
};

/** precedent_check（agent 节点）对 c1 的冻结类案核查报告。 */
const MOCK_PRECEDENT_C1: Static<typeof RiskReport> = {
	clauseId: "c1",
	severity: "high",
	risks: [
		"类案核查：该单方解除权表述与类案库中 3 起服务合同纠纷判例高度相似，解除权行使边界与补偿安排均为争议焦点",
	],
};

/** aggregate 产出的最终报告文本（含 c1 高风险判定）。 */
const MOCK_FINAL_REPORT = `【合同审查报告】共抽取条款 3 条：高风险 1 条（c1），低风险 2 条（c2、c3）。

c1（高风险）：甲方享有随时、无条件、无补偿的单方解除权，双方权利义务显著失衡；
类案核查确认该表述与库内 3 起服务合同纠纷判例高度相似。建议改为「经双方协商一致
或符合约定解除事由方可解除，并按已完成工作量结算」。

c2（低风险）：付款安排明确，可保留。
c3（低风险）：保密约定合理，可保留。`;

const mockUsage = (): TokenUsage => ({
	input: 128,
	output: 64,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 192,
});

/**
 * mock 补全（CompleteFn，D36）：按 prompt 中**节点关键词**返回与 fixture 对应的、
 * schema 合法的 JSON。关键词取各节点 prompt 模板的独有短语；fixture 文本刻意避开
 * 这些短语，保证不误配。precedent_check 是 agent 节点，不经 complete（见下）。
 */
const mockComplete: CompleteFn = async ({ prompt }) => {
	// extract："从以下合同中抽取全部条款，输出 JSON：\n{contractText}"
	if (prompt.includes("抽取全部条款")) {
		return { text: JSON.stringify(MOCK_CLAUSES), usage: mockUsage() };
	}
	// review："审查条款 {clause} 的法律风险，输出 JSON"（{clause} 插值为条款 JSON）
	if (prompt.includes("审查条款")) {
		const id = /"id"\s*:\s*"([^"]+)"/.exec(prompt)?.[1] ?? "unknown";
		const report: Static<typeof RiskReport> = MOCK_REVIEWS[id] ?? {
			clauseId: id,
			severity: "low",
			risks: [],
		};
		return { text: JSON.stringify([report]), usage: mockUsage() };
	}
	// aggregate："汇总以下风险报告，生成审查报告：\n{riskReports}"
	if (prompt.includes("汇总以下风险报告")) {
		return { text: JSON.stringify(MOCK_FINAL_REPORT), usage: mockUsage() };
	}
	throw new Error(
		`mockComplete: unrecognized prompt (the example mock only knows the three llm prompts): ${prompt.slice(0, 80)}`,
	);
};

/**
 * mock agent 执行器（AgentExecutor，D20 函数形态）：真实模式下请改用
 * `executor: "sdk"`（或 "subprocess"）。task 形如
 * "结合案卷材料核查条款 c1 的引用是否准确"（handler 会在其后拼接 schema 指令）。
 * 产出必须是 RiskReportList（T.Array(RiskReport)）的合法 JSON——handler 层会
 * JSON.parse + Value.Check。
 */
const mockAgentExecutor: AgentExecutor = async ({ task }) => {
	const id = /核查条款\s*(\S+?)\s*的引用/.exec(task)?.[1] ?? "unknown";
	const report: Static<typeof RiskReport> =
		id === "c1"
			? MOCK_PRECEDENT_C1
			: { clauseId: id, severity: "low", risks: ["类案核查：未发现相关判例"] };
	return { output: JSON.stringify([report]), usage: mockUsage() };
};

// ---------------------------------------------------------------------------
// 图构建（§4.1 图形态逐段对应）
// ---------------------------------------------------------------------------

const mock = process.env.PI_WORKFLOW_EXAMPLE_MOCK !== "0";
const contractPath = fileURLToPath(
	new URL("./fixtures/sample-contract.md", import.meta.url),
);
const logDir = join(tmpdir(), "pi-workflow-example-runs");

async function readContract(path: string, signal: AbortSignal): Promise<string> {
	return readFile(path, { encoding: "utf8", signal });
}

const app = new StateGraph<S>({
	name: "contract-review", // 用于日志标识
	channels: { clauses: append, riskReports: append },
})
	.addNode(
		"load_doc",
		// 输入 = 初始 state（§4.1 骨架的 fnNode<{path},…> 泛型是示意；真实签名
		// fnNode<S, I>，I 为实例输入类型，缺省 = S）
		fnNode<S>(async (s, ctx) => ({
			contractText: await readContract(s.path, ctx.signal),
		})),
	)
	.addEdge(START, "load_doc")
	.addEdge("load_doc", "extract")
	.addNode(
		"extract",
		// 类型参数 <S, "clauses">：writeTo 指向的 channel 名（第二个类型参数无缺省，
		// 不能只给 <S>——显式类型实参不支持部分推断）
		llmNode<S, "clauses">({
			prompt: "从以下合同中抽取全部条款，输出 JSON：\n{contractText}",
			schema: ClauseList,
			writeTo: "clauses",
		}),
	)
	// 注意：extract 到 review 没有普通边！扇出完全由 extract 的 router 驱动
	.addConditionalEdges("extract", (s) =>
		s.clauses.map((c) => new Send("review", { clause: c })),
	)
	.addNode(
		"review",
		llmNode<S, "riskReports">({
			// 经 Send 进入，输入 = { clause }（{clause} 插值为条款 JSON）
			prompt: "审查条款 {clause} 的法律风险，输出 JSON",
			schema: RiskReportList,
			writeTo: "riskReports",
			retry: { maxAttempts: 3 },
		}),
	)
	.addNode(
		"gate",
		fnNode<S>(() => ({})), // 纯路由节点：扇入汇聚点，无副作用
	)
	.addConditionalEdges("gate", (s) => {
		const high = s.riskReports.filter((r) => r.severity === "high");
		return high.length > 0
			? high.map((r) => new Send("precedent_check", { clause: r.clauseId }))
			: "aggregate";
	})
	.addNode(
		"precedent_check",
		agentNode<S, "riskReports">({
			// 经 Send 进入，输入 = { clause: clauseId 字符串 }
			task: "结合案卷材料核查条款 {clause} 的引用是否准确",
			schema: RiskReportList,
			writeTo: "riskReports",
			tools: ["read", "grep"],
			executor: mock ? mockAgentExecutor : "sdk",
			timeoutMs: 600_000,
		}),
	)
	.addEdge("review", "gate") // 多实例 → gate 普通触发去重，只跑一次
	.addEdge("precedent_check", "aggregate") // 同上，aggregate 只跑一次
	.addNode(
		"aggregate",
		llmNode<S, "finalReport">({
			prompt: "汇总以下风险报告，生成审查报告：\n{riskReports}", // 非字符串值按 JSON.stringify 插值
			// 产出 JSON 字符串本身（JSON.parse 后就是 string），writeTo 原样成为
			// finalReport（无 reducer，last-value 覆盖；仅 aggregate 写一次）
			schema: T.String(),
			writeTo: "finalReport",
		}),
	)
	.addEdge("aggregate", END)
	.compile({
		services: mock
			? { complete: mockComplete }
			: // 真实模式：complete 未注入 → 使用 pi-ai 默认实现（optional peer dep，
				// 缺失则 compile 报错）；agent.sdk: {} = 接受全部默认（M4 sdk 适配器路径）
				{ agent: { sdk: {} } },
	});

// ---------------------------------------------------------------------------
// 运行（§4.4 run 选项）与结果展示
// ---------------------------------------------------------------------------

const onEvent = (e: RunEvent): void => {
	switch (e.type) {
		case "node_started":
			console.log(`  [S${e.superstep}] ${e.instanceId} (${e.kind}) → start`);
			break;
		case "node_finished": {
			// node_finished 事件不带 kind（只有 node_started 有）
			const tokens =
				e.usage === undefined ? "" : `, tokens ${e.usage.totalTokens}`;
			console.log(`  [S${e.superstep}] ${e.instanceId} <- done${tokens}`);
			break;
		}
		case "node_failed":
			console.log(`  [S${e.superstep}] ${e.instanceId} FAILED: ${e.error}`);
			break;
		case "run_finished":
			console.log(`  run ${e.status} in ${e.durationMs} ms`);
			break;
		default:
			break;
	}
};

try {
	console.log("pi-workflow contract-review example (design §4.1)");
	console.log(
		`  mode: ${mock ? "mock (offline; set PI_WORKFLOW_EXAMPLE_MOCK=0 for real pi)" : "real (pi sdk / pi-ai default)"}`,
	);
	console.log(`  input: ${contractPath}`);
	console.log(`  run log: ${logDir}/<timestamp>-<runId>/run.jsonl\n`);

	const { state, runId } = await app.run(
		{
			path: contractPath,
			contractText: "",
			clauses: [],
			riskReports: [],
			finalReport: "",
		},
		{
			recursionLimit: 25,
			maxConcurrency: 8,
			maxInstancesPerSuperstep: 1000,
			logDir,
			onEvent,
		},
	);

	console.log(`\nrunId: ${runId}`);
	console.log(
		`\nriskReports (${state.riskReports.length} entries, incl. precedent_check):`,
	);
	for (const r of state.riskReports) {
		console.log(`  [${r.severity}] ${r.clauseId}: ${r.risks.join("；")}`);
	}
	console.log(`\nfinalReport:\n${state.finalReport}`);
} catch (error) {
	console.error("\nrun failed:", error);
	process.exitCode = 1;
}
