# M4: pi SDK 适配器（agent 节点进程内运行时）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 节点 `executor: "sdk"` 可用——进程内经 `@earendil-works/pi-coding-agent` 跑 agent 任务，判定/取消/usage 与 subprocess 路径同构。

**Architecture:** `src/runtime/pi-sdk.ts` 镜像 M3 pi-subprocess / M2 llm-pi-ai 的适配器模式（物理隔离区、懒动态 import、进程缓存、可行动错误）；`graph.ts` compile 期接线替换 D20 的 "not implemented until M4" 占位 issue；共享 helper（usage 零填映射、peer 探测）从两个既有适配器中抽取复用。

**Tech Stack:** TS strict / ESM-only / Node ≥22；typebox（唯一运行时依赖不变）；vitest；`@earendil-works/pi-coding-agent` ^1.0.4（optional peer）。

**Spec:** docs/design.md §4.6（services.agent.sdk）、§9.1（AgentExecutor）、§9.3（sdk 适配器——本计划将其三点展开为可实施裁定）、§13（M4 行 + 开放问题 4）。SDK API 面已在规划期实证（npm pack 1.0.4 全量 .d.ts + 1.1.0 关键签名 diff 一致），无需 M0 类 spike。

**BASE:** main @ 722ef37，分支 `feat/m4-sdk-adapter`。

## Global Constraints

- ESM-only；TS strict / ES2022 / NodeNext；Node ≥22。
- 运行时依赖零新增（typebox 唯一）；`@earendil-works/pi-coding-agent` 进 package.json：`peerDependencies: {"^1.0.4"}` + `peerDependenciesMeta.optional: true` + `devDependencies: "^1.0.4"`（逐字镜像 M2 pi-ai 先例）。
- 该包**只允许**被 `src/runtime/pi-sdk.ts` 接触：运行期只动态 import，类型面只 `import(...)` 类型查询或 `import type`（编译期擦除）。
- core 零直接 I/O 不变；`node:child_process` 仍只出现在 pi-subprocess.ts。
- 公开面：**值 21 不变**（`createPiSdkExecutor`/`isPiSdkAvailable` 不进 index.ts——镜像 M2 `defaultPiAiComplete` 内部先例）；类型 24→25（+`PiSdkConfig`）。
- 测试 append-only；例外必须披露（本计划预授权的例外见"预裁定例外"）。
- commit trailer：`Co-Authored-By: Claude Code <noreply@anthropic.com>`。

## 冻结裁定（D24–D29，预裁定，评审以逐字为准）

