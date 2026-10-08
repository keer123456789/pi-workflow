# M3: pi subprocess 适配器（agent 节点运行时）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `agentNode` 工厂与 subprocess 适配器——agent 节点经冻结协议（docs/runtime-protocol.md）spawn pi CLI 子进程，产出文本/JSON 写入 State，接通引擎的 usage/重试/日志链路。

**Architecture:** 三层分工——`nodes/agent.ts` 工厂（D12 同款 WeakMap 绑定：task 插值 → executor 调用 → 可选 schema 解析/校验 → usage 上报）；`runtime/pi-subprocess.ts` 适配器（spawn pi CLI、stdin 传 task、逐行解析 JSONL 事件流、双层成败判定、taskkill 杀树、版本探测）；compile 期在 `core/graph.ts` 解析 executor 引用（`"subprocess" | "sdk" | 自定义函数`）。适配器物理隔离在 `src/runtime/`，core 只 import 类型。

**Tech Stack:** TypeScript strict / ES2022 / NodeNext、Node ≥ 22、node:child_process（node 内建，非新依赖）、typebox（已有）、vitest（已有）。

**Spec:** `docs/design.md`（§4.3 agentNode、§4.6 services、§6.6、§7.2/§7.3、§9.1/§9.2）+ `docs/runtime-protocol.md`（M0 冻结协议，协议细节以此为准）。

## Global Constraints

- ESM-only；TS strict / ES2022 / NodeNext；Node ≥ 22。
- 运行期零新增依赖（typebox 除外）——**不引入 cross-spawn**：`shell:true` 的 DEP0190 弃用告警是噪声不阻断（M0 ②节实测），接受。
- M3 **不新增任何 `@earendil-works/*` import**（subprocess 走 CLI 二进制，SDK 适配器是 M4）；`@earendil-works/pi-coding-agent` 的 optional peerDep 声明推迟到 M4（届时才有 import）。
- core 零直接 I/O：`fs` 只许在 `src/log/`；`node:child_process` 只许在 `src/runtime/pi-subprocess.ts`。
- 公开面不增不漏：运行期值 20→21（+`agentNode`）；类型 +2（`AgentExecutor`、`PiSubprocessConfig`），一律 `export type`。
- Windows 为已验证平台（M0 冻结协议）；POSIX kill 为尽力而为（进程组 SIGKILL），测试对平台差异用 `describe.skipIf(process.platform !== "win32")` 门控。
- 测试编辑 append-only（修改既有断言须任务文本显式授权；本计划唯一授权见 Task 2 的 llm.ts 重构——**仅限实现文件，测试文件仍 append-only**）。
- 提交信息 conventional commits + trailer `Co-Authored-By: Claude Code <noreply@anthropic.com>`。

## 冻结裁定（preflight 已定，实现者不得重开）

