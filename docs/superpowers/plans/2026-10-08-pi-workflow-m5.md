# M5 Implementation Plan — README / 示例 / 发布准备

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 M0–M4 的库变成可发布状态：构建产物 + exports map、langgraph 差异黄金用例、合同审查完整示例（离线可跑）、英文 README、发布手册，npm pack 临时安装冒烟全绿——真实 `npm publish` 留给维护者手动执行。

**Architecture:** 新增构建管线（tsc emit → dist/，prepack 自动构建），公开面增加 `./runtime` 子入口（barrel：5 个公开类型 + 2 个可用性探测值）；示例经 npm self-reference 导入本包（先 build）；黄金用例是 §11 差异表的逐行漂移哨兵。不改任何 M0–M4 运行时行为。

**Tech Stack:** TypeScript 7.0.2（NodeNext/ES2022，TS strict）、vitest 5、biome、Node ≥22 原生类型剥离（示例运行零新依赖）。

**Spec:** docs/design.md（§4.1 合同审查示例 / §9.5 发布形态 / §11 差异清单 / §12 黄金用例 / §13 M5 行 / §14 开放问题 1）+ 本计划冻结裁定 D30–D37。

## Global Constraints

- ESM-only；Node ≥ 22；TS strict/ES2022/NodeNext。
- **runtime 依赖不变**：dependencies 仍只有 typebox；不新增任何 devDep（示例用 Node 原生能力运行）。
- core（src/core/）零 I/O 不破坏；`@earendil-works/*` 只能被 src/runtime/ 动态 import（§9.5）。
- 公开面 `"."` 入口：值 21 个不变、类型 25 个不变（tests/public-exports.test.ts 钉死）；**新公开面 `"./runtime"` 入口由 T1 建立**（值 +2：isPiAiAvailable/isPiSdkAvailable；类型 +5）。
- M0–M4 既有测试文件零改动，唯一例外（预裁定）：tests/public-exports.test.ts 追加 runtime 入口断言组（授权先例同 M1–M4）。
- 提交身份维持现状（zhangjinglun <zhangjinglun@local>，用户稍后自行推 GitHub 时再定）；commit trailer `Co-Authored-By: Claude Code <noreply@anthropic.com>`。

## 冻结裁定（用户 2026-10-08 决策 + 计划裁定）

- **D30 包名与元数据（用户定）**：name `@wangchengshi/pi-workflow`；version `0.1.0`（design 目标 v0.1，1.0.0 是脚手架占位）；author `wangchengshi`（不加邮箱，避免 npm 公开页暴露）；description `Deterministic langgraph-style workflow orchestration for the pi coding agent framework`；keywords `["pi","workflow","langgraph","agent","orchestration","state-machine"]`；license 维持 `ISC`；repository `https://github.com/wangchengshi/pi-workflow`（**GitHub 用户名假设，prepublish 检查单要求维护者确认**）；`sideEffects: false`（模块加载无副作用，日志仅在 compile/run 调用时发生）。
- **D31 发布面（§9.5 逐项）**：`exports` map 三条——`"." → { types: "./dist/index.d.ts", import: "./dist/index.js" }`；`"./runtime" → { types: "./dist/runtime/index.d.ts", import: "./dist/runtime/index.js" }`；`"./package.json" → "./package.json"`；`files: ["dist", "README.md"]`（docs/、src/、tests/ 不进包）；**不设** main/types/module 顶层字段（Node ≥22 门槛建立在 exports 上）。
- **D32 构建管线**：新建 `tsconfig.build.json`（extends ./tsconfig.json；include 只 ["src"]；outDir "dist"；declaration true；declarationMap false；noEmit false）；`scripts.build = "tsc -p tsconfig.build.json"`；`scripts.prepack = "npm run build"`（pack/publish 永远带最新 dist）；`scripts.prepublishOnly = "npm run typecheck && npm run lint && npm test && npm run build"`；`.gitignore` 追加 `dist/`。
- **D33 runtime barrel**：新建 src/runtime/index.ts——`export type { AgentExecutor, CompleteFn, TokenUsage, PiSubprocessConfig, PiSdkConfig }`（各自来源模块）+ `export { isPiAiAvailable } from "./llm-pi-ai.js"` + `export { isPiSdkAvailable } from "./pi-sdk.js"`；**createPiSubprocessExecutor / createPiSdkExecutor 维持内部导出不进 barrel**（M2/M4 裁定不变）。
- **D34 发布就绪验证（不真实 publish，用户手动）**：SDD 工作区脚本完成——①`npm pack` 产物解包核结构（dist/ 与 README 在、src/tests/docs 不在）；②临时目录 `npm init -y` + `npm install <tgz>` + `node -e "import('@wangchengshi/pi-workflow').then(...)"` 离线跑一个 fnNode 图断言 state；③prepublishOnly 全链路实跑。真实 publish 流程写在 docs/publishing.md，由维护者执行。
- **D35 示例运行形态**：examples/contract-review.ts 经 **npm self-reference** `import { ... } from "@wangchengshi/pi-workflow"`（exports 已定义，须先 `npm run build`；README 与示例头注释写明前置）；**mock 默认**——`PI_WORKFLOW_EXAMPLE_MOCK` 缺省即 mock：llm 节点经 `compile({ services: { complete: mockComplete } })` 离线跑，agent 节点用自定义 executor 函数（顺带展示 D20 扩展点）；设 `=0` 走真实 pi（需凭据，README 说明）。`logDir` 指向 `os.tmpdir()/pi-workflow-example-runs`（repo 零污染）。
- **D36 示例数据冻结**：fixtures/sample-contract.md 短中文合同三条款——c1 高风险（约定"甲方可随时无条件解除合同"类条款）、c2 低风险、c3 低风险；mockComplete 按 prompt 中节点关键词返回与 fixture 对应的 schema 合法 JSON（extract → 三条款、review → severity 按 clauseId 映射 c1=high 其余 low、precedent_check → 报告对象），保证 gate 扇出路径（c1 → precedent_check → aggregate）真实走到。
- **D37 黄金用例形态**：tests/langgraph-differences.test.ts 对 §11 十行每行一个轻量用例（v1 行为侧），首跑即绿 = 契约锁（M3 D3 锁先例）；深度行为已在 engine.* 套件覆盖的行，用例内注释指向对应测试文件；"功能缺席"行（checkpoint/interrupt/store、path_map、静态 Send 边、concurrencyKey）用 API 缺席或错误路径断言。

