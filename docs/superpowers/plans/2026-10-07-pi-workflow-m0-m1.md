# pi-workflow M0+M1 实现计划：子进程协议验证 + core 引擎

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 pi-workflow 的 core 引擎（M1）：代码构图、compile 校验、超步执行（去重/seq 全序/预算/信号层级）、条件边与 Send 扇出、标准 reducer、模板插值——纯 fn 节点即可完整运行；同时完成 M0：用真实 pi CLI 验证并冻结子进程调用协议。

**Architecture:** 单 npm 包（ESM），`src/core/` 为零 I/O、零 pi 依赖的纯编排引擎（图构建器 + 超步解释器），节点执行统一走 handler 抽象；执行语义（去重规则、seq 全序、BSP 原子性、三级取消信号）严格按设计文档 §5/§7 实现，测试即语义的固化。

**Tech Stack:** TypeScript 5.x（strict、NodeNext）、vitest、typebox（schema）、@biomejs/biome。Node ≥ 22，Windows（win32 / git-bash）为开发环境。

**Spec:** `docs/design.md`（v0.2）。本计划所有语义冲突以设计文档为准；执行中若发现设计未覆盖的决策点，按设计文档"设计原则"（§2）就近裁决并记录到 PR/commit message。

## Global Constraints

- ESM-only：`package.json` 里 `"type": "module"`；Node `>=22`。
- `src/core/**` 与 `src/template.ts` **禁止** import `@earendil-works/*`、禁止任何 fs/net/child_process I/O。
- 测试框架 vitest，断言 import 自 `"vitest"`；测试文件放 `tests/**`，与 `src/**` 镜像同名。
- 开发机为 Windows + git-bash：shell 命令一律用 POSIX 语法；路径用正斜杠。
- 日志/目录名时间戳格式：`YYYYMMDDTHHmmssSSSZ`（无冒号、无点，Windows 合法）。
- 每个 commit message 末尾必须有一行：`Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- 若 npm 安装网络失败，用 `HTTPS_PROXY=http://127.0.0.1:7897 npm install ...` 重试。
- 公开类型与错误类名的集合以设计文档 §4/§7.5 为准，不增不漏（M1 暂不导出 `TokenUsage` 之外的 llm/agent 专属运行时）。

## Review Focus

规格暗示但单任务测试未直接覆盖、最可能咬到使用者的五类输入/条件（每行已 pin 到归属任务的测试步骤）：

1. **并发写静默覆盖**：两个节点写同一无 reducer 的 key——期望抛 `InvalidWriteError` 且 `writers` 列出两个节点名 → Task 10 `test_concurrent_write_conflict_lists_nodes`。
2. **根因被次生 AbortError 掩盖**：兄弟实例失败后取消其余实例——期望 `NodeExecutionError.cause` 是根因错误、`collateral` 列出被取消的 instanceId → Task 11 `test_sibling_failure_reports_root_cause_and_collateral`。
3. **Send 大扇出失控**：router 返回超量 Send——期望 `InstanceBudgetError` 而非 OOM/天价账单 → Task 12 `test_send_fanout_over_budget_throws`。
4. **确定性漂移**：同图同输入两次 run——期望状态轨迹逐位一致 → Task 13 `test_two_runs_produce_identical_trace`。
5. **模板缺 key 静默 undefined**：prompt 引用不存在的 key——期望抛 `TemplateError` → Task 7 `test_missing_key_throws`。

---

### Task 1: 工程脚手架与工具链

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `biome.json`, `.gitignore`
- Create: `src/index.ts`（空导出占位）, `tests/smoke.test.ts`

**Interfaces:**
- Produces: 可运行的 `npm test` / `npm run lint` / `npm run typecheck`；后续所有任务的工程前提。

- [ ] **Step 1: 初始化工程**

```bash
cd /e/code/pi-workflow && git init
npm init -y
npm install -D typescript vitest @biomejs/biome @types/node
npm install typebox
```

`package.json` 手工调整为：`"type": "module"`、`"engines": {"node": ">=22"}`、`"name": "pi-workflow"`、scripts：`"test": "vitest run"`、`"lint": "biome check src tests"`、`"typecheck": "tsc --noEmit"`。

`tsconfig.json`：`target: ES2022`、`module: NodeNext`、`moduleResolution: NodeNext`、`strict: true`、`include: ["src", "tests"]`。