- **D16 成败双层判定（M0 ④.6）**：退出码 ≠ 0 → 失败（stderr 摘要为 cause，启动期错误如模型不存在/无凭据都在这层）；退出码 = 0 → **最后一条** assistant `message_end` 的 `stopReason === "stop"` 才成功（协议 ④.3"非 stop 即失败"）；`"error"` → 抛错保留 `errorMessage` 原文（瞬态文本可被 D3 正则族匹配）；`"aborted"` → 抛 `name = "AbortError"`；其他值 → 可读失败不猜；事件流中无 assistant 消息 → 失败。
- **D17 stdin-only**：task 文本只走 stdin（写入后立即 `end()`，M0 ③.4——不关会挂死）。**不实现**临时文件回退：M0 已证 stdin 对 40k 字符逐字节可靠（③.3），§9.2"stdin 不可行则落临时文件"的条件在 M3 不触发；§13 M3 验收行"临时文件清理"相应豁免（无文件可清理）。
- **D18 版本探测**：首次真正调用 executor 时惰性探测（compile 是同步函数，不能在 compile 期 spawn）；进程内缓存（失败同样缓存，重装/升级 pi 后重启进程）；区间 = semver `^1.0.4`（≥1.0.4 <2.0.0，对齐 §9.5 版本策略；实测基准 1.0.4）；解析失败/非 0 退出/超区间 → 可行动错误（含实测版本与期望区间）。compile 期只校验 `services.agent.subprocess` 配置存在。
- **D19 杀树**：win32 = `execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"])`（M0 ⑤.1 冻结形式）；POSIX = spawn 时 `detached: true` + `process.kill(-child.pid, "SIGKILL")`（进程组硬杀，镜像 /T /F 语义，无优雅宽限）。signal（attempt 级，engine.ts:1007 `AbortSignal.any`）abort 时必须杀树且快速失败——**被超时放弃的子进程不得存活**。
- **D20 executor 解析（D12 镜像）**：工厂把配置存 WeakMap（**def 与 handler 双键**——addNode 浅拷贝共享 handler）；compile 对每个 `kind === "agent"` 节点解析 executor：cfg.executor 为函数 → 原样使用；`"subprocess"` → `services.agent.subprocess !== undefined` 才合法（**空对象 `{}` 合法**——字段全有默认），未配置 → compile issue；`"sdk"` → compile issue（`sdk adapter is not implemented until M4`）；解析后 `bindAgentNode(def, executor)` 返回新定义（镜像 `bindLlmNode`：幂等、不改原件、`.handler` 替换）。工厂产物（含注册副本）总能查到配置；非工厂的手工 agent 定义 → compile issue（kind 即契约，与 llm 的 "has no completion implementation" 同姿态）。
- **D21 usage 映射（D4）**：executor 返回的 `usage` 缺失 → 不上报（`node_finished` 无 usage 键）；数字键缺失 → 以 0 填（pi 的 usage 键集可变，M0 ④.3）。
- **D22 schema 指令在 handler 层**：schema 存在时，指令文本在 **task 插值之后**拼接（§5.6——指令不参与插值），解析（剥栅栏 → JSON.parse）与 typebox 校验都落 `nodes/agent.ts`（失败 `markRetryable`，D3 同 prompt 重发）；executor 只回原文（`req.schema` 按接口透传，M3 的 subprocess 适配器不使用它——M4 SDK 与自定义适配器同享 handler 层处理，§9.3"输出与 schema 处理与 subprocess 相同"）。schema 缺省 → 产出 = 最终 assistant 文本字符串原样。
- **D23 model/tools 优先级**：`--model` 取 `cfg.model ?? services.agent.subprocess.defaultModel`，都无 → 不带该参数（pi 自行解析默认模型，M0 ②节实测可行）；`--tools` 只来自 `cfg.tools`，无 → 不带（pi 默认全量 read/bash/edit/write）。

## Review Focus

1. **stdin 不关导致挂死**（M0 ③.4 实测 40s+ 零字节）——期望：写完立即 `end()`；测试钉住 fake 子进程确实收到 EOF。
2. **退出码 0 但 LLM 失败被当成功**（M0 ④.6：LLM 失败 EXIT=0）——期望：stopReason 非 "stop" 一律失败；测试钉住 error/aborted/无 assistant 三分支。
3. **事件流截断/未知事件让解析器崩溃**（M0 ⑤.4 任意行边界截断、④.0 未知 type 必须容忍）——期望：半行 JSON、乱码行、未知 type 都跳过不抛；测试逐类钉住。
4. **超时/取消后子进程树残留**（Windows 孤儿 pi）——期望：attempt signal abort 即杀树、executor 快速 reject AbortError；测试用真实挂起的假子进程验证不悬挂。
5. **CLI 版本漂移被静默兼容**——期望：超区间报可行动错误（含实测版本与期望区间）；测试钉 0.9.0 与 2.0.0 两向。

---

### Task 1: AgentExecutor 与 PiSubprocessConfig 类型（公开面类型 +2）

**Files:**
- Modify: `src/runtime/executor.ts`（加 AgentExecutor）
- Create: `src/runtime/pi-subprocess.ts`（本任务只有文件头注释 + PiSubprocessConfig 类型；实现归 Task 3）
- Modify: `src/core/types.ts:121-133`（Services.agent.subprocess 从 `any` 收紧）
- Modify: `src/index.ts`（+2 type 导出）
- Test: `tests/public-exports.test.ts`（append-only：类型位钉 +2）

**Interfaces:**
- Produces（Task 2/3/4 依赖）：
  - `export type AgentExecutor = (req: { task: string; tools?: string[]; model?: string; schema?: TSchema; signal: AbortSignal; timeoutMs: number; runId: string; instanceId: string }) => Promise<{ output: string; usage?: TokenUsage }>`（§9.1 verbatim，放 `src/runtime/executor.ts`，与 CompleteFn 并列）
  - `export type PiSubprocessConfig = { bin?: string; cwd?: string; env?: NodeJS.ProcessEnv; extraArgs?: string[]; defaultModel?: string }`（§4.6 verbatim，放 `src/runtime/pi-subprocess.ts`）
  - `Services.agent`：`{ subprocess?: PiSubprocessConfig; sdk?: any }`（sdk 仍 any——M4 细化；core 对 pi-subprocess.ts 只 type-only import）

