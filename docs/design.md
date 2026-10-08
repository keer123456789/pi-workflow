# pi-workflow 设计文档（v0.2）

| | |
|---|---|
| 状态 | 已评审（内部评审 + Codex 外部评审，阻塞项已合入），待最终确认 |
| 日期 | 2026-10-07 |
| 目标版本 | v0.1（M0–M5，见 §13） |
| v0.2 变更 | 依评审重写执行语义（扇入去重 / router 求值次数 / seq 全序 / 实例预算）；修复 §5 示例；定义依赖注入点与公开类型；Send 输入类型化；里程碑增加 M0 spike；新增 langgraph 差异清单 |

---

## 1. 背景与目标

### 背景

法律 AI 工作台中有大量**步骤固定**的任务：文书写作、合同审查、制度审查等。当前做法（pi + skill，全靠模型自由发挥）存在两个问题：

1. 控制流不可控——模型可能跳步、合并步骤、遗漏环节；
2. 中间产物无结构——下一步拿到的往往是自由文本，难以可靠衔接。

### 目标

在 pi 框架生态下提供一个 **npm 可安装的确定性编排库**，语义取 langgraph 的一个精选子集：

- 用**代码构图**（非 YAML/JSON），控制流由代码持有，LLM 只负责内容生成；
- v1 支持两个核心编排能力：**条件边**（含回边成环）与 **Send 式动态并发扇出**；
- 节点分三类：纯函数 / 一次性 LLM 补全 / pi agent，按需选用、成本分层；
- 全自动执行 + run 日志事后复核。

### 非目标（v1 明确不做）

- YAML/JSON 声明式动态图（推迟到后续版本）；
- 人工审批节点（interrupt / approval gate）；
- 断点续跑 / checkpoint 恢复（run 日志先行落地，为 v2 打底）；
- 沙箱、工具白名单、路径/网络 allowlist 等防模型硬约束层（自用工作台场景暂不需要，需要时参考 forge 的 `pi-extension-workflows` 补建）。注意：`agentNode` 的 `tools` 参数是**能力选择**（让 agent 能用什么工具完成任务），**不是安全边界**；
- 图的运行时改写（图在 compile 后不可变，见 §6）。

### 与参考项目的关系