`.gitignore`：`node_modules/`、`dist/`、`.pi-workflow/`。

- [ ] **Step 2: 写 smoke 测试（含 typebox API 验证）**

```ts
// tests/smoke.test.ts
import { describe, expect, it } from "vitest";
import { T, Value } from "typebox";

describe("scaffold", () => {
  it("vitest runs", () => { expect(1 + 1).toBe(2); });
  it("typebox Value.Check validates", () => {
    const Schema = T.Object({ name: T.String() });
    expect(Value.Check(Schema, { name: "x" })).toBe(true);
    expect(Value.Check(Schema, {})).toBe(false);
  });
});
```

注意：typebox 1.x 的 Value 模块若导出路径不同（如 `typebox/value`），以实际安装版本 API 为准修正 import 并在此记录——后续任务的 `Value.Check` 用法保持一致。

- [ ] **Step 3: 运行验证**

Run: `npm test && npm run typecheck && npm run lint`
Expected: 全部通过（smoke 2 个测试 PASS）。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: scaffold pi-workflow package (ESM, vitest, typebox, biome)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: M0 spike——pi 子进程调用协议验证

**探索性任务（spike），无 TDD；产出是协议文档。** 每条命令的输出片段要贴进文档。

**Files:**
- Create: `docs/runtime-protocol.md`
- Modify: `docs/design.md` §9.2（若有与 spike 结论冲突处，更新为实测结论）

**Interfaces:**
- Produces: `docs/runtime-protocol.md`——冻结的事件流字段清单、prompt 传递方式（stdin/argv）结论、Windows 进程树终止命令；Task 未来的 M3 计划以此为准。

- [ ] **Step 1: 探测 CLI 版本与基本调用**

```bash
pi --version
pi --mode json -p --no-session "只回复两个字：好的"
```

把 `--version` 输出、第二条命令的**完整 stdout（逐行）**记录进 `docs/runtime-protocol.md`，标注每行 JSON 的字段结构（事件类型名、最终 assistant 文本在哪个字段、usage 在哪个事件）。

- [ ] **Step 2: 验证 stdin 传 prompt**

```bash
echo "只回复两个字：好的" | pi --mode json -p --no-session
```

若 15 秒内无输出则视为不支持 stdin（kill 掉），文档记录"不支持，走临时文件方案"；支持则记录。同时记录：长 prompt（>32k 字符）时 argv 是否报错（可用 40k 个 `a` 字符试一次，失败即证明必须走 stdin/文件）。

- [ ] **Step 3: 验证 Windows 进程树终止**

用 node 起一个 pi 子进程（长任务 prompt），再 `taskkill /PID <pid> /T /F`，确认进程退出、无孤儿 node 进程残留（`tasklist | grep -i node` 验证）。记录命令与行为。

- [ ] **Step 4: 写协议文档并 Commit**

`docs/runtime-protocol.md` 结构：①版本探测命令与输出格式；②spawn 命令行模板；③prompt 传递方式结论；④stdout 事件流字段清单（逐字段）；⑤终止协议；⑥与 design.md §9.2 的差异修正列表。提交：

```bash
git add docs/runtime-protocol.md docs/design.md
git commit -m "docs: M0 spike - freeze pi subprocess protocol findings

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 错误类型

**Files:**
- Create: `src/core/errors.ts`
- Test: `tests/core/errors.test.ts`

**Interfaces:**
- Produces（后续所有任务使用，名称精确）:

```ts
export class WorkflowError extends Error {}
export class GraphValidationError extends WorkflowError { issues: string[] }        // compile 期，聚合全部问题
export class GraphSealedError extends WorkflowError {}
export class RouterError extends WorkflowError { nodeId: string; result: unknown }
export class InvalidWriteError extends WorkflowError { key: string; writers: string[] }
export class GraphRecursionError extends WorkflowError { superstep: number; limit: number }
export class InstanceBudgetError extends WorkflowError { kind: "superstep" | "total"; limit: number }
export class TemplateError extends WorkflowError { template: string; key: string }
export class NodeExecutionError extends WorkflowError {
  node: string; instanceId: string; cause: unknown; collateral: string[];
  logPath?: string; summary?: string;
}
```

- [ ] **Step 1: 写失败测试**——每个类各一条：`expect(() => { throw new InvalidWriteError("msg", { key: "k", writers: ["a", "b"] }) }).toThrow(InvalidWriteError)`；并断言 `WorkflowError` 是全部类的父类、字段值保留。
- [ ] **Step 2:** Run: `npx vitest run tests/core/errors.test.ts` → Expected: FAIL（模块不存在）。
- [ ] **Step 3: 实现** `src/core/errors.ts`——全部 9 个类，构造器参数 `(message, props)`，`props` 逐字段挂到实例。
- [ ] **Step 4:** Run 同上 → Expected: PASS。
- [ ] **Step 5: Commit** —— `git commit -m "feat(core): error taxonomy