- [ ] **Step 1: 写失败测试**（append 到 tests/public-exports.test.ts 的类型钉块）：`AgentExecutor`/`PiSubprocessConfig` 各加一个类型位（`const executor: AgentExecutor = ...` 最小合法形状 + `const subCfg: PiSubprocessConfig = {}`），命名与既有 25 个类型位同风格。
- [ ] **Step 2:** `npm run typecheck` → FAIL（类型不存在）。
- [ ] **Step 3:** 落三处类型与两处导出（`export type { AgentExecutor, PiSubprocessConfig }`——AgentExecutor 从 `./runtime/executor.js`、PiSubprocessConfig 从 `./runtime/pi-subprocess.js`；文件头注释说明"实现归 Task 3，本模块当前只承载配置类型"）。`Services.agent` 收紧时删除该行的 biome-ignore 注释（sdk 字段仍 any 则保留一条 ignore——以 lint 过为准）。
- [ ] **Step 4:** `npm run typecheck && npm run lint` → 双净；`npm test` → 350/350（新类型位随 typecheck 验证，运行期测试数不变）。
- [ ] **Step 5:** Commit `feat(runtime): AgentExecutor and PiSubprocessConfig types (M3/T1)`。

### Task 2: agentNode 工厂 + compile 绑定（D20/D22 镜像 D12）

**Files:**
- Create: `src/nodes/agent.ts`（工厂 + 绑定，镜像 llm.ts 的 WeakMap 双键模式）
- Create: `src/nodes/output-parse.ts`（从 llm.ts 抽出的共享解析助手）
- Modify: `src/nodes/llm.ts`（改用共享助手——**本计划唯一授权的实现文件重构**；公开行为逐字不变：错误消息 "llm output is not valid JSON"/"llm output does not match schema" 等原文保留）
- Modify: `src/core/graph.ts`（resolveAgentExecutors + collectIssues 的 agent 分支）
- Test: `tests/nodes/agent.test.ts`（新文件）；`tests/core/graph.compile.test.ts`（append-only）；`tests/core/engine.basic.test.ts`（append-only，fake executor 端到端）

**Interfaces:**
- Consumes: Task 1 的 `AgentExecutor`/`PiSubprocessConfig`；既有 `NodeContext`（`signal` 即 attempt 信号，engine.ts:1007）、`markRetryable`（D3）、`interpolate`（§5.6）、`Value.Check`。
- Produces（Task 3/4 依赖）：
  - `agentNode<S, K extends keyof S & string>(cfg: { task: string | ((input: unknown) => string); schema?: TSchema; writeTo: K; tools?: string[]; model?: string; executor: "subprocess" | "sdk" | AgentExecutor; retry?: { maxAttempts: number }; timeoutMs?: number }): NodeDefinition<S>`——`timeoutMs` 缺省 **600_000**（§7.3）；返回 kind `"agent"` 定义，name 空串占位（addNode 回填）。
  - `bindAgentNode<S, I = S>(def: NodeDefinition<S, I>, executor: AgentExecutor): NodeDefinition<S, I>`（模块内导出，不进 index.ts；幂等、返回新对象、不修改原件，镜像 bindLlmNode）。
  - `agentExecutorOf<S, I>(def: NodeDefinition<S, I>): "subprocess" | "sdk" | AgentExecutor | undefined`（模块内导出：graph.ts 读工厂配置用——executor 引用不是 NodeDefinition 字段，走 WeakMap）。
  - `src/nodes/output-parse.ts` 导出（模块内，不进 index.ts）：`stripFences(text: string): string`、`parseJsonOutput(kind: "llm" | "agent", text: string): unknown`（错误消息 `"<kind> output is not valid JSON: …"`）、`schemaErrorDetail(schema: TSchema, value: unknown): string`、`preview(text: string): string`、`schemaInstruction(schema: TSchema): string`（D22 指令文本，逐字：`"\n\n输出约束：最终输出只包含一个符合以下 JSON Schema 的 JSON 对象，不要包含任何其他文本或代码栅栏：\n" + JSON.stringify(schema)`）。
  - handler 每次尝试流程：`task 求值（函数或 interpolate）→ schema 存在则拼指令 → executor({ task, tools, model, schema, signal: ctx.signal, timeoutMs, runId: ctx.runId, instanceId: ctx.instanceId }) → schema 存在：parseJsonOutput + Value.Check（失败 markRetryable）→ usage 存在则 ctx.reportUsage（D21——仅成功后，I2 澄清口径）→ 返回产出值本身`（writeTo 包裹由引擎 updateOf 完成，engine.ts:1416）。

