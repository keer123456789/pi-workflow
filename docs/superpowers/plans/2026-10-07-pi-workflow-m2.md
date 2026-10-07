# pi-workflow M2 实现计划：llm 节点 + pi-ai 默认 complete + run 日志

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地设计 §13 的 M2——llm 节点（schema 校验 + maxAttempts 重试）与 run 日志（JSONL 落盘，含 seq/superstep/committed 边界），并为 §9.4 的 pi-ai 默认补全提供可用性探测与适配器。

**Architecture:** llm 节点工厂产出一个"待绑定"的 NodeDefinition；`compile()` 期解析补全实现（node.complete → services.complete → pi-ai 适配器），把绑定后的 handler 写进 `CompiledGraphData.nodes`（节点定义在 compile 期就被复制，不污染构建器状态）。JSONL 日志是引擎事件流的第二个 sink：引擎把事件（可选脱敏后）分发给 `onEvent` 与 `RunLogger`，默认实现 `src/log/runlog.ts` 只做同步 fs 写入；`src/core/**` 不出现任何 `@earendil-works/*` import（pi-ai 只在 `src/runtime/llm-pi-ai.ts` 内动态 import）。

**Tech Stack:** 现有栈不变（ESM-only、TS strict/ES2022/NodeNext、Node ≥22、vitest、biome、typebox）。新增 **devDependency** `@earendil-works/pi-ai@^1.0.4`（仅开发/类型检查用；运行期是 optional peer）。无新增运行期依赖。

**Spec:** `docs/design.md`（§4.3/§4.4/§4.6/§7.2/§8/§9.1/§9.4/§9.5/§13）。计划的每个偏差都列在"计划决策"里并回填设计文档。

## Global Constraints

- ESM-only；TypeScript strict / ES2022 / NodeNext；Node ≥22；vitest；biome；**不新增运行期依赖**（typebox 仍是唯一 `dependencies` 项）。
- `src/core/**` 零 `@earendil-works/*` import、零直接 I/O（fs 只出现在 `src/log/runlog.ts`）；`src/runtime/` 是适配器物理隔离区。
- 日志/目录名时间戳格式：`YYYYMMDDTHHmmssSSSZ`（UTC、无冒号无点，Windows 合法）。
- 提交信息末尾附 `Co-Authored-By: Claude Code <noreply@anthropic.com>`；POSIX shell。
- 公开面"不增不漏"：本里程碑只新增 `llmNode`（值）与 `TokenUsage` / `CompleteFn` / `RunLogger`（类型），其余一律不导出。
- 现有 265 条测试不得回归；只允许按下列任务明确指出的方式修改既有测试（重试分类对齐、public-exports 扩充）。

## 计划决策（controller；实现时同步回填设计文档）

- **D1 范围**：M2 = llmNode + pi-ai 默认 complete + run 日志，外加使其可用的引擎工作（重试分类 §7.2、usage 传播、`TokenUsage`/`CompleteFn`/`RunLogger` 类型、R21 的 RunOptions 三字段回归）。**不做**：agentNode（M3）、`inputType` 运行期校验（M3 backlog，设计 §4.3 声明但未命名错误语义）、subprocess/sdk 适配器（M3/M4）。
- **D2 日志默认开启（严格按设计 §4.4/§8）**：每次 run 都写 `<logDir ?? PI_WORKFLOW_LOG_DIR ?? ".pi-workflow/runs">/<YYYYMMDDTHHmmssSSSZ>-<runId>/run.jsonl`。关闭方式 = `services.logger: {}`（`RunLogger` 全部钩子可选，空对象即全静默）；自定义实现 = `services.logger` 非空对象（替代默认 JSONL 实现）；`logDir` 覆盖目录，`logOutputs`/`onLogError` 只配置行为。测试卫生：`.gitignore` 增 `.pi-workflow/`；`vitest.config.ts` 的 `test.env` 设 `PI_WORKFLOW_LOG_DIR` 指向 OS 临时目录（测试期日志不落仓库）。**注意**：`onLogError` 默认 `"fail"` ⇒ 默认目录不可写时**每次 run 都以 `WorkflowError("run log write failed: …")` 拒绝**——审计优先，刻意如此；放宽用 `onLogError: "warn"` 或 `services.logger: {}`。`PI_WORKFLOW_LOG_DIR` 是 M2 引入的环境覆盖（CI/测试用，记录于设计 §8）。
- **D3 重试分类（§7.2 落地）**：引擎只在 `isRetryableError(cause)` 为真时重试，否则**立即失败**（不进退避、不发 node_retry）；`maxAttempts` 仍是上限。判定 = 内部"可重试"标记（`markRetryable()`，非枚举 Symbol，llm 节点的 schema/JSON 失败用它）**或**消息正则族：`/(?:^|\D)(?:429|408|5\d\d)(?:\D|$)|rate[ -]?limit|too many requests|timeout|timed out|ECONNRESET|socket hang ?up/i`，或 `error.code === "ECONNRESET"`。引擎自身的 attempt 超时错误消息含 "timed out" → 天然可重试。
- **D4 `TokenUsage`**（公开类型，镜像 pi-ai 的 `Usage`，结构子集）：
  ```ts
  type TokenUsage = {
    input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
    cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  ```