Co-Authored-By: Claude Code <noreply@anthropic.com>"`

---

### Task 4: 标准 reducer 与状态折叠

**Files:**
- Create: `src/core/state.ts`
- Test: `tests/core/state.test.ts`

**Interfaces:**
- Consumes: `InvalidWriteError`（Task 3）。
- Produces:

```ts
export type Reducer<V> = (current: V, update: V) => V;
export type StateSchema<S> = Partial<{ [K in keyof S]: Reducer<S[K]> }>;
export const overwrite: Reducer<any>;   // 后写覆盖
export const append: Reducer<any[]>;    // 任一侧非数组 → 包成 InvalidWriteError 抛出
export const concat: Reducer<string>;
export const setOnce: Reducer<any>;     // 第二次写入 → InvalidWriteError
export type ChannelUpdate = { key: string; value: unknown; writer: string };
export function foldUpdates<S extends object>(state: S, updates: ChannelUpdate[], channels: StateSchema<S>): S;
```

- [ ] **Step 1: 写失败测试**（关键断言）：

```ts
it("folds updates in given order with reducer", () => {
  const out = foldUpdates({ logs: [] }, [
    { key: "logs", value: ["a"], writer: "n1" },
    { key: "logs", value: ["b"], writer: "n2" },
  ], { logs: append });
  expect(out.logs).toEqual(["a", "b"]);
});
it("throws InvalidWriteError listing both writers on reducer-less key", () => {
  expect(() => foldUpdates({}, [
    { key: "x", value: 1, writer: "n1" },
    { key: "x", value: 2, writer: "n2" },
  ], {})).toThrow(InvalidWriteError);
  // 且 error.writers 深比较为 ["n1", "n2"]
});
it("setOnce rejects second write; append rejects non-array; concat concatenates; overwrite overrides", ...);
```

- [ ] **Step 2:** Run → Expected: FAIL（模块不存在）。
- [ ] **Step 3: 实现**：`foldUpdates` 线性扫描，reducer 抛错统一包装为 `InvalidWriteError`（`writers: [writer]`，cause 保留）；无 reducer key 重复写入 → `InvalidWriteError`，`writers` 为按顺序的写入者节点名列表。
- [ ] **Step 4:** Run → Expected: PASS。
- [ ] **Step 5: Commit** —— `feat(core): channels, standard reducers, seq-order folding`

---

### Task 5: Send、fnNode 与图构建器

**Files:**
- Create: `src/core/send.ts`, `src/nodes/fn.ts`, `src/core/graph.ts`（仅构建器部分）
- Test: `tests/core/send.test.ts`, `tests/nodes/fn.test.ts`, `tests/core/graph.test.ts`

**Interfaces:**
- Consumes: Task 3/4 类型。
- Produces:

```ts
// src/core/types.ts（本任务建立，放公共类型）
export const START = "__start__";
export const END = "__end__";
export type NodeContext = { runId: string; superstep: number; instanceId: string; seq: number; signal: AbortSignal };
export type NodeHandler<S, I> = (input: Readonly<I>, ctx: NodeContext) => Promise<Partial<S>> | Partial<S>;
export type NodeDefinition<S, I = S> = {
  kind: "fn" | "llm" | "agent"; name: string;
  handler: NodeHandler<S, I>; inputType?: TSchema; writeTo?: string;
  retry?: { maxAttempts: number }; timeoutMs?: number;
};
export type Router<S, I = unknown> = (state: S, lastUpdate: Partial<S>) => RouterResult;
export type RouterResult = typeof END | string | Send | (typeof END | string | Send)[];
export type GraphCfg<S> = { name?: string; channels?: StateSchema<S>; stateSchema?: TSchema };
export type CompiledGraphData<S> = {
  name: string; channels: StateSchema<S>; stateSchema?: TSchema;
  nodes: Map<string, NodeDefinition<S, any>>;
  plainEdges: Map<string, string[]>;          // from → 有序目标（不含 END）
  routers: Map<string, Router<S, any>>;
};
export class StateGraph<S extends object> {
  constructor(cfg?: GraphCfg<S>);
  addNode<I = S>(name: string, node: NodeDefinition<S, I>): StateGraph<S>;
  addEdge(from: typeof START | string, to: typeof END | string): StateGraph<S>;
  addConditionalEdges<I = unknown>(from: string, router: Router<S, I>): StateGraph<S>;
  compile(opts?: CompileOptions): CompiledGraph<S>;   // Task 6 完成校验逻辑，本任务先只做封印与数据装配
}
export type CompileOptions = { name?: string; services?: Services };
export type Services = { agent?: { subprocess?: any; sdk?: any }; complete?: unknown; logger?: unknown; clock?: () => number; sleep?: (ms: number) => Promise<void>; random?: () => number };
export type CompiledGraph<S> = { readonly name: string; run(initial: S, options?: RunOptions): Promise<RunResult<S>>; invoke: CompiledGraph<S>["run"] };
export type RunResult<S> = { state: S; runId: string };

// src/core/send.ts
export class Send<I = unknown> { constructor(readonly node: string, readonly input: I); }

// src/nodes/fn.ts
export function fnNode<S extends object, I = S>(handler: NodeHandler<S, I>, opts?: { timeoutMs?: number }): NodeDefinition<S, I>;
// 返回 { kind: "fn", name: 占位空串, handler, timeoutMs }；addNode 时回填 name
```

- [ ] **Step 1: 写失败测试**——addNode 重复节点名抛 `GraphValidationError`（单条 issue 也用同一类型，issues 数组长度 1）；节点名为 `"START"`/`"END"` 字面量抛错；同一 from 重复 `addEdge` 抛错；同一 from 重复 `addConditionalEdges` 抛错；`Send` 暴露 `node`/`input` 字段；`fnNode` 返回 `kind === "fn"`。
- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3: 实现**——注意：即时抛错类校验（重复注册）在 addXxx 内直接 throw；跨节点校验（引用存在性等）留给 Task 6 的 compile。`compile()` 本任务只装配 `CompiledGraphData` 并返回带 `run()` 占位（throw "not implemented"）的 `CompiledGraph`。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5: Commit** —— `feat(core): StateGraph builder, Send, fnNode`

---

### Task 6: compile 全量校验与封印

**Files:**
- Modify: `src/core/graph.ts`（compile 的校验与封印）
- Test: `tests/core/graph.compile.test.ts`

**Interfaces:**
- Consumes: Task 5 全部；`GraphValidationError.issues`。
- Produces: compile 期校验行为（设计文档 §6 的 1–5、8 条；§6.6/§6.7 属运行期或 M2 后项，不在本任务）：

1. 边/router 引用未注册节点 → issue；2. START 无出边 → issue；3. 从 START 不可达节点 → issue（warning 前缀 `"warning:"`）；4. 无出边且无 router 的节点 → warning issue；5. compile 后调用 addXxx → throw `GraphSealedError`。

- [ ] **Step 1: 写失败测试**——构造含多个问题的图，断言一次 compile 抛出的 `issues` **同时包含全部问题**（聚合报错）；合法图 compile 不抛、返回 name（cfg.name 优先于 cfg.channels 构造时的 name）；封印后 addNode/addEdge/addConditionalEdges 各自抛 `GraphSealedError`。
- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3: 实现**——校验收集为 issue 字符串数组，非空则 `throw new GraphValidationError("graph invalid", { issues })`。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5: Commit** —— `feat(core): compile-time validation and graph sealing`

---

### Task 7: 模板插值

**Files:**
- Create: `src/template.ts`
- Test: `tests/template.test.ts`

**Interfaces:**
- Consumes: `TemplateError`（Task 3）。
- Produces:

```ts
export function interpolate(template: string, input: unknown): string;
// 规则（设计 §5.6）：{key} 与 {a.b.c} 从 input 解析；缺失 → TemplateError{key}；
// 非字符串值 → JSON.stringify；{{ → 字面 {；}} → 字面 }；插值只作用于模板本身
```