## Review Focus

1. **exports types 条件错**（types 指向不存在的 .d.ts、或 import 条件指到 src）→ 消费者 import 即断——T1 冒烟实 import dist 产物 + T5 临时安装冒烟双网。
2. **files 白名单漏 dist 子目录**（如漏 dist/runtime → `./runtime` 子入口 404）→ T5 解包结构核逐目录点名。
3. **prepublishOnly 漏 build 或顺序错** → 发布旧 dist：T5 全链路实跑 + prepack 兜底（D32）。
4. **示例在未 build 时运行** → self-reference 解析失败的晦涩报错：示例头注释 + README 前置说明 + 报错文案自检（T3）。
5. **黄金用例测错方向**（把 v1 行为断言成 langgraph 行为）→ T2 评审逐用例对照 §11 表推演。

---

### Task 1: 构建管线与发布面

**Files:**
- Modify: `package.json`（D30 元数据全套 + D31 exports/files + D32 三 script）
- Create: `tsconfig.build.json`（D32）
- Create: `src/runtime/index.ts`（D33 barrel）
- Modify: `.gitignore`（追加 `dist/`）
- Modify: `tests/public-exports.test.ts`（**预裁定例外**：追加 runtime 入口断言组——`Object.keys(runtimeApi)` 精确集合 = [isPiAiAvailable, isPiSdkAvailable] 两值 + 5 类型名逐一类型位置引用；"." 入口现有断言零改动）
- Test: `npm run build` 产物冒烟（SDD 工作区脚本，不入库）

**Interfaces:**
- Consumes: src/runtime/ 现有导出（M2–M4）。
- Produces: dist/ 产物布局（dist/index.js + dist/runtime/index.js + 各 .d.ts）——T3 self-reference、T5 pack 验收依赖。

- [ ] **Step 1:** package.json 按 D30/D31/D32 落全部字段；确认 typebox 依赖与 peer 块零改动。
- [ ] **Step 2:** 先写 public-exports 的 runtime 入口断言（红：barrel 不存在）→ 建 src/runtime/index.ts（D33）→ 绿。
- [ ] **Step 3:** `npm run build` → dist/ 布局核（index.js/index.d.ts/runtime/index.js/runtime/index.d.ts）；SDD 工作区脚本 `node -e "import('<abs>/dist/index.js').then(m => console.log(typeof m.StateGraph))"` 输出 function。
- [ ] **Step 4:** 全量验证：test（435 + 新增）/typecheck/lint 净；`git check-ignore dist` 确认忽略生效。
- [ ] **Step 5:** Commit `feat: M5 T1 - build pipeline, exports map, runtime barrel (D30-D33)`。

### Task 2: langgraph 差异黄金用例

**Files:**
- Create: `tests/core/langgraph-differences.test.ts`（§11 十行 → 10 用例，D37）

**Interfaces:**
- Consumes: StateGraph/Send/START/END/fnNode 公开 API（现有）。

- [ ] **Step 1:** 逐行写 10 用例（§11 表为唯一语义来源；深度覆盖行注释指向 engine.*.test.ts；缺席行用 API 缺席/错误路径断言）。用例名 `diff N: <差异要点>`。
- [ ] **Step 2:** `npx vitest run tests/core/langgraph-differences.test.ts` 10/10 绿（首跑即绿 = 契约锁；若有红，先核对是 §11 语义读错还是实现漂移，漂移即停手上报 BLOCKED）。
- [ ] **Step 3:** 全量验证净（435 + 10 = 445）。
- [ ] **Step 4:** Commit `test: M5 T2 - langgraph difference golden cases (design §11)`。

### Task 3: 合同审查完整示例