| 来源 | 借鉴 |
|---|---|
| langgraph | StateGraph / channel+reducer / conditional edges / Send / recursionLimit / 超步内普通触发去重 的语义模型 |
| [mavam/pi-agents](https://github.com/mavam/pi-agents) | "启动前全量校验，坏图不 spawn"；子进程委派模式；预算护栏思想 |
| [forge 的 pi-extension-workflows](https://github.com/Firstp1ck/pi-coding-agent-forge) | "编排逻辑在代码里，LLM 只填 prompt"的定位；瞬态失败分类重试；子进程 JSON 事件流解析；超时杀进程策略 |

**教训吸取**：forge 曾对"模型生成的编排"做静态硬拦截而误杀合法流程后回退。本库的图全部由**人用代码编写**，compile 期硬校验是合理的；我们不校验模型行为，只校验图结构与运行期不变量。

---

## 2. 设计原则

1. **控制流在代码里**。图、边、路由都是纯代码；模型在节点内部只做内容生成，永远不做流程决策。
2. **坏图在 spawn 之前失败**。`compile()` 一次性收集所有结构错误并报告，不带病运行。
3. **并发写冲突显式化**。多个节点实例并发写同一个无 reducer 的 state key 是错误，不是静默覆盖。
4. **确定性可复现**。同图 + 同初始状态，两次 run 的状态轨迹（含合并顺序）完全一致；为达此目的引入全局 `seq` 全序（§5.2），测试可注入 clock/sleep/rng。
5. **core 零 pi 依赖、零 I/O**。引擎不 import 任何 `@earendil-works/*` 包；pi 通过适配器接入，适配器可整体替换。
6. **成本分层**。能用 `fn` 的不用 `llm`，能用 `llm` 的不起 `agent`。

---

## 3. 核心概念

| 概念 | 说明 |
|---|---|
| **State** | 一个 TypeScript 对象，贯穿整个 run。每个 key 是一个 **channel**。 |
| **Channel / Reducer** | 每个 key 可声明 reducer `(current, update) => next`；未声明的 key 默认 last-value 覆盖。标准 reducer 集合由库导出（§4.5）。 |
| **Node** | 图的执行单元，三类：`fn` / `llm` / `agent`。节点接收**只读输入**，返回 `Partial<State>`。 |
| **Instance（实例）** | 节点的一次待执行。普通触发（边/字符串路由）**按节点名去重**——同一超步内同一节点至多一个普通实例；Send 实例不去重。每个实例创建时分配全局自增 `seq`。 |
| **Edge** | 普通边：源节点所在超步完成后，全部目标被激活（经去重）。 |
| **Conditional Edge** | 路由函数，**每个节点每个超步求值一次**，读合并后 state，返回目标节点名 / `Send` / `END`。纯函数、确定性。 |
| **Send** | 动态扇出：`new Send(nodeName, input)` 为目标节点创建一个不去重的实例，实例的输入是 `input` 本身。 |
| **Superstep** | 执行以超步（Pregel BSP）推进：当前批实例并发跑完 → 按 seq 提交合并 → 每节点求值一次 router → 生成下一批。 |
| **Run** | 一次图执行，有 runId，产出 JSONL 事件日志。 |

与 langgraph 的概念映射：`StateGraph`→同名、node→同名、conditional edges→`addConditionalEdges`、`Send`→同名、`recursion_limit`→`recursionLimit`、checkpoint→v2。**全部已知语义偏差集中列在 §12，langgraph 使用者先读那张表。**

---

## 4. API 设计

### 4.1 完整示例：合同审查

数据流（正确扇出/扇入形态）：

```
                ┌─ Send(review, {clause=c1}) ─┐
START→load_doc→extract(抽条款)─ Send(review, {clause=c2}) ─┤→ gate(风险分级路由)─┬─ Send(precedent_check,{clause})─┐
                └─ Send(review, {clause=cN}) ─┘         │                     └─(无高风险)→ aggregate ←──┘
                                                        └── review/precedent_check 写回 riskReports，经普通边汇入 aggregate（去重，只跑一次）
```

```ts
import { StateGraph, Send, START, END, fnNode, llmNode, agentNode, append } from "pi-workflow";
import { Type as T, Value, type Static } from "typebox";
// 注：typebox 1.3.36 实测根导出为 `Type`（非 `T`），`Value` 在 `typebox/value` 子路径——
// 若上式报错，用：`import { Type as T, type Static } from "typebox"; import { Value } from "typebox/value";`

const ClauseList = T.Object({ clauses: T.Array(T.Object({ id: T.String(), text: T.String() })) });
const RiskReport = T.Object({ clauseId: T.String(), risks: T.Array(T.String()),
                              severity: T.Union([T.Literal("high"), T.Literal("medium"), T.Literal("low")]) });

type S = {
  path: string;
  contractText: string;
  clauses: Static<typeof ClauseList>["clauses"];  // append
  riskReports: Static<typeof RiskReport>[];       // append
  finalReport: string;
};

const app = new StateGraph<S>({
    name: "contract-review",                       // 用于日志标识
    channels: { clauses: append, riskReports: append },
  })
  .addNode("load_doc", fnNode<{ path: string }, string>(   // 输入类型 = 初始 state 的形状子集
    async (s, ctx) => ({ contractText: await readContract(s.path, ctx.signal) })))
  .addNode("extract", llmNode({
    prompt: "从以下合同中抽取全部条款，输出 JSON：\n{contractText}",
    schema: ClauseList,
    writeTo: "clauses",
  }))
  // 注意：extract 到 review 没有普通边！扇出完全由 extract 的 router 驱动
  .addConditionalEdges("extract", (s) =>
    s.clauses.map(c => new Send("review", { clause: c })))
  .addNode("review", llmNode({                     // 经 Send 进入，输入 = { clause }
    prompt: "审查条款 {clause} 的法律风险，输出 JSON",
    schema: RiskReport,
    writeTo: "riskReports",
    retry: { maxAttempts: 3 },
  }))
  .addNode("gate", fnNode(() => ({})))             // 纯路由节点：扇入汇聚点，无副作用
  .addConditionalEdges("gate", (s) => {
    const high = s.riskReports.filter(r => r.severity === "high");
    return high.length > 0
      ? high.map(r => new Send("precedent_check", { clause: r.clauseId }))
      : "aggregate";
  })
  .addNode("precedent_check", agentNode({          // 经 Send 进入，输入 = { clause }
    task: "结合案卷材料核查条款 {clause} 的引用是否准确",
    schema: RiskReport,
    writeTo: "riskReports",
    tools: ["read", "grep"],
    executor: "subprocess",
    timeoutMs: 600_000,
  }))
  .addEdge("review", "gate")                       // 多实例 → gate 普通触发去重，只跑一次
  .addEdge("precedent_check", "aggregate")         // 同上，aggregate 只跑一次
  .addNode("aggregate", llmNode({
    prompt: "汇总以下风险报告，生成审查报告：\n{riskReports}",  // 非字符串值按 JSON.stringify 插值
    writeTo: "finalReport",
  }))
  .addEdge("aggregate", END)
  .compile({
    services: {
      agent: { subprocess: { bin: "pi", defaultModel: "..." } },
      // complete 未注入 → 使用 pi-ai 默认实现（optional peer dep，缺失则 compile 报错）
    },
  });

const { state, runId } = await app.run(
  { path: "contract.pdf.txt", contractText: "", clauses: [], riskReports: [], finalReport: "" },
  { recursionLimit: 25, maxConcurrency: 8, maxInstancesPerSuperstep: 1000,
    onEvent: e => ui.showProgress(e) },
);
```

执行轨迹对照：S0 `load_doc` → S1 `extract` → S2 K 个 `review` 实例（Send 不去重）→ S3 M 个 `precedent_check` + `gate`（普通触发去重）→ S4 `aggregate`（`gate` 字符串路由或 `precedent_check` 普通边，二者互斥，去重后恰好一次）。

### 4.2 构造器签名

```ts
type Reducer<V> = (current: V, update: V) => V;
type StateSchema<S> = Partial<{ [K in keyof S]: Reducer<S[K]> }>;

class StateGraph<S extends object> {
  constructor(cfg?: { name?: string; channels?: StateSchema<S>; stateSchema?: T.TSchema });
  // stateSchema 可选：提供则对初始 state、节点返回 key 做运行期校验（typebox 已是依赖）
  addNode<I = S>(name: string, node: NodeDefinition<S, I>): this;
  addEdge(from: typeof START | string, to: typeof END | string): this;
  addConditionalEdges<I = S>(from: string, router: Router<S, I>): this;
  compile(opts?: CompileOptions): CompiledGraph<S>;   // 之后图不可变（见 §6）
}

type RouterResult = typeof END | string | Send | (typeof END | string | Send)[];
// null / undefined 视为 END（合法，语义同 END）
type Router<S, I = unknown> = (state: S, lastUpdate: Partial<S>) => RouterResult;
// lastUpdate = 该源节点本超步全部实例写入、按 key fold 后的结果（未写任何 key 时为 {}）。
// 用途：循环场景下只对"本次新写入"做扇出，避免读累积 state 导致重复扇出。

class Send<I = unknown> {
  constructor(node: string, input: I);
}
```

约束：

- 每个 node 至多注册**一个** router（多路条件用返回数组表达）；重复注册在 add 时即抛错；
- 普通边与条件边可共存于同一节点，二者都生效（langgraph 同款）；
- 节点名唯一；`"START"` / `"END"` 字面量不许作为节点名（内部保留名 `__start__` / `__end__`）；
- router 返回的数组中重复的字符串节点名按去重规则处理（§5.4）。

### 4.3 节点工厂

```ts
type NodeContext = {
  runId: string;
  superstep: number;
  instanceId: string;      // = `${node}#${seq}`
  seq: number;             // 全局序，与日志、合并顺序一致
  signal: AbortSignal;     // 实例信号（见 §7.4）：run 取消/兄弟失败时触发；节点必须尊重
  reportUsage?: (usage: TokenUsage) => void;   // M2/D11：引擎总是提供；按 attempt 记录，成功尝试的用量挂 node_finished.usage
};

type NodeDefinition<S, I = S> = {
  kind: "fn" | "llm" | "agent";
  name: string;
  handler: (input: Readonly<I>, ctx: NodeContext) => Promise<Partial<S>> | Partial<S>;
  inputType?: T.TSchema;   // 可选：运行期校验进入本节点的输入（Send 路径尤其需要）
  writeTo?: keyof S;       // llm/agent：产出写入的 key（经该 key 的 reducer）
  complete?: CompleteFn;   // M2/D12：仅 kind === "llm" 合法（其他 kind 声明 → compile 期 issue）
  retry?: { maxAttempts: number };   // 仅 llm/agent；fnNode 不提供此参数
  timeoutMs?: number;
};

function fnNode<S, I = S>(handler: NodeHandler<S, I>, opts?: { timeoutMs?: number }): NodeDefinition<S, I>;
// 注意签名差异：fn 的主体是 handler 本身（最常见形态），llm/agent 是配置对象。文档显式说明这一不一致的理由。

function llmNode<S, K extends keyof S & string>(cfg: {
  prompt: string | ((input: any) => string);     // 字符串模板做 {key} 插值，规范见 §5.6
  schema: T.TSchema;                             // 必填：产出必须为合法 JSON
  writeTo: K;                                    // 泛型关联：Static<typeof schema> 须可赋给 S[K]（类型层面约束）
  model?: string;
  complete?: CompleteFn;                         // 注入自定义补全（网关/OpenAI 兼容接口）
  retry?: { maxAttempts: number };
  timeoutMs?: number;                            // 默认 120_000
}): NodeDefinition<S>;

function agentNode<S, K extends keyof S & string>(cfg: {
  task: string | ((input: any) => string);
  schema?: T.TSchema;                            // 缺省时产出为最终 assistant 文本字符串
  writeTo: K;
  tools?: string[];                              // 能力选择，不是安全边界（见 §1）
  model?: string;
  executor: "subprocess" | "sdk" | AgentExecutor;
  retry?: { maxAttempts: number };
  timeoutMs?: number;                            // 默认 600_000
}): NodeDefinition<S>;
```

> M2 补充（D11/D12）：`NodeContext.reportUsage` 由引擎**总是提供**——按 attempt 记录、成功尝试的用量挂 `node_finished.usage`（失败/重试的尝试不产生 usage）。`NodeDefinition.complete` 是 **llm 专用**：只有 `kind === "llm"` 的定义可以声明（其他 kind 声明 → compile 期 issue）；compile 解析顺序 `def.complete ?? services.complete ?? pi-ai 默认（可用时）`，全缺 → compile 报"has no completion implementation"的 issue（§9.4）。

### 4.4 执行入口

```ts
const { state, runId } = await app.run(initialState, {
  recursionLimit?: number;            // 默认 25；超步数上限，超过抛 GraphRecursionError
  maxConcurrency?: number;            // 默认 8；同超步实例的 I/O 并发上限
  maxInstancesPerSuperstep?: number;  // 默认 1000；单超步实例数硬上限，超过抛 InstanceBudgetError
  maxTotalInstances?: number;         // 默认 10000；整次 run 实例总数硬上限
  runTimeoutMs?: number;              // 默认无；run 级超时
  signal?: AbortSignal;               // 外部取消（工作台"停止"按钮）
  onEvent?: (e: RunEvent) => void;    // 实时事件流；顺序保证见 §8.1
  logDir?: string;                    // 默认 PI_WORKFLOW_LOG_DIR ?? ".pi-workflow/runs"（§8/D2）
  logOutputs?: "full" | "hash";       // 默认 "full"；"hash" 时 input/output 只记 SHA-256（§8.1/D7）
  onLogError?: "fail" | "warn";       // 默认 "fail"（法律审计场景日志不可静默丢失）——日志写失败使 run 拒绝（§8.1/D8）
});
// run()/invoke() 返回 RunHandle<S> = Promise<{ state, runId }> & { cancel(): void }：
// 对运行中的 handle 调 cancel() 即中止本次 run（abort run signal，§7.4 的 run 级取消），
// 幂等且 run 已 settle 后是 no-op；拒绝体是 WorkflowError("run cancelled")。
// 已经 abort 的 signal 传入时**先于初始 state 校验**拒绝（一个事件都不发）——刻意的顺序：
// 取消是调用方更强的意图表达，调用方不要把它误读成 GraphValidationError。
// 也有 langgraph 风格的 invoke() 别名——但注意 invoke() 返回 { state, runId } 而非裸 state，差异见 §12。
```

> 日志**默认开启**（D2）：不配置也写 `<logDir || PI_WORKFLOW_LOG_DIR || ".pi-workflow/runs">/<YYYYMMDDTHHmmssSSSZ>-<runId>/run.jsonl`（空串视同未配置）。关闭 = `services.logger: {}`（钩子全可选，空对象即全静默）；自定义实现 = `services.logger !== undefined`（原样使用）。注意 `onLogError` 默认 `"fail"`：默认目录不可写时每次 run 都以 `WorkflowError("run log write failed: …")` 拒绝（审计优先，刻意）；放宽用 `"warn"` 或关闭日志。

### 4.5 标准 reducer（库导出）

| reducer | 语义 |
|---|---|
| `overwrite` | 默认。后写覆盖。 |
| `append` | 数组拼接；current 非数组或 update 非数组时抛 `InvalidWriteError`。 |
| `concat` | 字符串拼接。 |
| `setOnce` | 第二次写入抛 `InvalidWriteError`（用于"只能被写一次"的最终产物）。 |

### 4.6 依赖注入点（CompileOptions）

适配器与外部效应统一在 **compile 期**注入；run 期只做执行控制（§4.4）。

```ts
type CompileOptions = {
  name?: string;                          // 覆盖 StateGraph 的 name
  services?: {
    agent?: {
      subprocess?: PiSubprocessConfig;    // executor:"subprocess" 的二级配置
      sdk?: PiSdkConfig;                  // executor:"sdk" 的二级配置
    };
    complete?: CompleteFn;                // llm 节点默认补全实现（§9.1）；缺省用 pi-ai 适配器
    logger?: RunLogger;                   // run 日志（§8，默认开启）：!== undefined 即原样使用，{} = 全静默（D2/R2）
    clock?: () => number;                 // 可注入时钟/睡眠/随机——重试退避可测试
    sleep?: (ms: number) => Promise<void>; // 契约不变；默认实现额外带非枚举 cancel()（R20）——
                                           // 引擎只做能力探测：竞速结束/run 结束时清掉已不再等待的
                                           // 定时器。等待期间保持 ref'd（退避是进度等待，不得 unref）
    random?: () => number;
  };
};

type PiSubprocessConfig = {
  bin?: string;             // 默认 "pi"（PATH 解析；Windows 下处理 .cmd shim）
  cwd?: string;             // 子进程工作目录，默认宿主 cwd
  env?: NodeJS.ProcessEnv;  // 额外环境变量（认证沿用 ~/.pi，无需配置）
  extraArgs?: string[];
  defaultModel?: string;
};
type PiSdkConfig = { defaultModel?: string; /* M4 细化 */ };
```

节点声明 `executor: "subprocess"` 但 `services.agent.subprocess` 未配置 → **compile 期报错**（依赖缺失尽早暴露）。`executor` 也可直接传自定义 `AgentExecutor` 函数。

---

## 5. 执行语义

### 5.1 超步算法

```
seq = 0
pending = [START 的直接后继（普通触发，按节点名去重，input = initialState），seq 递增]
for step in 0..:
  if pending 为空: 正常结束
  if step >= recursionLimit: throw GraphRecursionError
  if |pending| > maxInstancesPerSuperstep: throw InstanceBudgetError
  if 累计实例数 > maxTotalInstances: throw InstanceBudgetError
  results = 并发执行 pending 全部实例（I/O 并发，maxConcurrency 封顶；
            每实例输入 = 本超步开始时确定的只读快照）
  if 任一实例重试耗尽后失败:
    throw NodeExecutionError {根因节点, 被连带取消的实例列表, 日志路径, 摘要}
    （本超步写入不提交——超步原子性）
  # —— 提交：按实例 seq 升序（§5.2）——
  for (inst, partial) in results（seq 升序）:
    for (key, val) in partial（key 升序，稳定序）:
      channel[key] 有 reducer ? fold(val)
      : 该 key 本超步已被写过 ? throw InvalidWriteError（列出冲突节点）
      : 写入
  emit superstep_committed {step}
  # —— 生成下一批 ——
  activated: Map<nodeName, Instance> = {}    # 普通触发去重表
  routed: Set<nodeName> = {}
  for inst in results（seq 升序）:
    for target in plainEdges(inst.node) where target ≠ END:
      if target ∉ activated: activated[target] = Instance(seq++, target, input = 合并后 state)
  for inst in results（按其节点最早完成的实例 seq 排序）:
    if inst.node ∉ routed 且 router(inst.node) 存在:
      routed.add(inst.node)                  # 每节点每超步只求值一次
      r = router(合并后 state, lastUpdate(inst.node))
      for item in r:
        string t  → if t ∉ activated: activated[t] = Instance(seq++, t, input = state)
        Send      → 追加 Send 实例（不去重，input = send.input）
        END/null  → 该分支终止（继续处理数组其余项）
  pending = activated 的实例 + Send 实例（按 seq 升序）
```

要点：

- **实例输入是快照**：普通触发实例读合并后 state 的只读快照；Send 实例读 `send.input`。修改输入属未定义行为，开发模式（`NODE_ENV !== "production"`）下对输入做 `Object.freeze` 深冻结以便尽早暴露。
- **BSP 隔离**：本超步实例互相看不到对方的写入。
- **Send 写回**：Send 实例的返回值经**目标节点的 `writeTo` key** 的 reducer 汇入全局 state。

### 5.2 全序与确定性：`seq`

- 每个实例创建时分配**全局单调自增 `seq`**，贯穿：状态合并顺序、router 求值顺序、日志字段、（v2）重放顺序；
- 合并按 seq 升序折叠，与实例完成时序无关——**并发完成顺序不影响最终状态**；
- 确定性验收：同图 + 同初始状态跑两次，状态轨迹（每超步的 channel 内容与合并序）逐位一致（§13 M1 验收）。

### 5.3 Send 语义与预算

- `new Send(node, input)` 创建目标节点一个实例，**不去重**；实例输入 = `input` 本身；
- 实例返回值经目标 `writeTo` key 的 reducer 汇入全局 state；
- Send 允许运行时按数据规模动态决定扇出数量（map-reduce）；
- **Send 不设"天然上限"，受三重预算硬约束**：`maxInstancesPerSuperstep`（单超步）、`maxTotalInstances`（整 run）、`maxConcurrency`（并发）。仅靠 `recursionLimit` 兜底是错误的——它只约束超步数，一个返回 10 万个 Send 的 router 仍是一个超步。

### 5.4 触发与去重规则

| 触发来源 | 是否去重 | 规则 |
|---|---|---|
| 普通边 | **是** | 同一超步内，同一目标节点名只保留最早 seq 的一个实例 |
| router 返回字符串 | **是** | 同上（数组中重复节点名合并为一个） |
| router 返回 Send | **否** | 每个 Send 都是一个实例 |
| router 返回数组 | 逐项处理 | 字符串项去重合并；Send 项不去重 |
| router 返回 `null`/`undefined`/空数组 | — | 等价 END，该分支终止 |

理由（与 langgraph 对齐）：普通边表达"数据汇合后的下一步"，多路汇入只该执行一次；Send 表达"按数据逐份处理"，每份都必须执行。重复节点名 `["a","a"]` 按普通触发处理：去重。

### 5.5 循环与终止

- 回边天然允许：router 返回靠前的节点名即成环；
- 终止条件：pending 为空（正常）/ 到达 `END` / `recursionLimit` 超限抛 `GraphRecursionError` / 预算超限抛 `InstanceBudgetError`；
- **环内必须有使状态收敛的机制**（使用者责任，引擎不校验；`recursionLimit` 与实例预算是最后防线）；
- 循环扇出防重复工具：router 的 `lastUpdate` 参数——只对本次超步新写入的数据扇出，避免读累积 state 重复扇出（§4.2）。

### 5.6 模板插值规范（llm/agent 的 prompt/task）

- `{key}` 从**实例输入**解析；嵌套路径支持 `{a.b.c}`；
- key 缺失 → 抛 `TemplateError`（**不静默 undefined**——这是"意外"的常见来源）；
- 非字符串值 → `JSON.stringify`（如 `{riskReports}` 数组）；
- `{{` / `}}` 转义为字面花括号；
- 插值只作用于**用户模板**；schema 约束指令文本在插值**之后**拼接，不参与插值（其内容含花括号也不会被吃掉）。

---

## 6. compile 期校验（全量收集，一次报完；compile 后图不可变）

1. 节点名唯一；边/router 引用的节点必须已注册；"START"/"END" 不许作节点名；边端点的哨兵位置：START 只能作起点、END 只能作终点（addEdge(END,x) / addEdge(x,START) / addEdge(START,START) 均报错，R23）；router 的源不能是 START（START 的 router 在 M1 不被求值，直接报错，R22）或 END（按未注册处理）；
2. `START` 必须有出边；从 `START` 出发所有节点可达（不可达 = 警告）；
3. 无出边且无 router 的节点视为终态（警告提示显式连 `END`）；
4. 重复 `addEdge(from,to)`、重复 `addConditionalEdges(from)`、对同一节点的重复 `addNode` → 即时抛错；
5. `writeTo` 的 key 必须存在于 State；llm/agent 节点必须提供 `writeTo`；schema 必须合法（typebox 对象本身即 JSON Schema）；"__proto__" 不得作为 channel key 或 writeTo（原型污染防护，R24）
6. `executor` 声明的适配器必须在 `services` 中已配置（§4.6）；`complete` 缺失且 pi-ai 未安装 → 报错；
7. `stateSchema` 若提供：校验其自身合法性；初始 state 校验在 `run()` 开始时做（初始 state 必须通过 `stateSchema`，节点返回含未知 key 抛 `InvalidWriteError`）；
8. compile 之后再调用 `addNode/addEdge/addConditionalEdges` → 抛 `GraphSealedError`（"compile 后不可变"由代码强制）；
9. 静态并发写检测（尽力而为）：同一节点的多个固定后继写同一个无 reducer key → 警告（Send 扇出的冲突只能运行期兜底，见 §5.1 提交规则）。

---

## 7. 错误处理与重试

### 7.1 失败语义

- 默认 **fail-fast**：节点重试耗尽后 run 失败；同超步其余实例经实例信号取消；
- `NodeExecutionError` 携带：根因节点与 instanceId、根因 error、**被连带取消的实例列表**、日志路径与摘要（不内联全部事件——大 run 下体积失控且与 JSONL 重复）；
- `fn` 节点不自动重试（代码错误重试无意义），`fnNode` 的 opts 中**没有** `retry` 参数。

### 7.2 瞬态错误重试（llm / agent 节点）

- 分类标准沿用 forge 的正则族：429 / 408 / 5xx / rate limit / timeout / ECONNRESET / socket hang up；llm 输出不符合 schema 同样可重试（同 prompt 重发）；
- `retry.maxAttempts`：**总尝试次数**（含首次），默认 1（不重试）；
- 退避：指数 base 500ms，上限 30s，full jitter（`sleep(min(base * 2^已重试次数 * random(), 30s))`，**指数用已重试次数，0 起**——首次重试的基数即 base 500ms；上限截断）；`clock` / `sleep` / `random` 均可注入（§4.6），重试时序可测试；
- （分类落地于 M2（D3）：判定 = 内部可重试标记（`markRetryable()`，非枚举 Symbol；llm 的 schema/JSON 失败用它）或消息正则 `/(?:^|\D)(?:429|408|5\d\d)(?:\D|$)|rate[ -]?limit|too many requests|timeout|timed out|ECONNRESET|socket hang ?up/i`，或 `error.code === "ECONNRESET"`；**不可重试错误立即失败**——不退避、不发 `node_retry`，`maxAttempts` 仍是总尝试次数上限。引擎自身 attempt 超时消息含 "timed out" → 天然可重试）

### 7.3 超时

- 默认：agent 节点 600s，llm 节点 120s，fn 节点无限制；
- **Windows 杀进程**：无优雅 SIGTERM 可用，M3 采用 `taskkill /T /F`（进程树）或 Job Object 方案，M0 spike 验证（§13）；
- run 级：`runTimeoutMs`（§4.4）。

### 7.4 取消信号层级

| 信号 | 触发条件 | 用途 |
|---|---|---|
| run signal | 调用方 `signal` 触发 / `run.cancel()` / `runTimeoutMs` 到期 | 取消一切 |
| instance signal | run signal 透传，**或同超步任一兄弟实例失败** | 节点应尽快退出；不因自身重试触发 |
| attempt signal | 从 instance signal 派生，每次重试新建 | 单次尝试的超时控制；本尝试失败不影响后续尝试 |

约定：**所有节点（含 fn）必须尊重 `ctx.signal`**（长循环里周期性检查）；引擎无法抢占不检查信号的 fn，文档显式说明。fn 的 `timeoutMs` 到期只能触发信号，靠节点自身响应——引擎只保证自己不再等它：超时的尝试按"handler settle vs 计时器"竞速判定，超时分支胜出即判失败（可重试），被放弃的 handler 若仍在跑属于节点自身失控，其 promise 已被引擎接管（reject 不会变成 unhandled rejection）。
节点收到 abort 后**应当**以 AbortError（或直接 reject `ctx.signal.reason`）退出，但引擎**不再依赖错误的形状**（R20a）：实例信号已取消时，任何尝试失败都归"被取消"（进 `collateral`，不重试、不参与根因选举）——被取消的节点 reject `ECONNRESET`、客户端 `CanceledError` 这类真实瞬态错误同样如此。

### 7.5 运行期路由错误

- router 返回未知节点名 / `START` / 指向 `END` 的 Send / 抛异常 → 抛 `RouterError`（与 compile 期的 `GraphValidationError` 区分）。

---

## 8. Run 日志（事后复核）

### 8.1 事件与存储

**启用日志的 run** 每次写一个 JSONL 文件：`<logDir || PI_WORKFLOW_LOG_DIR || ".pi-workflow/runs">/<YYYYMMDDTHHmmssSSSZ>-<runId>/run.jsonl`（**目录名不含冒号**，Windows 合法；空串视同未配置）：

```jsonl
{"ts":"...","seq":1,"type":"run_started","runId":"...","graph":"contract-review","superstep":0,"input":{...}}
{"ts":"...","seq":3,"type":"node_started","runId":"...","superstep":2,"node":"review","instanceId":"review#7","kind":"llm"}
{"ts":"...","seq":8,"superstep":2,"type":"node_retry","runId":"...","node":"review","instanceId":"review#7","attempt":1,"error":"429 rate limit"}
{"ts":"...","seq":9,"type":"node_finished","runId":"...","superstep":2,"node":"review","instanceId":"review#7","output":{...},"usage":{"input":1000,"output":234,"cacheRead":0,"cacheWrite":0,"totalTokens":1234},"durationMs":4200}
{"ts":"...","seq":12,"type":"superstep_committed","runId":"...","superstep":2}
{"ts":"...","type":"run_finished","runId":"...","status":"completed|failed","durationMs":...}
```

- **所有事件带 `seq` 与 `superstep`**；seq 从 1 起单调递增；**committed 语义 = 边界事件方案（D10）**：逐事件打标 `committed:false` 不可实现（事件实时按完成序发出，不缓冲不重排），某超步是否提交看它的事件之后跟随的边界事件——`superstep_committed`（已提交）/ `superstep_aborted`（未提交，含失败超步），消费方按最近边界判定；事件溯源重放（v2）只重放 committed 超步；
- **文件布局（D9）**：每行一个 JSON 事件（与 `onEvent` 同序 = 完成序），行尾 `\n`、同步 append；文件至少含 `run_started` … `run_finished`；
- `node_retry`（每次重试前一条）字段 = 样例的 `node` / `instanceId` / `attempt` / `error`；`attempt` 是**刚失败的那次尝试**编号（1 起），`error` 是失败错误的消息文本；只在"重试确实会发生"时发出（实例已取消就不发，R20a）；`node_finished.durationMs` 是**实例墙钟时长**，含重试与退避（不是最后一次尝试的耗时）；
- `node_finished.usage?`（D11）：成功尝试经 `ctx.reportUsage` 上报的用量（按 attempt 取末次）；未上报时字段缺省，失败/重试的尝试不产生 usage——complete 已返回 usage 但输出未过 schema 校验的尝试同待遇，实际消耗按补全适配器侧计，不依赖 `node_finished.usage`；
- 事件同时经 `onEvent` 实时发出：**顺序保证 = 完成序（实时性优先）**，字段 `seq` 供需要全序的消费者（重放、审计）重排；
- **脱敏（`logOutputs: "hash"`，D7）**：`run_started.input`、`node_finished.output` 两字段替换为字符串 `"sha256:<64位hex>"`（`sha256(JSON.stringify(value))`；stringify 抛错时对 `"[unserializable]"` 取哈希）——**onEvent 与日志文件两路都拿脱敏后的事件**（避免全文经回调泄露，法律文书敏感）；
- **日志写失败（D8）**：默认 `onLogError: "fail"`——logger 任一钩子抛错使 run 以 `WorkflowError("run log write failed: <原因>")` 拒绝、`cause` 附原错，含收尾阶段（`run_finished` 已发后 `onRunFinish` 抛错同样拒绝；审计要求）；`"warn"` 的确切降级行为 = `console.warn("pi-workflow: run log write failed: <原因>")` 并继续；**预检失败**（初始 state 校验 / 已 abort 的 signal）的 run 不创建日志；full 模式下不可序列化 payload（循环引用 / BigInt 等）属日志写失败，按 onLogError 策略处置；hash 模式对其有 "[unserializable]" 哈希兜底（D7）。
- 日志是 v2 断点续跑的数据基础（事件溯源 + seq 重放）。

---

## 9. pi 适配层

### 9.1 接口

```ts
type AgentExecutor = (req: {
  task: string;
  tools?: string[];
  model?: string;
  schema?: T.TSchema;
  signal: AbortSignal;        // attempt 级信号
  timeoutMs: number;
  runId: string; instanceId: string;   // 供适配器写子进程日志/关联
}) => Promise<{ output: string; usage?: TokenUsage }>;

type CompleteFn = (req: {
  prompt: string;
  model?: string;
  schema?: T.TSchema;
  signal: AbortSignal;
  timeoutMs: number;          // 与 llm 节点默认 120s 对称
}) => Promise<{ text: string; usage?: TokenUsage }>;
```

core 只认识这两个接口。`executor: "subprocess" | "sdk"` 是语法糖，等价于按 `services` 配置构造对应实现（§4.6）。

### 9.2 subprocess 适配器（M3，协议由 M0 spike 验证后冻结）

> 协议细节以《docs/runtime-protocol.md》为准（M0 spike 实测冻结）。以下为适配器实现要点。

- 命令：`pi --mode json -p --no-session [--model M] [--tools a,b,c]`，task 文本优先走 **stdin**（Windows argv 上限 ~32k，合同全文走 argv 不可靠；stdin 不可行则落临时文件）；**M0 实测补充**：stdin 是"读到 EOF 为止"——spawn 时**必须关闭 stdin**（`stdio:"ignore"` 或写完即 `end()`），保持打开不关会令 pi 无限期阻塞；stdin 与 argv 同时给会**无分隔符拼接**，适配器二者只取其一；
- **临时文件生命周期**（法律文书敏感）：写入 `os.tmpdir()` 下本次 run 专属子目录，`finally` 中删除，失败时保留并在日志记录路径；不设额外权限位（继承用户默认）；M3 裁定（D17）：stdin 是唯一 task 通道（M0 ③.3 实测 40k 逐字节可靠），临时文件回退分支不实现——验收行"临时文件清理"豁免。
- 解析 stdout 逐行 JSON 事件流：**首行为 session header（`type:"session"`，`--no-session` 也输出）需跳过**；累计最终 assistant 文本（`message_end`/`turn_end` 的 assistant `content[].text`，`agent_end.messages` 为权威副本）与 usage（assistant 消息对象内，含 `input/output/cacheRead/cacheWrite/totalTokens/cost`）；**LLM 失败时进程退出码仍为 0（json 模式实测），成败必须依据事件流中 assistant 消息的 `stopReason`（`"error"`/`"aborted"`，后者未实测）与 `errorMessage` 判定；但启动期错误（模型不存在/无凭据）退出码 1、错误只在 stderr，stdout 无事件流（无凭据场景仍有 182B 的 session header 行）——两套判定都要做**；**事件流格式与 pi CLI 版本绑定**：适配器启动时执行 `pi --version` 探测（输出单行裸 semver），仅支持已验证的版本区间，超出区间报明确错误（CLI 版本 ≠ SDK 包版本 1.0.4，二者独立跟踪）；
- schema 产出：task 末尾（插值后）追加"最终输出只包含符合以下 JSON Schema 的 JSON"指令 → 解析（剥栅栏）→ typebox 校验 → 失败按重试策略重发；v2 演进为 pi-agents 式 RPC 结果信封工具；
- Windows spawn：处理 `.cmd` shim（`shell:true` 或 cross-spawn，npm shim 为 `%APPDATA%/npm/{pi,pi.cmd,pi.ps1}`）；杀进程用 `taskkill /PID <spawn 返回的 pid> /T /F`（`/T` 不可省：shell:true 下句柄 PID 是 cmd.exe，pi 本体是其孙进程）（§7.3）；
- 认证沿用 `~/.pi` 已登录凭据；**M0 实测补充（环境差异）**：pi 不读 `ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL`（marker 实测：不可路由 baseUrl 不影响行为），但**读 `ANTHROPIC_AUTH_TOKEN`**（去掉后 `No API key found for the selected model.`，EXIT=1）；企业网关场景（Anthropic 兼容端点）需在 pi agent 目录（可用 `PI_CODING_AGENT_DIR` 重定向）的 `models.json` 配自定义 provider（`baseUrl`+`api`+`apiKey`，值支持 `$ENV` 插值，密钥不落盘）。

### 9.3 sdk 适配器（M4）

- 进程内 `import { ... } from "@earendil-works/pi-coding-agent"`，每个 agent 节点创建独立会话，结束即弃；
- 取消/超时走会话 abort；输出与 schema 处理与 subprocess 相同；
- **M4 裁定（D24）**：成败判定与 subprocess 的 verdictOf **逐类同构**——`prompt()` resolve 后取 `session.messages` 中最后一个 assistant 消息按 `stopReason` 判定：`"stop"` 成功（`content` 中 text 块 join `"\n"` + usage）；`"error"` 抛 `pi agent failed: <errorMessage>`（原文保留，D3 可匹配）；`"aborted"` 抛 `AbortError`；其他值可读失败不猜；`req.schema` 忽略（D22：schema 在 handler 层，适配器回原文）；
- **M4 裁定（D25）**：每节点 `SessionManager.inMemory()` 新会话（不落 session 文件，对齐 CLI `--no-session`），`finally { session.dispose() }` 成功/失败/abort 全路径必达；不做会话复用（§14 开放问题 4 就此关闭）；
- **M4 裁定（D26）**：pi 内置 auto-retry（settings 默认开启，maxRetries 3）**不关闭、不配置**——与 subprocess 路径的 CLI 行为一致；引擎 D3 重试在 pi 内部重试耗尽后才生效，接受二者的**乘法效应**；引擎 `timeoutMs` 仍约束单次尝试总时长（abort 会打断 pi 内部重试）；
- 代价：与 pi SDK 版本强耦合，作为 **optional peerDependency**。

### 9.4 llm 默认实现（M2）

- `@earendil-works/pi-ai`（optional peerDependency，`^1.0.4`）的补全 API（provider 无关）作为 llm 节点的默认 complete；
- **可用性探测**：compile 期 `isPiAiAvailable()`（能解析包即 true，结果进程内缓存、永不抛）；未注入 `complete`、`services.complete` 且探测不可用 → **compile 期报错**（issue："has no completion implementation"）；
- **懒加载单例**：`defaultPiAiComplete()` 取函数不加载，首次调用才动态 import（根 barrel 取 `contentText`、`providers/all` 取 `builtinModels()`）；探测与加载是两个动作，探测通过但加载失败属极端环境问题（失败被记住，错误信息可读并含 cause）；
- **模型串** `"<provider>/<id>"` 按**第一个** `/` 切分（id 可再含 `/`）；缺 `/`、空段、未配置或 `getModel` 未命中 → 可读的作者错误（发请求前抛，不重试）；
- **成败只认助手消息 `stopReason`**：成功白名单 `{stop, length, toolUse}`（`length` 的截断正文照常返回，schema 违规由 llm 节点按可重试失败处理）；`error` → 抛 `pi-ai completion failed: <errorMessage>`（原文保留，瞬态文本仍可被重试分类匹配）；`aborted` → 抛 `name = "AbortError"` 的错误（半截正文不算成功）；`deferred`/`pending` → 可读错误（llm 节点不支持异步补全）；未知值 → 失败不猜；
- **usage 映射（D4 形状）**：只带五计数 + 可选 `cost`（源有才带）；pi-ai 独有的 `cacheWrite1h`/`reasoning`/`raw*` 不转发；
- `timeoutMs` 不转发：引擎的单次尝试超时就是 abort signal（§7.3），适配器复用同一取消链。

### 9.5 依赖策略与发布形态

- `dependencies`：typebox（schema 与校验）；
- `peerDependencies`（optional）：`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`；版本策略：`^1.0.4` 区间，pi 大版本升级需适配性验证（CLI 事件流探测兜底）；
- core 包不出现任何 `@earendil-works/*` import，适配器物理隔离在 `src/runtime/`；
- 发布形态：ESM-only，`exports` map（`.` / `./runtime`），Node ≥ 22，含 `.d.ts`，`files` 白名单。

---

## 10. 工程结构

```
pi-workflow/
  package.json            # ESM，node >= 22，name 待定（见 §14）
  src/
    index.ts              # 公开导出：StateGraph/Send/START/END/节点工厂/标准 reducer/全部错误与公开类型
    core/
      graph.ts            # StateGraph 构建器 + compile 校验 + 封印
      state.ts            # channel/reducer 与 seq 折叠
      engine.ts           # 超步循环、去重表、Send 队列、预算、信号层级
      send.ts
      errors.ts           # GraphValidationError / GraphSealedError / RouterError / InvalidWriteError
                          # / GraphRecursionError / InstanceBudgetError / NodeExecutionError / TemplateError
      types.ts            # CompileOptions / RunEvent / NodeDefinition / CompiledGraph 等（全部公开）
    nodes/
      fn.ts  llm.ts  agent.ts
    template.ts           # {key} 插值（§5.6）
    runtime/
      executor.ts         # AgentExecutor / CompleteFn 接口 / TokenUsage 类型
      pi-subprocess.ts
      pi-sdk.ts
      llm-pi-ai.ts
    log/
      runlog.ts           # JSONL 事件写入 + onEvent 分发
  tests/                  # vitest；core 全部离线单测（fn 节点 + fake executor + 注入 clock）
  docs/design.md
```

- 并发模型说明：引擎的并发是 **I/O 并发**（llm/agent 的异步等待）；CPU 密集的 fn 节点会阻塞事件循环，`maxConcurrency` 对其无效——文档与错误提示中显式说明，重 fn 建议下沉 worker（v2 考虑 `concurrencyKey` 与 worker 池）。

---

## 11. 与 langgraph 的语义/API 差异清单

| # | langgraph | pi-workflow v1 | 使用者注意 |
|---|---|---|---|
| 1 | `invoke()` 返回最终 state | `run()` 返回 `{ state, runId }` | 不要按 langgraph 习惯解构裸 state |
| 2 | 同超步普通触发按节点去重 | 相同（已显式写死，§5.4） | Send 不去重，与 langgraph 一致 |
| 3 | branch 函数只收 state | router 第二参数 `lastUpdate` | 超集；不需要可忽略 |
| 4 | `recursion_limit` 计数语义 | `recursionLimit` = 超步数上限 | 同义 |
| 5 | checkpoint / interrupt / store | 无（v2） | 需要人工停等请勿使用 v1 |
| 6 | `path_map`（逻辑标签路由） | 无（见 §15 v2 预留） | 直接返回节点名 |
| 7 | 静态 Send 边（图里声明的 Send 边） | 无——Send 只出现在 router 返回值中 | 扇出统一走条件边 |
| 8 | per-node `concurrencyKey` | 无（v2） | 全局 `maxConcurrency` |
| 9 | 节点可变引用共享 state | 输入为只读快照，修改属未定义行为 | 需要变更请返回 partial state |
| 10 | state schema 必选 | 可选（`stateSchema`） | 不提供则只做合并冲突检查 |

---

## 12. 测试策略

- core 全语义离线单测：合并冲突、去重、Send、环、recursionLimit、seq 全序、信号层级、模板、预算；
- **确定性测试**：同图同输入两次 run，状态轨迹逐位一致；
- **规模测试**：单超步 1000 实例（Send 扇出）在预算内正常完成、超预算正确抛错；
- **属性测试**：随机图 + reducer 组合，验证确定性（同图两次 run 的状态轨迹逐位一致）与错误面（失败只允许 `WorkflowError` 家族）——M1 实际断言的就是这两条 + 结局/错误类一致；**合并结合律不属 M1**（reducer 结合律的单独验证留 M2+/v2）；
- **langgraph 语义黄金用例**：对 §11 每条差异各一个可执行用例，防止实现漂移；
- 适配器用 fake executor 测协议；真 pi 联调放 M0 spike 与示例工程。

---

## 13. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0** | **pi subprocess 协议 spike**：验证 stdin 传 prompt、JSON 事件流格式（冻结字段清单）、schema 指令可行性、Windows spawn/taskkill、CLI 版本探测 | 产出《子进程协议》小节并入 §9.2；此后协议变更视为破坏性 |
| M1 | core 引擎：图构建/校验/封印/超步/去重/seq/预算/信号层级/模板 | §12 的 core 测试与确定性测试全绿 —— **完成**（M1 核心引擎，公开面见 src/index.ts） |
| M2 | llm 节点 + pi-ai 默认 complete + run 日志 | schema 校验与 maxAttempts 重试生效；run.jsonl 落盘且含 seq/superstep/committed 标记（committed = `superstep_committed`/`superstep_aborted` 边界事件，见 §8.1）—— **完成**（llmNode / JSONL 日志 / pi-ai 适配器见 src/nodes/llm.ts、src/log/runlog.ts、src/runtime/llm-pi-ai.ts） |
| M3 | subprocess 适配器 | 真实 pi CLI 联调按 M0 协议通过；超时 taskkill、usage 统计、临时文件清理—— **完成**（agentNode / subprocess 适配器见 src/nodes/agent.ts、src/runtime/pi-subprocess.ts） |
| M4 | sdk 适配器 | 进程内跑通 agent 节点；optional peer 生效—— **完成**（PiSdkConfig 类型 / pi sdk 适配器见 src/index.ts、src/runtime/pi-sdk.ts，`executor: "sdk"` 由 src/core/graph.ts 接线） |
| M5 | README、合同审查完整示例、发布准备 | npm pack 可安装；示例开箱即跑；langgraph 黄金用例全绿 |

依赖顺序：M0 与 M1 可并行 → M2 → M3/M4 可并行 → M5。

---

## 14. 开放问题

1. **包名与 scope**：`pi-workflow` 未挂 scope（需查 npm 占用）；是否挂用户自己的 scope？——M5 前必须定；
2. **stdin 协议确认**：pi CLI 是否支持 stdin prompt（M0）；
3. **日志脱敏粒度**：`logOutputs: "hash"` 是否够用，或需按 key 脱敏；
4. **SDK 会话复用**：M4 时决定每节点新会话 vs 同类型复用（上下文污染与成本）—— **已决：每节点新会话（D25）**，复用不做；
5. **CPU 密集 fn 的 worker 池**：出现实际阻塞问题时引入（与 `concurrencyKey` 一并考虑）。

---

## 15. v2 预留（接口形状先占位，避免 v1 返回形状挡路）

- `run()` 返回句柄已含 `cancel()`；v2 增加 `stream()`（AsyncIterable<RunEvent>）与 `getState()`；
- checkpoint / 断点续跑：基于 JSONL 事件 + seq 重放；
- 人工审批节点（interrupt / approval）、`path_map`、`concurrencyKey`、worker 池、YAML 动态图；
- pi-agents 式 RPC 结果信封（agent 结构化输出的进程级强制）。