- [ ] **Step 1: 写失败测试**（每条规则一个用例）：基本替换、嵌套路径、缺失 key 抛错（断言 `error.key === "clause"`）、数组/对象值 JSON.stringify、`{{literal}}` 输出 `{literal}`、`}}` 转义、空串模板原样返回。
- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3: 实现**——单遍扫描：先按 `{{`/`}}` 分词，再解析 `{...}` 占位符；解析路径用 `.split(".")` 逐级取值（`Object.prototype.hasOwnProperty` 判缺失）。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5: Commit** —— `feat(core): {key} template interpolation`

---

### Task 8: 引擎基础——超步循环、普通边去重、事件

**Files:**
- Create: `src/core/engine.ts`（`executeRun` 及实例/事件内部结构）
- Modify: `src/core/graph.ts`（`run()` 接到 `executeRun`）
- Create: `src/log/emitter.ts`（内存事件发射器：seq 分配 + onEvent 分发）
- Test: `tests/core/engine.basic.test.ts`

**Interfaces:**
- Consumes: Task 4 `foldUpdates`、Task 5/6 图数据、Task 7 模板（本任务暂不用，M2 用）。
- Produces:

```ts
export type RunOptions = {
  recursionLimit?: number;            // 默认 25
  maxConcurrency?: number;            // 默认 8
  maxInstancesPerSuperstep?: number;  // 默认 1000
  maxTotalInstances?: number;         // 默认 10000
  runTimeoutMs?: number;              // 默认无
  signal?: AbortSignal;
  onEvent?: (e: RunEvent) => void;
};
export type RunEvent =
  | { seq: number; superstep: number; ts: number; runId: string; type: "run_started"; graph: string; input: unknown }
  | { seq: number; superstep: number; ts: number; runId: string; type: "node_started"; node: string; instanceId: string; kind: string }
  | { seq: number; superstep: number; ts: number; runId: string; type: "node_finished"; node: string; instanceId: string; output: unknown; durationMs: number }
  | { seq: number; superstep: number; ts: number; runId: string; type: "node_failed"; node: string; instanceId: string; error: string }
  | { seq: number; superstep: number; ts: number; runId: string; type: "superstep_committed" }
  | { seq: number; superstep: number; ts: number; runId: string; type: "superstep_aborted" }
  | { seq: number; superstep: number; ts: number; runId: string; type: "run_finished"; status: "completed" | "failed"; durationMs: number };
export type ResolvedServices = { clock: () => number; sleep: (ms: number) => Promise<void>; random: () => number };
export async function executeRun<S extends object>(graph: CompiledGraphData<S>, initial: S, options: RunOptions, services: ResolvedServices): Promise<RunResult<S>>;
// instanceId = `${node}#${seq}`
```

- [ ] **Step 1: 写失败测试**（fn 节点直构造，不必经 fnNode）：

```ts
it("runs START→a→END, merging handler output into state", async () => {
  const g = new StateGraph().addNode("a", fnNode(() => ({ v: 1 })))
    .addEdge(START, "a").addEdge("a", END);
  const { state, runId } = await g.run({});
  expect(state.v).toBe(1); expect(runId).toBeTruthy();
});
it("dedups plain-edge fan-in: two nodes → one aggregate execution", async () => {
  // a、b 都 → aggregate；aggregate 用闭包计数器记录执行次数
  expect(aggregateRuns).toBe(1);
});
it("emits ordered event stream with run_started/node_started/node_finished/superstep_committed/run_finished", ...);
  // 断言 onEvent 收到的 type 序列，且 seq 严格递增、instanceId 形如 "a#1"