- **D24 判定同构**：`prompt()` resolve 后取 `session.messages` 中**最后一个** `role === "assistant"` 的消息，verdict 与 pi-subprocess 的 `verdictOf` 逐类同构：`stopReason === "stop"` → 成功，输出 = `content` 中 `type === "text"` 块 join `"\n"`（与 M3 JSONL 解析器同规则）；`"error"` → 抛 `pi agent failed: <errorMessage>`（原文保留，D3 可匹配）；`"aborted"` → 抛 `name = "AbortError"` 的 Error；其他值 → 抛 `pi agent failed: unsupported stopReason "<value>"`；找不到 assistant 消息 → 抛 `pi agent produced no assistant message`。`req.schema` 忽略（D22：schema 在 handler 层，适配器回原文）。
- **D25 会话生命周期**：每次 executor 调用 `SessionManager.inMemory()`（不落 session 文件，对齐 CLI `--no-session`）+ `finally { session.dispose() }`（成功/失败/abort/verdict 全路径必达）。不做会话复用——design §9.3 既定"每节点创建独立会话，结束即弃"；§13 开放问题 4（会话复用）就此关闭：每节点新会话，复用不做。
- **D26 重试归属**：pi 内置 auto-retry（`settings.retry.enabled` 默认 **true**、maxRetries 3、baseDelayMs 2000——1.0.4 实测默认值）**不关闭、不配置**：与 subprocess 路径行为一致（CLI 同样读 settings，M0 实测即含此行为）；引擎 D3 重试在 pi 内部重试耗尽后才生效；引擎 `timeoutMs` 仍约束单次尝试总时长（abort 会打断 pi 内部重试）。接受二者的乘法效应，design §9.3 注明。
- **D27 model 解析**：串 `"<provider>/<id>"` 切分同 D13（**第一个** `/`）；显式 `ModelRuntime.create()` 解析——`PiSdkConfig.agentDir` 给定 → `authPath: <agentDir>/auth.json`、`modelsPath: <agentDir>/models.json`；未给定 → 全默认（等价 session 内部默认，含 `models.json` 自定义 provider）；`allowModelNetwork` 缺省 false（离线确定性）。命中 → 该 runtime 与解析出的 model **同传** `createAgentSession`（单一 runtime 实例，不双建）；串缺省（`req.model ?? config.defaultModel` 均无）→ 不传 `model`（session 默认选型）；形状非法或 `getModel` 未命中 → 可行动错误（作者错误，不落 D3 族），前缀 `pi sdk adapter: `。
- **D28 版本与可用性**：peer 区间 `^1.0.4`（1.0.4 与 1.1.0 的 createAgentSession/ModelRuntime.create/SessionManager.inMemory/getModel/prompt/abort/dispose 签名已 diff 核实一致）。`isPiSdkAvailable(): boolean` 用共享探测（机制同 M2：`createRequire().resolve` 失败退 `import.meta.resolve`——该包 exports map 同样无 `require` 条件），结果**进程缓存**、**永不抛**。compile 期（T3）不可用 → issue；运行期动态 import 失败仍抛可行动错误（含原错 cause）。`resetPiSdkCacheForTests()` 同时重置 import 缓存与可用性缓存。
- **D29 tools 与 usage**：`req.tools && req.tools.length > 0` → `CreateAgentSessionOptions.tools`（allowlist）；空数组/缺省 → 不传（pi 默认工具集）——与 722ef37 空数组裁定同口径。usage：D21 零填映射（缺失数字键 0 填；cost 仅源带时进；`cacheWrite1h`/`reasoning`/`raw*` 不转发）抽到共享 `src/runtime/usage.ts`，pi-subprocess.ts **平移复用**（行为逐字不变），llm-pi-ai.ts **不动**（其直取版语义独立，见"预裁定例外"）。

## Review Focus（最可能咬人的五类输入 → 归属测试）

1. **abort 竞态**（创建期 abort / prompt 中 abort / pi 内部重试中 abort）——期望：全路径快速 AbortError、dispose 必达、无会话泄漏。→ T2 取消组。
2. **dispose 必达**——verdict 抛错路径也不得漏。→ T2（fake 记数 dispose 调用）。
3. **prompt resolve 后可读状态**——`prompt()` 含 pi 内部重试、resolve 即完成；用例钉"resolve 后 messages 里能取到最后 assistant 消息"，不依赖 `agent_settled`。→ T2 成功路径组。
4. **空数组/缺省 tools**——`tools: []` 不得进 options（D29）。→ T2 参数映射组。
5. **peer 缺失双路径**——compile issue 与运行期错误都可行动、探测缓存不重复 fs 解析。→ T2/T3。

## 预裁定例外（append-only 的授权修改点）

1. `tests/core/graph.compile.test.ts` 中钉住 D20 旧消息 `...sdk adapter is not implemented until M4` 的既有断言——本计划将其更新为新消息（D20 演进，性质同 M3 计数断言更新），实现者披露、评审追认。
2. `tests/public-exports.test.ts` 头注释类型计数 24→25 + 值/类型集合数组（本任务授权修改点，M3 先例）。

---

### Task 1: 共享 helper 抽取 + PiSdkConfig + 依赖声明

**Files:**
- Create: `src/runtime/usage.ts`、`src/runtime/peer-resolve.ts`、`src/runtime/pi-sdk.ts`（**仅类型占位**——文件头注释 + `PiSdkConfig`，镜像 M3 T1 的 pi-subprocess.ts 占位先例；实现归 T2）
- Modify: `src/runtime/pi-subprocess.ts`（usage 零填实现平移出）、`src/runtime/llm-pi-ai.ts`（probe 平移出）、`src/core/types.ts`（`sdk?: any` → `sdk?: PiSdkConfig`，去 biome-ignore）、`src/index.ts`（+`export type { PiSdkConfig } from "./runtime/pi-sdk.js"`）、`package.json`
- Test: Create `tests/runtime/usage.test.ts`、`tests/runtime/peer-resolve.test.ts`；Modify `tests/public-exports.test.ts`（append 类型位 + 头注释 24→25）