- **D5 `CompleteFn`**：按 §9.1 逐字：`(req: { prompt: string; model?: string; schema?: TSchema; signal: AbortSignal; timeoutMs: number }) => Promise<{ text: string; usage?: TokenUsage }>`，定义在 `src/runtime/executor.ts`（core 只做 type-only import）。`AgentExecutor` 留 M3。
- **D6 `RunLogger`**（公开类型，定义在 `src/log/runlog.ts`）：三个同步钩子，`onRunStart?(info)` → 建目录/文件；`onEvent?(event)` → 写一行；`onRunFinish?(info)` → 收尾。`info = { runId: string; graph: string; ts: number }` / `{ runId; status: "completed" | "failed"; ts }`。
- **D7 脱敏（`logOutputs: "hash"`）**：对 `run_started.input`、`node_started.input`、`node_finished.output` 三个字段做引擎侧替换，值 → 字符串 `"sha256:<64位hex>"`（`sha256(JSON.stringify(value))`；stringify 抛错时对字面量 `"[unserializable]"` 取哈希）。**onEvent 与 logger 双路都拿到脱敏后的事件**（§8.1）。
- **D8 日志失败策略**：logger 任一钩子抛错 → `onLogError: "fail"`（默认）使 run 以 `WorkflowError`（消息 `run log write failed: <原因>`，`cause` 附原错）拒绝，含 run 收尾阶段（run_finished 已发后 `onRunFinish` 抛错同样拒绝）；`"warn"` 只 `console.warn("pi-workflow: run log write failed: <原因>")`，不阻断。预检失败（初始 state 校验/已 abort 的 signal）的 run 不创建日志（一个事件都不发，也不写文件）。
- **D9 文件布局**：`<logDir>/<YYYYMMDDTHHmmssSSSZ>-<runId>/run.jsonl`，每行一个 JSON 事件（与 onEvent 同序 = 完成序），`\n` 结尾，同步 append。至少含 run_started、…、run_finished。
- **D10 committed 语义维持 M1 边界方案**（§8.1 的 `committed:false` 逐事件打标不可实现：事件实时按完成序发出，提交与否要到超步结束才知道）。设计 §8.1 措辞回填为边界方案；M2 验收的"含 committed 标记"= 文件含 `seq`/`superstep` 字段与 `superstep_committed`/`superstep_aborted` 边界事件。
- **D11 usage 传播**：`NodeContext` 增 `reportUsage?(usage: TokenUsage): void`（引擎总是提供）；引擎按 attempt 记录（最后一次调用生效），成功尝试的用量挂到 `node_finished.usage`（新增可选字段）。失败/重试尝试不产生 usage。
- **D12 llm 绑定**：`NodeDefinition` 增 `complete?: CompleteFn`（仅 kind==="llm" 合法；其他 kind 声明它 → compile issue）。`compile()` 为每个 llm 节点解析 `def.complete ?? services.complete ?? pi-ai 默认（可用时）`，全部缺失 → compile issue `node "x" (kind "llm") has no completion implementation: ...`。绑定机制：`src/nodes/llm.ts` 用模块内 WeakMap 存"待绑定"信息，导出内部函数 `bindLlmNode(def, complete): NodeDefinition`；`graph.ts` 在复制 `nodes` 时绑定（不进公开面）。
- **D13 pi-ai 适配器**（§9.4）：`isPiAiAvailable()`（`createRequire(import.meta.url).resolve("@earendil-works/pi-ai")` try/catch，进程内缓存）与 `defaultPiAiComplete()`（懒建单例）。模型串格式 `"<provider>/<id>"`（按第一个 `/` 切分；缺 `/` 或未知模型 → 抛可读错误）。调用 `models.completeSimple(model, { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { signal })`；`stopReason === "error"` → 抛错（消息含 `errorMessage`）；文本用 `contentText(msg.content)`；usage 映射为 D4 形状。构建用 `builtinModels()`（`@earendil-works/pi-ai/providers/all`）。凭据：pi-ai 默认（内存 store + 环境凭据）；持久化 `~/.pi` 另立 M5 事项。适配器测试 vi.mock 两个模块路径；compile 的"未安装"路径 vi.mock `llm-pi-ai.js` 模块本身。
- **D14 设计回填清单**（分散在各任务）：§4.3（NodeContext.reportUsage / NodeDefinition.complete / usage）、§4.4（三字段回归 + D2 措辞）、§4.6（complete/logger 定型）、§7.2（分类落地）、§8.1（D7/D9/D10 措辞）、§9.4（D13 细节）、§13（M2 行标记完成，Task 9）。
- **D15 不做 Static 关联的类型级强化**（设计 §4.3 "Static<typeof schema> 须可赋给 S[K]"）：M2 只保证 `writeTo: K extends keyof S & string`；Static 赋给性约束留 M5 打磨（计划口述，不实现）。