**Files:**
- Create: `examples/contract-review.ts`（§4.1 图形态逐段忠实 + D35 mock/真实双模 + D36 fixture）
- Create: `examples/fixtures/sample-contract.md`（D36 三条款）

**Interfaces:**
- Consumes: T1 dist 产物（self-reference import "@wangchengshi/pi-workflow"）；llmNode services.complete 注入点（M2）；agentNode 自定义 executor 形态（D20）。

- [ ] **Step 1:** fixture 落 D36 三条款。
- [ ] **Step 2:** 示例主体按 §4.1 图形态（load_doc → extract → 条件边 Send 扇出 review → gate 风险分级路由 → precedent_check → aggregate；channels append）；mock 模式（D35/D36）；头注释写运行前置（`npm run build` 后 `node examples/contract-review.ts`；`PI_WORKFLOW_EXAMPLE_MOCK=0` 切真实）。
- [ ] **Step 3:** build 后 SDD 工作区实跑 mock 模式：输出含 finalReport 与 c1 高风险判定；run 日志落在 tmpdir（repo 无 .pi-workflow/ 泄漏）。
- [ ] **Step 4:** 全量验证净（示例不进 vitest；445 不变）。
- [ ] **Step 5:** Commit `feat: M5 T3 - contract-review example with offline mock mode (design §4.1)`。

### Task 4: README（英文）+ 发布手册

**Files:**
- Modify: `README.md`（现空文件，全量重写，英文为主）
- Create: `docs/publishing.md`（维护者发布手册，中文——读者是维护者本人）

**Interfaces:**
- Consumes: T1 exports/files、T3 示例路径。

- [ ] **Step 1:** README 按 D35 结构：pitch（一句英文定位 + 可选一句中文）→ Install（npm i @wangchengshi/pi-workflow；Node ≥22；optional peers 说明）→ Quick start（fnNode 图，可直接粘贴运行）→ Core concepts（StateGraph/addNode/addConditionalEdges/Send/reducers/channels/预算/取消/确定性）→ Node types（fn/llm/agent；executor 三形态；subprocess vs sdk 配置示例）→ Observability（JSONL run log、logDir、脱敏）→ Differences from langgraph（§11 十行英译表）→ Example（T3 路径与前置）→ License。README 中出现的 API 名与代码示例逐个与 src/index.ts 导出核对。
- [ ] **Step 2:** docs/publishing.md（D34）：首次发布全流程——npm 账号/2FA → `npm login` → `npm whoami` 核 scope → `npm publish --access public`（**scoped 包首次必须显式 public，否则 402**）→ 网页核验 → 后续版本 `npm version patch|minor` 流程 → GitHub 关联（repository 字段确认 + `git remote add origin` + push + npm 页 Repository 链接生效）。
- [ ] **Step 3:** 全量验证净。
- [ ] **Step 4:** Commit `docs: M5 T4 - README (EN) and maintainer publishing guide`。

### Task 5: 发布就绪终验 + design 回填

**Files:**
- Test: SDD 工作区发布就绪脚本（D34 三步，不入库）
- Modify: `docs/design.md`（§13 M5 行完成标注；§14 开放问题 1 标注"已决：@wangchengshi/pi-workflow（D30），裸名已被 VSCode 插件占用"）

- [ ] **Step 1:** `npm pack` → 解包 SDD 工作区 → 结构逐目录核（dist/、dist/runtime/、README.md 在；src/tests/docs/examples 不在）。
- [ ] **Step 2:** 临时目录安装 tgz + node import 冒烟（离线 fnNode 图 state 断言）+ `node -e import('./runtime')` 子入口冒烟。
- [ ] **Step 3:** `npm run prepublishOnly` 全链路实跑绿。
- [ ] **Step 4:** design.md 回填两处（M1–M4 行同款格式）；`npm pack --dry-run` 终核无 files 意外。
- [ ] **Step 5:** 全量验证净；仓库无 .pi-workflow/ 泄漏。Commit `feat: M5 acceptance - publish-ready package, design backfill`。

---

## Self-Review 记录

- **Spec 覆盖**：§13 M5 行三验收（npm pack 可安装 → T5；示例开箱即跑 → T3 mock 默认；黄金用例全绿 → T2）+ §9.5 发布形态（T1）+ §4.1 示例（T3）+ §11（T2/README）+ §14 开放问题 1（T5 回填关闭）——无缺口。
- **类型一致性**：barrel 五类型名与 src/runtime/ 各模块导出名逐一核对过（AgentExecutor/CompleteFn/TokenUsage ← executor.ts；PiSubprocessConfig ← pi-subprocess.ts；PiSdkConfig ← pi-sdk.ts）；self-reference 依赖 name = @wangchengshi/pi-workflow（D30）与 exports（D31）同时成立。
- **Review Focus → 测试映射**：1→T1 冒烟 + T5 安装冒烟；2→T5 结构核；3→T5 链路实跑 + prepack；4→T3 头注释 + README；5→T2 评审推演。全部有归属。
- **比例**：计划正文约为 T3 示例 + T4 README 交付量的 1/3；冻结裁定承担全部精确值（包名/exports/fixture 映射），步骤均可一步收口。