**Interfaces:**
- Produces: `toTokenUsage(usage: 结构化 unknown): TokenUsage`（零填，T2 消费）；`probePeerPackage(pkg: string): boolean`（T2 消费）；`PiSdkConfig` 类型（T2/T3 消费）。
- 行为红线：398/398 全绿不动；llm.test.ts 15 条与 pi-subprocess.test.ts 23 条零改动。

- [ ] **Step 1:** `usage.ts`：从 pi-subprocess.ts **逐字抽出**零填 `toTokenUsage`（含 cost 条件转发、D21 注释），pi-subprocess.ts 改 import；先跑 `npm test` 确认 398 不动。
- [ ] **Step 2:** `peer-resolve.ts`：从 llm-pi-ai.ts **逐字抽出**两步探测为 `probePeerPackage(pkg)`（含 `import.meta.resolve` 兜底与注释缘由），llm-pi-ai.ts 的 `probePiAi()` 改为薄委托（`isPiAiAvailable` 签名与缓存行为不变）。
- [ ] **Step 3:** 两个新 helper 的单测（usage：全键/缺键 0 填/cost 有无/多余键不转发；peer-resolve：mock `node:module` 两分支）。先写看红。
- [ ] **Step 4:** `PiSdkConfig` 定稿（见下）进 types.ts 或 pi-sdk.ts；`types.ts` 的 `sdk?: any` 换成 `sdk?: PiSdkConfig` 并删 biome-ignore；index.ts +1 类型导出；public-exports append + 头注释。
- [ ] **Step 5:** package.json 三处（peer/meta/devDep）+ `npm install`（装到 1.1.0）；`npm view` 确认无 lockfile 意外。
- [ ] **Step 6:** 全量验证（398+新增全绿、typecheck/lint 净）→ commit `feat(runtime): M4 T1 - shared usage/peer-probe helpers, PiSdkConfig type (D28/D29)`。

```ts
/** PiSdkConfig（§4.6；D25/D27 冻结形状） */
export type PiSdkConfig = {
	/** pi agent 目录（auth.json/models.json 所在）。缺省 = pi 默认（PI_CODING_AGENT_DIR 或 ~/.pi/agent）。 */
	agentDir?: string;
	/** 会话工作目录（资源发现与内置工具路径）。缺省 = process.cwd()。 */
	cwd?: string;
	/** 节点未声明 model 时的兜底模型串 "<provider>/<id>"（D23 优先级：cfg.model ?? defaultModel）。 */
	defaultModel?: string;
};
```

### Task 2: pi-sdk.ts 适配器

**Files:**
- Create: `src/runtime/pi-sdk.ts`、`tests/runtime/pi-sdk.test.ts`

**Interfaces:**
- Consumes: T1 的 `toTokenUsage`/`probePeerPackage`、`PiSdkConfig`、`AgentExecutor`（executor.ts）。
- Produces: `createPiSdkExecutor(config: PiSdkConfig): AgentExecutor`；`isPiSdkAvailable(): boolean`；`resetPiSdkCacheForTests()`——均为模块内导出（不进 index.ts），T3 消费前两个。

**实现冻结点（执行细节以此为准）：**