## Review Focus

1. **日志失败策略两条路径**（fail 使 run 拒绝——包括 run_finished 之后的 `onRunFinish` 抛错；warn 只 console.warn）——边界一致、不吞错（Task 3）。
2. **hash 模式下 onEvent 与 JSONL 双路都只见脱敏值**——经回调泄露全文是审计场景的实害（Task 3）。
3. **重试分类收紧后的失败时机**——不可重试错误立即失败（不发 node_retry、不进退避），schema 违规可重试（Task 5/6）。
4. **无补全实现时 compile 报错而非运行期爆炸**；pi-ai 缺失时消息可行动（Task 8）。
5. **usage 只挂成功尝试的 node_finished**，重试不产生 usage、重试计数不漂移（Task 4）。

---

### Task 1: M2 类型与设计回填（骨架）

**Files:**
- Modify: `src/core/types.ts`
- Create: `src/runtime/executor.ts`
- Create: `src/log/runlog.ts`（本任务只落 `RunLogger` 类型；JSONL 实现属 Task 2）
- Modify: `docs/design.md`（§4.3/§4.4/§4.6/§7.2/§8.1）
- Test: `tests/public-exports.test.ts`

**Interfaces:**
- Consumes: 现有 `Services`/`ResolvedServices`/`NodeContext`/`NodeDefinition`/`RunEvent`/`RunOptions`。
- Produces: `TokenUsage`、`CompleteFn`、`RunLogger`；`NodeDefinition.complete?: CompleteFn`；`NodeContext.reportUsage?`；`RunEvent.node_finished.usage?`；`RunOptions.logDir/logOutputs/onLogError` 回归；`Services.complete?: CompleteFn`、`Services.logger?: RunLogger`。

- [ ] **Step 1:** 类型落地（逐条，值按 D4/D5/D6/D11/D12）：
  - `src/runtime/executor.ts`：`import type { TSchema } from "typebox";` + `TokenUsage`（D4）+ `CompleteFn`（D5）。文件头注释说明：core 只 type-only import，运行时零耦合。
  - `src/log/runlog.ts`：本步只导出 `RunLogger` 类型（D6，type-only import `RunEvent`）。
  - `src/core/types.ts`：`Services.complete?: CompleteFn; logger?: RunLogger`（删 `unknown` 占位与 biome-ignore）；`ResolvedServices` 本任务不动（补齐在 Task 3/5）；`NodeDefinition.complete?: CompleteFn`；`NodeContext.reportUsage?: (usage: TokenUsage) => void`；`node_finished` 增 `usage?: TokenUsage`；`RunOptions` 回加 `logDir?: string; logOutputs?: "full" | "hash"; onLogError?: "fail" | "warn";`（注释指向 §8 与 D2/D8）。