- [ ] **Step 1: 写失败测试**（tests/nodes/agent.test.ts，先写核心七组）：
  1. 文本模式（schema 缺省）：fake executor 回 `{ output: "结论文本" }` → handler 返回值经引擎落 `writeTo` key = "结论文本"；
  2. schema 模式：fake executor 收到的 `task` 以 schemaInstruction 结尾、`schema` 字段透传；产出栅栏 JSON → 解析值落 writeTo；
  3. JSON 违规 → `markRetryable`（`isRetryableError` 为真），消息含 `agent output is not valid JSON`；
  4. schema 违规 → markRetryable，消息含 `agent output does not match schema`；
  5. usage 上报：executor 回 usage → `ctx.reportUsage` 以同一对象调用；不回 → 不调（D21）；
  6. 未绑定占位 handler 调用抛 `"agent node is not bound: …"`（措辞镜像 llm，面向作者）；
  7. `timeoutMs` 缺省 600_000；task 函数形态直接调用不插值。
- [ ] **Step 2:** `npm run typecheck && npm test -- tests/nodes/agent.test.ts` → FAIL。
- [ ] **Step 3:** 先抽 `src/nodes/output-parse.ts`（从 llm.ts 平移，parseJsonOutput 参数化 kind 前缀），llm.ts 改 import 并保持其错误消息逐字不变；再写 agent.ts（工厂 + WeakMap 双键 + bindAgentNode + agentExecutorOf，注释镜像 llm.ts 说明 addNode 浅拷贝约束）。
- [ ] **Step 4:** graph.ts：`resolveAgentExecutors(nodes, services): Map<string, AgentExecutor>`（只处理有 WeakMap 配置的 agent def：函数原样；`"subprocess"` 查 `services?.agent?.subprocess !== undefined` → 记名 + 标记 OK；`"sdk"` → 记 issue）；collectIssues 的 kind 分支加 agent：无 executor 解析 → `node "x" (kind "agent") has no executor implementation: pass executor: "subprocess" with services.agent.subprocess configured, or a custom AgentExecutor function to agentNode`；"sdk" → `node "x" (kind "agent") declares executor "sdk" but the sdk adapter is not implemented until M4`；`"subprocess"` 未配置 → `node "x" (kind "agent") declares executor "subprocess" but services.agent.subprocess is not configured (an empty object {} is enough to accept defaults)`。compile 装配副本处绑定（在 resolveLlmCompletions 调用旁）。
- [ ] **Step 5:** append 测试：graph.compile（上述三条 issue + 空对象合法 + 自定义函数免配置 + 手工 agent 定义报 no executor）；engine.basic（fake executor 端到端：agent 节点 → writeTo 落值 → node_finished.usage 挂事件 → 重试计数经 retry:{maxAttempts:2} 生效）。
- [ ] **Step 6:** `npm run typecheck && npm run lint && npm test` → 全绿（350 + 新增）。
- [ ] **Step 7:** Commit `feat(nodes): agentNode factory with executor binding and schema handling (D20/D22)`。

### Task 3: subprocess 适配器（spawn / 解析 / 杀树 / 版本探测）

**Files:**
- Create: `src/runtime/pi-subprocess.ts`（完整实现；本任务改写 Task 1 的类型占位文件）
- Test: `tests/runtime/pi-subprocess.test.ts`（新文件；假 pi shim 走真实子进程，无网络）