- **加载器**：懒动态 `import("@earendil-works/pi-coding-agent")`，单次、进程缓存、**含失败缓存**（重装依赖需重启进程，同 M2 口径）；失败消息 `pi sdk adapter: could not load "@earendil-works/pi-coding-agent" — install it (npm i @earendil-works/pi-coding-agent) to use the sdk executor: <messageOf>`（cause 保留）。`isPiSdkAvailable()` 独立缓存（`available ??= probePeerPackage(PKG)`，永不抛）。
- **executor 调用流程**（顺序冻结）：① `req.signal.aborted` 预检 → AbortError（不建 session，镜像 M3 回归锁）；② 加载 sdk + `ModelRuntime.create(D27 选项)` + D27 model 解析；③ `createAgentSession({ cwd, agentDir, modelRuntime, model?, tools?(D29), sessionManager: SessionManager.inMemory() })`；④ **创建后**再查 `req.signal.aborted` → dispose + AbortError（创建期 abort，创建本身不可取消）；⑤ `req.signal` 挂 `once` abort 监听 → `void session.abort()`，`await session.prompt(req.task)`（resolve 即完成，含 pi 内部重试，D26/D24）；finally 移除监听；⑥ signal.aborted → AbortError（kill-then-reject 同构）；⑦ D24 verdict；⑧ `finally { session.dispose() }`（②–⑧ 任一步抛出都必达；②③ 阶段抛出时 session 可能未建成——dispose 前判空）。
- **abortError(detail?)**：`name = "AbortError"` 普通 Error，消息 `pi sdk agent aborted` / 带 detail 冒号拼接（镜像 M3 abortError，不落 D3 族）。
- **类型面**：只 `import("@earendil-works/pi-coding-agent")` 类型查询 + 结构化最小接口（assistant 消息只读 `role/content/stopReason/errorMessage/usage`，与 M3 JSONL 解析器同口径），不深引 pi-agent-core 类型。

**测试（vi.mock 假 SDK，M2 llm-pi-ai.test.ts 先例）：**

`vi.mock("@earendil-works/pi-coding-agent", ...)` 顶替 barrel：fake `createAgentSession`（返回可编程 FakeSession）、`SessionManager.inMemory()` 记数、`ModelRuntime.create` 返回可编程 fake runtime（`getModel` 命中/未命中）。FakeSession：`prompt` 可编程（resolve 值/抛错/hang 直至 abort）、`abort()` 翻转状态并使 prompt resolve、`dispose()` 记数、`messages` 可编程。每个用例经 `resetPiSdkCacheForTests()` + 动态 re-import 拿干净模块（M2 :367 先例）。七组用例（先写看红）：

1. 成功文本路径：prompt resolve → messages 末尾 assistant stopReason "stop" → `{ output, usage }`（零填断言）；
2. schema 模式透传：req.schema 原样忽略、output 为原文（D22）；
3. verdict 三分支：`"error"` → `pi agent failed: <msg>`；`"aborted"` → AbortError；`"length"` → `unsupported stopReason "length"`；无 assistant → `pi agent produced no assistant message`；
4. 取消组：预 abort（不建 session、createAgentSession 未被调、dispose 未调）；创建期 abort（create 被 Info、prompt 未调、dispose 恰 1 次）；prompt 中 abort（fake prompt hang，signal 触发 → fake.abort 被调 → AbortError，dispose 恰 1 次）；
5. model 解析：合法串 → fakeRuntime.getModel 以 `(provider, id)` 被调、runtime+model 同传 createAgentSession；缺省 → 不传 model 且 ModelRuntime 仍建（D27）；非法形状/未命中 → 可行动错误、**不**调 createAgentSession；
6. tools 映射：`["read"]` → options.tools 同引用；`[]`/缺省 → options 无 tools 键（D29）；
7. 可用性：`isPiSdkAvailable` mock 探测 true/false 各一 + 缓存（第二次调用不再探）；加载失败 → 可行动错误 + 失败缓存（re-import 后仍命中缓存）。

- [ ] **Step 1:** 写七组用例 → 红（模块不存在）。
- [ ] **Step 2:** 实现 pi-sdk.ts（按冻结点）。
- [ ] **Step 3:** 绿 + 全量验证 → commit `feat(runtime): M4 T2 - pi sdk adapter executor (D24-D29)`。

### Task 3: compile 接线（D20 sdk 分支落地）

**Files:**
- Modify: `src/core/graph.ts`（resolveAgentExecutors 的 sdk 分支）
- Test: `tests/core/graph.compile.test.ts`（append + 预裁定例外 1 的既有断言更新）

**Interfaces:**
- Consumes: T2 `createPiSdkExecutor`/`isPiSdkAvailable`（模块内导入，graph.ts 现有 subprocess 同款接线）。