- [ ] **Step 2:** 设计回填：§4.3 加 `NodeContext.reportUsage` 与 `NodeDefinition.complete`（含 llm 专用说明）；§4.4 三字段注释改为 M2 实义并写明 D2 启用条件；§4.6 `complete`/`logger` 类型化；§7.2 末尾加"（分类落地于 M2：正则族 + 可重试标记，不可重试错误立即失败）"；§8.1 首句改为"启用日志的 run 每次写一个 JSONL 文件"并写明 D7/D9/D10。
- [ ] **Step 3:** `tests/public-exports.test.ts`：值集合不变（本任务不新增值导出）；类型引用加 `TokenUsage`/`CompleteFn`/`RunLogger`；**删除** R21 的 `// @ts-expect-error logDir` 钉（字段已回归，改为正例 `const opts: RunOptions = { logDir: "x" }`）。
- [ ] **Step 4:** Run `npm run typecheck && npm test` → 全绿（值集合未变，265 条不回归）。
- [ ] **Step 5: Commit** —— `feat(core): M2 types - TokenUsage/CompleteFn/RunLogger, RunOptions logging fields (D2/D5/D6)`

---

### Task 2: JSONL 写入器

**Files:**
- Modify: `src/log/runlog.ts`
- Test: `tests/log/runlog.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `RunLogger`。
- Produces: `createJsonlLogger(opts: { dir: string; runId: string; ts: number }): RunLogger`；辅助 `formatLogTimestamp(ts: number): string`（`YYYYMMDDTHHmmssSSSZ`，UTC）——模块内导出供测试使用，**不进公开面**。

- [ ] **Step 1: 写失败测试**（`os.tmpdir()` 下建立本次测试专属目录）：
  ```ts
  it("creates <dir>/<YYYYMMDDTHHmmssSSSZ>-<runId>/run.jsonl and appends one JSON event per line", () => {
    const logger = createJsonlLogger({ dir: tmp, runId: "r1", ts: Date.UTC(2026, 9, 7, 12, 0, 0, 123) });
    logger.onRunStart?.({ runId: "r1", graph: "g", ts: 1 });
    logger.onEvent?.({ kind: "run_started" /* 完整 RunEvent 由用例构造 */ } as RunEvent);
    logger.onRunFinish?.({ runId: "r1", status: "completed", ts: 2 });
    // 断言目录名 = "20261007T120000123Z-r1"，文件两行（事件 + 结尾），行尾 \n，JSON.parse 回读一致
  });
  it("throws a wrapped error (message includes the path) when the directory cannot be created", () => {
    // dir 指向一个已存在的**文件**路径（用 fs.writeFileSync 先占位）→ onRunStart 必须抛
  });
  ```
- [ ] **Step 2:** Run → FAIL（模块不存在）。
- [ ] **Step 3: 实现**——`onRunStart`：`mkdirSync(recursive: true)` + `appendFileSync(path, "")`（建空文件，失败即抛）；`onEvent`：`appendFileSync(path, JSON.stringify(event) + "\n")`；`onRunFinish`：no-op（文件句柄无状态）。**同步 API**（事件顺序 = 调用顺序；失败即刻可捕获）。任何 fs 错误包装为 `Error("run log write failed: <cause.message>")`，`cause` 附原错。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5: Commit** —— `feat(log): JSONL run logger (D9)`

---

### Task 3: 引擎日志接线（启用判定 / 双路分发 / hash / 失败策略）

**Files:**
- Create: `src/core/redact.ts`（hash 脱敏纯函数）
- Modify: `src/core/engine.ts`、`src/log/emitter.ts`、`src/core/graph.ts`（ResolvedServices 扩展点）、`.gitignore`、`vitest.config.ts`
- Test: `tests/core/engine.log.test.ts`、`tests/core/redact.test.ts`

**Interfaces:**
- Consumes: Task 1/2；`services.logger`；`RunOptions.logDir/logOutputs/onLogError`。
- Produces: run 期的日志装配（D2 默认开启）——`services.logger` 为非空对象 → 直接用；否则每次 run 用默认工厂 `createJsonlLogger`，dir = `options.logDir ?? process.env.PI_WORKFLOW_LOG_DIR ?? ".pi-workflow/runs"`。`ResolvedServices` 增 `logger?: RunLogger` 与 `logOutputs: "full" | "hash"`、`onLogError: "fail" | "warn"` 归一（缺省 full / fail；非法值回落缺省——与既有归一化策略一致）。

- [ ] **Step 1: 写失败测试**（全部用临时 `logDir`）：
  ```ts
  it("writes run_started / node events / run_finished to the default JSONL when logDir is provided", ...);
  it("hash mode redacts input/output on BOTH the file and onEvent (sha256:<hex>)", ...);
  it("onLogError 'fail' rejects the run when the logger throws at start", ...);
  it("onLogError 'fail' rejects the run when onRunFinish throws after run_finished", ...);
  it("onLogError 'warn' logs console.warn and still resolves", ...);
  it("logs by default to PI_WORKFLOW_LOG_DIR (env) when nothing is configured; services.logger {} silences completely", ...);
  it("preflight rejection (invalid initial state) writes no log file", ...);
  ```
- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3: 实现**——emitter 增加第二 sink 与可选 mapEvent（hash 变换在 sink 之前统一做一次，两路拿同一对象）；引擎在 preflight 通过后调用 `logger.onRunStart`，`run_finished` emit 后调用 `onRunFinish`；所有 logger 调用包 try/catch → D8 策略（fail：走该 run 的失败出口并 attach 原错；warn：console.warn）。预检失败路径不触碰 logger（D8 末句）。默认目录解析含 `PI_WORKFLOW_LOG_DIR` 环境覆盖。哈希用 `node:crypto` 的 `createHash("sha256")` 放 `src/core/redact.ts`（`crypto` 非 I/O，允许进 core）。同时改 `.gitignore`（增 `.pi-workflow/`）与 `vitest.config.ts`（`test.env.PI_WORKFLOW_LOG_DIR = os.tmpdir()/pi-workflow-test-logs`）。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5: Commit** —— `feat(core): wire run logging - dual-sink emitter, hash redaction, failure policy (D2/D7/D8)`

---

### Task 4: usage 传播

**Files:**
- Modify: `src/core/engine.ts`
- Test: `tests/core/engine.basic.test.ts`（追加）或 `tests/core/engine.log.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `NodeContext.reportUsage` 与 `node_finished.usage`。
- Produces: 引擎每次 attempt 前重置记录槽；把 `reportUsage` 绑进 ctx；成功 attempt 把槽值写入 `node_finished.usage`（未报告则字段缺省）。