**Interfaces:**
- Consumes: Task 1 的 `AgentExecutor`/`PiSubprocessConfig`；M0 冻结协议（docs/runtime-protocol.md ①②③④⑤ 节）。
- Produces（Task 4 依赖）：
  - `createPiSubprocessExecutor(config: PiSubprocessConfig): AgentExecutor`（模块内导出——graph.ts 在 resolveAgentExecutors 里调用；不进 index.ts）。
  - 内部（同模块导出供测试）：`buildSpawnArgs(config, req): { command: string; args: string[]; opts: SpawnOptions }`（纯函数，冻结模板 verbatim：`["--mode","json","-p","--no-session", ...(model ? ["--model", model] : []), ...(tools ? ["--tools", tools.join(",")] : []), ...extraArgs]`，`{ shell: true, cwd: config.cwd ?? process.cwd(), stdio: ["pipe","pipe","pipe"], env: { ...process.env, ...config.env }, detached: process.platform !== "win32" }`，command = `config.bin ?? "pi"`）；`resetPiCliProbeForTests(): void`（清 D18 进程内缓存）。
  - 事件流解析器（模块内函数）：逐行处理 stdout chunk 缓冲（**容忍尾行不完整**——被杀场景 M0 ⑤.4）、跳过 `type:"session"` 首行、未知 type 跳过、收集 `type:"message_end"` 且 `message.role === "assistant"` 的**最后一条**（文本 = `message.content[]` 中 `type:"text"` 项的 `text` 拼接；usage 从该 message 映射 D4/D21）。
  - 成败判定（D16 双层）：退出码 ≠ 0 → `Error("pi CLI failed (exit <code>): <stderr 摘要，压缩单行截 500 字符>")`；stopReason `"error"` → `Error("pi agent failed: " + errorMessage)`；`"aborted"` → AbortError（name = "AbortError"，措辞镜像 llm-pi-ai.ts abortError）；其他非 stop → `Error("pi agent failed: unsupported stopReason …")`；无 assistant → `Error("pi agent produced no assistant message")`。
  - signal 处理：`req.signal` 已 abort → 不 spawn 直接 AbortError；监听 abort → 立即 taskkill/组杀 + reject AbortError（**先杀后等**，不等子进程自然退出；D19）；成功路径移除监听。
  - 版本探测（D18）：spawn `pi --version`（同 config.bin/cwd/env；stdin "ignore"），stdout 去空白须 `/^\d+\.\d+\.\d+$/`，semver 满足 `^1.0.4`；失败/不匹配 → `Error("pi CLI is not usable: expected version ^1.0.4 (verified against 1.0.4), got <raw>; install @earendil-works/pi-coding-agent (npm i -g @earendil-works/pi-coding-agent) or set services.agent.subprocess.bin")`。探测结果进程内缓存（含失败），`resetPiCliProbeForTests` 清除。

- [ ] **Step 1: 写失败测试**——假 pi shim 方案：测试 setUp 在 `os.tmpdir()` 下建唯一目录，放 shim + 脚本（win32：`pi.cmd` 内容 `@node "%~dp0fake-pi.js" %*`；POSIX：`pi` sh 脚本 `#!/bin/sh\nexec node "$(dirname "$0")/fake-pi.js" "$@"`；`describe.skipIf(process.platform !== "win32")` 门控 win32 专属组）；`fake-pi.js` 按环境变量切场景（`FAKE_PI_MODE`）：`version`（回 `"1.0.4\n"` 或 `FAKE_PI_VERSION` 指定值）、`success`（打 session header + message_end(assistant, stopReason:"stop", content:[{type:"text",text:"好的"}], usage) + agent_settled，同时**把收到的 stdin 全文读到 EOF 后打一行 `{"type":"stdin-echo","len":N}`**——钉住 stdin EOF 契约）、`llm-error`（assistant stopReason:"error" + errorMessage "403 …"）、`hang`（永不退出）、`garbage`（合法行 + 乱码行 + 截断尾行 + 未知 type 行混排）、`no-assistant`（只有 header）。executor 经 `createPiSubprocessExecutor({ bin: "pi", cwd: shimDir, env: { ...process.env, PATH: `${shimDir}${path.delimiter}${process.env.PATH}`, FAKE_PI_MODE: … } })` 构造。用例组：①版本探测（1.0.4 过 / 0.9.0、2.0.0、非 semver 拒绝 / 缓存生效——probe 计数 = 1）；②成功路径（文本产出 + usage 映射 + stdin-echo len 匹配 task 长度）；③双层判定（exit 0 + stopReason error → 失败且消息含 403；无 assistant → 失败）；④健壮性（garbage 场景 → 仍解析出成功文本）；⑤取消（hang 场景 + 50ms 后 abort → reject AbortError 且 < 5s 返回——杀树生效）；⑥buildSpawnArgs 纯函数（model/tools/extraArgs/cwd/env/detached 逐字段）；⑦env 透传（FAKE_PI_ENV_ECHO 场景回显 env）。
- [ ] **Step 2:** `npm test -- tests/runtime/pi-subprocess.test.ts` → FAIL。
- [ ] **Step 3:** 实现 pi-subprocess.ts（文件头注释说明协议出处与 D16–D19/D21 裁定；`node:child_process` 的 `spawn`/`execFile` 只出现在本文件）。杀树：win32 `execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"])`（结果不等待杀完再 reject——taskkill 发出即 reject，进程消亡是 OS 的事）；POSIX `process.kill(-child.pid, "SIGKILL")`，catch ESRCH。stderr 收集上限（如 8KB 截断）。行解析按 `\n` 切分、`\r` 容忍、最后一段若非空（无换行结尾）**解析失败则丢弃**（截断尾行）。
- [ ] **Step 4:** `npm run typecheck && npm run lint && npm test` → 全绿（注意 hang 场景测试须有自身超时护栏，防 CI 悬挂）。
- [ ] **Step 5:** Commit `feat(runtime): pi subprocess adapter - spawn, JSONL parsing, two-layer verdict, tree kill (D16-D19)`。