- [ ] **Step 1:** append 用例（先红）：`executor:"sdk"` + `services.agent.sdk` 缺省 → issue 逐字 `node "writer" (kind "agent") declares executor "sdk" but services.agent.sdk is not configured (an empty object {} is enough to accept defaults)`（镜像 subprocess 消息）；sdk `{}` + mock 可用 → compile 过、无 issue（不 run）；sdk 配好但 mock `isPiSdkAvailable()===false` → issue 逐字 `node "writer" (kind "agent") declares executor "sdk" but @earendil-works/pi-coding-agent is not installed — install it (npm i @earendil-works/pi-coding-agent) to use the sdk executor`（先配置后可用性；vi.mock `src/runtime/pi-sdk.js` 模块控制探测与 executor）。更新例外 1 的既有断言（旧 M4 占位消息 → 上述新消息）。
- [ ] **Step 2:** graph.ts 接线（镜像 subprocess 分支 ~20 行）：配置缺省 → issue；可用性 false → issue；否则 `createPiSdkExecutor(services.agent.sdk)` 放行绑定。
- [ ] **Step 3:** 绿 + 全量验证 → commit `feat(core): M4 T3 - wire sdk executor branch in compile (D20 evolution)`。

### Task 4: 收尾 + 真实 SDK 冒烟

**Files:**
- Modify: `docs/design.md`（§13 M4 行完成标注；§9.3 补 D24–D26 要点句：判定与 subprocess 同构/每节点 inMemory 新会话结束即弃/pi 内置重试与引擎重试的乘法效应注明；§13 开放问题 4 标注"已决：每节点新会话（D25）"）
- Test: 全量验证 + 真实 SDK 冒烟（脚本在 SDD 工作区，不入库）

**Interfaces:**
- Consumes: T1–T3 全部交付。

- [ ] **Step 1:** design.md 回填（M1/M2/M3 行同款格式）。
- [ ] **Step 2:** 真实 SDK 冒烟：脚本 `<SDD 工作区>/smoke-m4.mjs`——devDep 已装（1.1.0），单 agent 节点图（`executor: "sdk"`，`services.agent.sdk: {}`），task "只回复两个字：好的"（schema 缺省）+ 一个 schema 模式用例；`compile + run`，打印产出与 `node_finished.usage`；**logDir 重定向 SDD 工作区**（M2 默认日志开启，防仓库污染）；Node 类型剥离不解析 .js→.ts import → 用 `tsc --ignoreConfig` 编译到 SDD 工作区 `smoke-dist-m4/` 运行（M3 先例，零仓库改动）；结果原文记 `<SDD 工作区>/smoke-m4-result.md`。前提：真实凭据可用（~/.pi 或 PI_CODING_AGENT_DIR；外网走代理 127.0.0.1:7897）。**BLOCKED 则停止交控制器，不伪造结果。**
- [ ] **Step 3:** 全量验证：npm test 全绿、typecheck/lint 净、git status 干净、仓库无 `.pi-workflow/`。
- [ ] **Step 4:** commit `feat: M4 acceptance - sdk executor wiring, design backfill`。

---

## Self-Review 记录

- **Spec 覆盖**：§9.3 三点（进程内/每节点独立会话/abort 取消）→ T2（D24/D25）+ T4 冒烟；§4.6 sdk 配置 → T1 类型 + T3 接线；§13 M4 行（进程内跑通 + optional peer 生效）→ T3 + T4 + T1 package.json；开放问题 4 → D25 关闭 + T4 文档。无缺口。
- **类型一致性**：`PiSdkConfig` 三字段在 D27（agentDir/cwd 消费）与 D23（defaultModel）各有着落；`createPiSdkExecutor(config: PiSdkConfig): AgentExecutor` 与 graph.ts subprocess 分支签名同构；`probePeerPackage(pkg)`/`toTokenUsage` 与被平移实现逐字同参。
- **Review Focus → 测试映射**：1→T2 取消组三用例；2→T2 dispose 记数；3→T2 成功路径；4→T2 参数映射；5→T2 可用性组 + T3 compile 用例。全部有归属。
- **比例**：计划正文约为 T2 实现 + 测试量的 1/3；冻结点承担全部"精确值"，步骤均可一步收口。