- [ ] **Step 1: 写失败测试**：handler 内 `ctx.reportUsage?.({...})` 后正常返回 → `node_finished.usage` 深等于该值；重试场景（先失败后成功，失败 attempt 也报告）→ 只有最后一次成功 attempt 的值；未调用 `reportUsage` → 事件上无 `usage` 键（不是 `undefined` 值）。
- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3: 实现**（引擎 attempt 循环里加槽 + ctx 组装处绑定）。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5: Commit** —— `feat(core): usage propagation via ctx.reportUsage (D11)`

---

### Task 5: 重试分类（§7.2 落地）

**Files:**
- Create: `src/core/retry.ts`
- Modify: `src/core/engine.ts`（attempt 失败分支）
- Modify: `docs/design.md`（§7.2，Task 1 已加注，这里补正则逐字）
- Test: `tests/core/retry.test.ts` + 对齐 `tests/core/engine.signals.test.ts`

**Interfaces:**
- Produces: `isRetryableError(error: unknown): boolean`；`markRetryable<T extends Error>(error: T): T`（非枚举 Symbol 标记）。均不进公开面。

- [ ] **Step 1: 写失败测试**：`isRetryableError` 表驱动，按 D3 逐字表——`"429 rate limit"`✓、`"HTTP 503"`✓、`"timeout"`✓、`"socket hang up"`✓、`code:"ECONNRESET"`✓、`"boom"`✗、`markRetryable(new Error("boom"))`✓、`"1408"`✗（数字粘连不误判）。引擎级：`maxAttempts: 3` + 不可重试错误 → 恰好 1 次尝试、0 条 node_retry、立即失败；可重试错误 → 3 次尝试、2 条 node_retry。
- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3: 实现**——引擎失败分支改为 `if (!isRetryableError(cause) || attempt >= maxAttempts) fail(cause);`（顺序：取消判定在前，R20a 不动）。审计 `engine.signals.test.ts` 全部重试用例：**意图是重试的**用例其错误消息必须落进正则族（已在族内的不动）；意图是"不可重试"的补一条断言。允许的既有测试改动仅限此文件的消息与断言补充，不得削弱断言。
- [ ] **Step 4:** Run 全量 → PASS。
- [ ] **Step 5: Commit** —— `feat(core): retry classification - retryable family + marker, fail-fast on non-retryable (D3)`