it("recursionLimit exceeded → GraphRecursionError", ...);  // 自环 a→a，recursionLimit: 3
```

- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3: 实现**——按设计 §5.1 伪代码：seq 全局自增；`activated: Map<string, Instance>` 去重；END 过滤；`foldUpdates` 提交；`emit` 完成序 + seq；`runId = crypto.randomUUID()`；时间戳 `ts = services.clock()`。本任务**不含** router/Send/预算/取消（后续任务），普通边全部激活即可。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5: Commit** —— `feat(core): superstep engine with dedup and event stream`

---

### Task 9: 条件边与 Send

**Files:**
- Modify: `src/core/engine.ts`
- Test: `tests/core/engine.router.test.ts`

**Interfaces:**
- Consumes: Task 8 全部；`RouterError`（Task 3）。
- Produces: 设计 §5.4 触发/去重规则、§4.2 `lastUpdate` 语义的运行时行为。

- [ ] **Step 1: 写失败测试**（核心用例）：

```ts
it("router returning Send[] fans out one instance per Send, inputs are Send payloads", async () => {
  // extract 写 3 条 clauses；addConditionalEdges("extract", s => s.clauses.map(c => new Send("review", { clause: c })))
  // review 记录收到的 input；断言 review 执行 3 次、每次 input 是对应 { clause }
});
it("router string results dedup by node name; duplicate names collapse", async () => {
  // router 返回 ["x","x"] → x 执行 1 次
});
it("router evaluates ONCE per node per superstep even when node had N Send instances", async () => {
  // review 被 Send 展开 3 实例且带 router；router 内计数器 === 1
});
it("router receives (mergedState, lastUpdate) where lastUpdate folds only this node's writes", async () => {
  // 断言第二参数等于该节点本超步写入的 fold 结果
});
it("null/undefined/[] from router = END; RouterError on unknown node, on START, on Send targeting END", ...);
```

- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3: 实现**——`normalizeRoute(r)`：`null/undefined → []`；`string → [r]`；`Send → [r]`；数组逐项同法。router 求值：按"该节点最早完成实例的 seq"排序、每节点一次；先普通边激活，后 router 结果（同一 `activated` 去重表 + Send 追加）。Send 实例的 `writeTo` 检查：目标节点必须定义 `writeTo`（fn 节点经 Send 进入时若无 writeTo，其返回值按无 reducer key 直写处理，与其他实例同规则）。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5: Commit** —— `feat(core): conditional edges and Send fan-out`

---

### Task 10: 运行期合并冲突与超步原子性

**Files:**
- Modify: `src/core/engine.ts`
- Test: `tests/core/engine.atomicity.test.ts`

**Interfaces:**
- Consumes: Task 4 `InvalidWriteError`、Task 8 引擎。
- Produces: 失败超步"写入不提交 + `superstep_aborted` 事件"；committed 边界语义（事件流的 committed 判定 = 最近一个 `superstep_committed` 与 `superstep_aborted` 之间的事件为未提交——**不做**逐事件打标，日志消费端按边界判定）。

- [ ] **Step 1: 写失败测试**：

```ts
it("concurrent write to reducer-less key throws InvalidWriteError listing both node names", async () => {
  // a、b（普通边从 START 并联）都写 { x }；await expect(g.run({})).rejects.toThrow(InvalidWriteError)
  // 且捕获到的 error.writers 包含 "a" 与 "b"
});
it("failed superstep does not commit writes and emits superstep_aborted", async () => {
  // a 写 {x:1} 后 b 抛错（同超步）；断言 run reject，且事件流含 superstep_aborted、
  // 其后 run_finished status==="failed"；若继续观察（用 b 成功的对照图）状态不含 x —— 用单测直接断言异常路径即可
});
```

- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3: 实现**——先跑完本超步全部实例再提交（已是 BSP）；任一实例 handler 抛错 → 收集全部已完成的 sibling 结果但**不提交**，emit `superstep_aborted`，抛 `NodeExecutionError`（本任务先以简单形态抛出：root cause 原样包装；collateral 与信号在 Task 11）。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5: Commit** —— `feat(core): superstep atomicity and write-conflict detection`

---

### Task 11: 信号层级与 fail-fast 取消

**Files:**
- Modify: `src/core/engine.ts`
- Test: `tests/core/engine.signals.test.ts`

**Interfaces:**
- Consumes: Task 8/10；`RunOptions.signal`。
- Produces: 设计 §7.4 三级信号；`NodeExecutionError` 携带根因与 `collateral`；`runTimeoutMs`；外部取消。

- [ ] **Step 1: 写失败测试**（用受控 promise 让实例挂起）：

```ts
it("sibling failure reports root cause and collateral, cancels siblings", async () => {
  // a 挂起（永不 resolve 的 promise + 收到实例 signal 时 reject AbortError），b 立即抛错
  // 断言 rejects.toThrow(NodeExecutionError)；error.node === "b"；error.cause 是 b 的原始错误；
  // error.collateral 包含 a 的 instanceId
});
it("external signal cancels run", async () => {
  // controller.abort() → run reject（WorkflowError 子类），事件流有 run_finished status==="failed"
});
it("runTimeoutMs aborts run", async () => { /* 注入 fake clock/sleep 或极短超时 */ });
it("fn handler receives ctx.signal and run.cancel() works", async () => { /* 句柄 cancel */ });
```

`run.cancel()`：`run()` 返回 `Promise` 无法直接挂方法——改为返回 `RunHandle`：`interface RunHandle<S> extends Promise<RunResult<S>> { cancel(): void }`（Promise 子类或带 cancel 附加属性的对象，实现取其简者，测试按所选形态写）。**这是对设计 §4.4 的实现层细化，回填设计文档 §4.4 一行说明。**

- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3: 实现**——run AbortController → 每实例 AbortController → 每次 attempt AbortController；实例失败（重试耗尽后）abort 兄弟实例的 instance signal；被取消的实例（未完成）记入 `collateral`；`node_retry` 事件本任务一并实现（fn 节点无 retry 配置时行为不变）。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5: Commit** —— `feat(core): signal hierarchy, fail-fast cancellation, RunHandle.cancel`

---

### Task 12: 预算护栏

**Files:**
- Modify: `src/core/engine.ts`
- Test: `tests/core/engine.budget.test.ts`

**Interfaces:**
- Consumes: Task 8/9；`InstanceBudgetError`。
- Produces: `maxInstancesPerSuperstep` / `maxTotalInstances` 检查点（生成下一批之后、执行之前）。

- [ ] **Step 1: 写失败测试**：

```ts
it("send fanout over maxInstancesPerSuperstep throws InstanceBudgetError", async () => {
  // extract 写 5 条，router Send 5 实例，maxInstancesPerSuperstep: 3
  // 断言 rejects.toThrow(InstanceBudgetError) 且 error.kind === "superstep"
});
it("maxTotalInstances accumulates across supersteps", async () => {
  // 自环每轮 +2 实例，maxTotalInstances: 5 → 在累计超 5 时抛，error.kind === "total"
});
```

- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3: 实现**——两处检查：pending 生成后按 `pending.length` 与累计实例总数判断；超限即抛（不执行任何实例）。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5: Commit** —— `feat(core): instance budget guards`

---

### Task 13: 确定性、规模与属性测试（M1 验收）

**Files:**
- Create: `tests/core/engine.determinism.test.ts`, `tests/core/engine.scale.test.ts`, `tests/core/engine.property.test.ts`
- Modify: `src/index.ts`（公开导出全部 API：StateGraph/Send/START/END/三个节点工厂中的 fnNode/标准 reducer/全部错误类/全部公开类型）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: M1 验收证据 + 包公开面。

- [ ] **Step 1: 写测试**：

```ts
// determinism：同图（含 Send 扇出与 reducer 合并）跑两次，收集每次的
// 每超步 channel 快照数组，deep-equal 逐位一致
it("two runs produce identical trace", ...);
// scale：1k Send 实例（maxInstancesPerSuperstep: 1500），全部完成、状态正确合并
it("1000-instance send fanout completes within budget", ...);
// property：种子化随机图生成器（节点 3-8 个、随机边/随机 Send/随机 reducer 组合，
// 跳过构造期非法图），断言：不抛非预期错误类型；同图两次 run 轨迹一致
it("random graphs are deterministic (seeded, 30 iterations)", ...);
// golden（§11 差异清单中 core 相关三条）：普通边扇入去重、Send 不去重、run() 返回 {state, runId}
```

- [ ] **Step 2:** Run 全量 `npm test` → Expected: 全绿；`npm run typecheck && npm run lint` 通过。
- [ ] **Step 3: 收尾**——`src/index.ts` 补全导出；设计文档 §13 勾选 M1（把表格中 M1 行的验收标注"完成于本 commit"）。
- [ ] **Step 4: Commit** —— `feat: M1 core engine acceptance - determinism, scale, property tests, public exports`

---

## Self-Review 记录

- 规格覆盖：设计 §4.5（标准 reducer）→ Task 4；§5.1–5.4 → Task 8/9/10；§5.6 → Task 7；§6 → Task 6；§7.1/7.4 → Task 10/11；§5.3 预算 → Task 12；§12 测试策略（core 部分）→ Task 13；M0 → Task 2。§4.3 llmNode/agentNode、§8 JSONL 落盘、§9 适配器属 M2/M3，不在本计划（口径见 Goal）。
- 类型一致性：`ChannelUpdate.writer`、`instanceId = node#seq`、`ResolvedServices`、`RunHandle`（Task 11 定义并对设计文档回填）各任务引用一致。
- Review Focus 五条均已 pin 到归属任务。
- 比例：计划约 300 行，决策密度集中于 Interfaces 与测试断言，无实现体转录。