### Task 4: 接线收尾 + 真实 CLI 冒烟

**Files:**
- Modify: `src/index.ts`（+`agentNode` 值导出，20→21）
- Modify: `tests/public-exports.test.ts`（值集合 20→21，append-only）
- Modify: `docs/design.md`（§13 M3 行勾选，M1/M2 行同款；§9.2 补一句 D17 裁定：临时文件回退在 M3 不实现、stdin 为唯一通道）
- Test: 全量验证 + 真实 pi CLI 冒烟（脚本放 SDD 工作区，不入库）

**Interfaces:**
- Consumes: Task 2 的 `agentNode`（值）、Task 3 的 `createPiSubprocessExecutor`。

- [ ] **Step 1:** index.ts 加 `export { agentNode } from "./nodes/agent.js";`（注释同步 M1+M2+M3 口径）；public-exports 值集合数组加 `"agentNode"`、注释 20→21。
- [ ] **Step 2:** design.md：§13 M3 行追加 `—— **完成**（agentNode / subprocess 适配器见 src/nodes/agent.ts、src/runtime/pi-subprocess.ts）`；§9.2 的临时文件 bullet 后补一句：`M3 裁定（D17）：stdin 是唯一 task 通道（M0 ③.3 实测 40k 逐字节可靠），临时文件回退分支不实现——验收行"临时文件清理"豁免。`
- [ ] **Step 3:** 真实 CLI 冒烟（无凭据环境则报告 BLOCKED 并停止，交控制器）：脚本写 `<SDD 工作区>/smoke-m3.mjs`——用真实库构造单 agent 节点图（`executor: "subprocess"`，task "只回复两个字：好的"，schema 缺省），`compile + run`，打印产出与 node_finished.usage；再跑一个 schema 模式用例。冒烟前提：`pi --version` 可用且有凭据（M0 的 PI_CODING_AGENT_DIR/ARK_API_KEY 若在则带上）。结果原文记入 `<SDD 工作区>/smoke-m3-result.md`。
- [ ] **Step 4:** 全量验证：`npm test`（350 + T2/T3 新增，全绿）、`npm run typecheck`、`npm run lint` 净、`git status` 干净、仓库无 `.pi-workflow/` 泄漏。
- [ ] **Step 5:** Commit `feat: M3 acceptance - agentNode public export, design backfill`。

---

## Self-Review 记录

- **Spec 覆盖**：§4.3 agentNode（T2）、§4.6 services/compile 报错（T2）、§6.5/6.6 agent 分支（T2——writeTo 校验已存在无需动）、§7.2 重试（既有引擎路径 + T2 markRetryable 测试）、§7.3 杀树（T3）、§9.1 接口（T1）、§9.2 全部要点（T3 逐条 + T4 文档）、§13 M3 验收（T4）——无缺口。
- **类型一致性**：AgentExecutor/PiSubprocessConfig 签名在 T1 定义后 T2/T3/T4 引用逐字一致；bindAgentNode/agentExecutorOf/createPiSubprocessExecutor 的模块内导出名在各任务一致。
- **Review Focus → 测试映射**：1→T3②（stdin-echo）；2→T3③；3→T3④；4→T3⑤；5→T3①。全部有归属。
- **比例**：计划正文约代码量 1/3，步骤均可"写一个合理的东西"收口。