---

### Task 6: llmNode 工厂

**Files:**
- Create: `src/nodes/llm.ts`
- Test: `tests/nodes/llm.test.ts`

**Interfaces:**
- Consumes: `CompleteFn`/`TokenUsage`（Task 1）、`interpolate`（`src/template.ts`）、`markRetryable`（Task 5）、`Value`（`typebox/value`）、`ctx.reportUsage`（Task 4）。
- Produces: 公开 `llmNode<S, K extends keyof S & string>(cfg: { prompt: string | ((input: unknown) => string); schema: TSchema; writeTo: K; model?: string; complete?: CompleteFn; retry?: { maxAttempts: number }; timeoutMs?: number }): NodeDefinition<S>`；内部 `bindLlmNode(def: NodeDefinition, complete: CompleteFn): NodeDefinition`。

- [ ] **Step 1: 写失败测试**（全部用注入的 fake complete，无网络）：
  ```ts
  it("interpolates a string prompt from the instance input and calls the bound complete", ...);
  it("parses JSON output, accepts it when the schema passes, and returns the raw value (writeTo wrapping is the engine's job)", ...);
  it("strips ```json fences before parsing", ...);
  it("marks JSON/schema failures retryable and throws a message carrying the schema error", ...);
  it("reports usage via ctx.reportUsage when complete returns usage", ...);
  it("defaults timeoutMs to 120_000 and passes retry through", ...);
  it("a function prompt receives the raw instance input", ...);
  ```
- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3: 实现**——`llmNode` 返回 `{ kind: "llm", name: "", handler: <占位，见下>, writeTo, retry, timeoutMs: cfg.timeoutMs ?? 120_000, complete: cfg.complete }`；**绑定机制（D12）**：模块内 `const pending = new WeakMap<NodeDefinition, LlmCfg>()`，工厂把 cfg 存进去，`bindLlmNode(def, complete)` 用 cfg 生成真正的 handler（`prompt 求值 → complete(...) → 解析 JSON（剥栅栏）→ Value.Check(schema, parsed) → 失败 markRetryable(throw) → ctx.reportUsage(usage) → 返回 parsed`）；若 cfg.complete 已有，工厂内部直接绑定（bindLlmNode 幂等/可覆盖）。未绑定的 def 被直接调用 → 抛"llm node is not bound"（compile 保证不会发生）。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5: Commit** —— `feat(nodes): llmNode factory with schema validation and completion binding (D12/D15)`

---

### Task 7: pi-ai 默认 complete

**Files:**
- Create: `src/runtime/llm-pi-ai.ts`
- Modify: `package.json`（devDependency + peerDependencies/peerDependenciesMeta）
- Test: `tests/runtime/llm-pi-ai.test.ts`

**Interfaces:**
- Produces: `isPiAiAvailable(): boolean`；`defaultPiAiComplete(): CompleteFn`（懒建单例）。

- [ ] **Step 1:** 安装 devDependency（代理，§9.5 版本策略 `^1.0.4`）：
  `HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 npm i -D @earendil-works/pi-ai@^1.0.4`
  `package.json` 同时加 `"peerDependencies": { "@earendil-works/pi-ai": "^1.0.4" }` 与 `"peerDependenciesMeta": { "@earendil-works/pi-ai": { "optional": true } }`。
- [ ] **Step 2: 写失败测试**（vi.mock 两个模块路径 `@earendil-works/pi-ai` 与 `@earendil-works/pi-ai/providers/all`，用 fake `builtinModels()` 返回假 Models）：
  ```ts
  it("splits 'provider/id' and calls completeSimple with a user message carrying the prompt and the signal", ...);
  it("maps AssistantMessage text and usage (input/output/cacheRead/cacheWrite/totalTokens/cost)", ...);
  it("throws with errorMessage when stopReason is 'error'", ...);
  it("throws a readable error for a missing '/' or unknown model", ...);
  it("defaultsPiAiComplete returns the same instance on repeated calls (single Models build)", ...);
  ```
- [ ] **Step 3:** Run → FAIL。
- [ ] **Step 4: 实现**（D13 逐条；`isPiAiAvailable` 用 `createRequire(import.meta.url).resolve(...)` try/catch + 进程内缓存；`contentText` 从 `@earendil-works/pi-ai` 动态 import）。
- [ ] **Step 5:** Run → PASS。
- [ ] **Step 6: Commit** —— `feat(runtime): pi-ai default completion adapter + availability probe (D13)`

---

### Task 8: compile 期补全解析与绑定

**Files:**
- Modify: `src/core/graph.ts`
- Test: `tests/core/graph.compile.test.ts`（追加）+ `tests/core/engine.basic.test.ts`（llm 跑通一条）

**Interfaces:**
- Consumes: Task 6 `bindLlmNode`、Task 7 `isPiAiAvailable`/`defaultPiAiComplete`。
- Produces: compile 对 llm 节点的 §6.6 检查与绑定（写进 `CompiledGraphData.nodes` 的副本）。

- [ ] **Step 1: 写失败测试**（`vi.mock("../../src/runtime/llm-pi-ai.js")` 控制可用性）：
  ```ts
  it("reports an llm node with no completion implementation when pi-ai is unavailable", () => {
    // 期望 issues 恰 1 条，含 'has no completion implementation'
  });
  it("accepts an llm node when services.complete is provided (pi-ai unavailable)", ...);
  it("accepts an llm node when node-level complete is provided", ...);
  it("prefers node complete over services.complete (call log assertion)", ...);
  it("reports a non-llm node that declares complete", ...);
  it("binds the pi-ai default when available and no complete is provided (fake complete注入 via mock)", ...);
  ```
- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3: 实现**——`collectIssues()` 增 llm 补全检查（universe 检查之后）；compile 装配 `nodes` 副本时对 kind==="llm" 调 `bindLlmNode`；探测只在"有 llm 节点且无显式 complete"时调用。
- [ ] **Step 4:** Run 全量 → PASS。
- [ ] **Step 5: Commit** —— `feat(core): compile-time completion resolution and llm handler binding (D12)`

---

### Task 9: 收尾——公开面、设计 §13、全量验证

**Files:**
- Modify: `src/index.ts`、`docs/design.md`（§13 M2 行）、`tests/public-exports.test.ts`
- Test: 全量

- [ ] **Step 1:** `src/index.ts` 导出：值 `llmNode`（+1）；类型 `TokenUsage`/`CompleteFn`/`RunLogger`（+3）；`public-exports.test.ts` 值集合从 19 → 20 精确更新。
- [ ] **Step 2:** 设计 §13 M2 行标注"—— **完成**（llmNode/JSONL 日志/pi-ai 适配器见 src/…）"。
- [ ] **Step 3:** `npm test && npm run typecheck && npm run lint` 全绿；`git status` 干净（测试经 `PI_WORKFLOW_LOG_DIR` 写临时目录，仓库内无 `.pi-workflow/` 残留）。
- [ ] **Step 4: Commit** —— `feat: M2 acceptance - llm node, pi-ai default complete, run log, public exports`
