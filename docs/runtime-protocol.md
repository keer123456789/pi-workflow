# pi 子进程调用协议（M0 spike 冻结版）

> 状态：**已冻结**（2026-10-07，M0 spike 实测）。M3 subprocess 适配器以本文档为准；此后协议变更视为破坏性变更。
>
> 证据规则：
> - 本文所有"实测"结论均来自本机真实命令输出，命令与输出原文贴出（超长的系统提示词行做截断并标注）；
> - 少数解释性内容来自 pi-mono 源码阅读（v1.0.4，`C:/Users/zhangjinglun/AppData/Local/Temp/pi-research/pi-mono`），一律标注"（源码解读）"，**不作为协议依据**；
> - 被测对象为 npm 包 `@earendil-works/pi-coding-agent`，CLI 版本 **1.0.4**。

- 探测日期：2026-10-07
- 测试平台：Windows 10 IoT Enterprise LTSC 2021 (10.0.19044) + git-bash（POSIX sh）
- pi 安装位置：`%APPDATA%/npm/` 下 `pi`（sh，469B）/`pi.cmd`/`pi.ps1` 三个 shim，实体在 `%APPDATA%/npm/node_modules/@earendil-works/pi-coding-agent`
- 实测工作目录：`%TEMP%/pi-spike-cwd`（隔离 scratch 目录；会话不落盘、cwd 无新文件，见 ③.6）
- 环境备注：本机 `~/.pi/agent` 无已登录凭据，默认 provider（anthropic）调用返回 403；成功路径通过 `models.json` 配自定义 provider（`PI_CODING_AGENT_DIR` 重定向）实测（见 ③.7 与 ④.5）。协议结论不依赖具体 provider/model。

---

## ① 版本探测命令与输出格式

```
$ pi --version
1.0.4
EXIT=0
```

字节级验证（`od -c`）：`1 . 0 . 4 \n` —— 单行裸 semver，**无包名前缀、无附加文案、LF 结尾**；stderr 0 字节。

```bash
# 实测
SCRATCH="C:/Users/zhangjinglun/AppData/Local/Temp/pi-spike-cwd"; cd "$SCRATCH"
pi --version > version.out 2> version.err; echo "EXIT=$?"   # EXIT=0
od -c version.out        # 1 . 0 . 4 \n
wc -c < version.err      # 0
```

- 解析建议：`/^\d+\.\d+\.\d+$/` 匹配 stdout 去空白后的整行；非 0 退出或解析失败 → 适配器报"pi CLI 未安装或版本不支持"。
- 相关：`pi --list-models` 可用（实测输出含表头 + 每模型一行，如 `ark  glm-5.3-flash  128K  16.4K  no  no`），供排障用；**模型名不存在时**的行为见 ④.6。

## ② spawn 命令行模板

实测可用的调用形态（git-bash）：

```bash
# 形态 A：prompt 走 argv（仅适合短 prompt；必须把 stdin 关掉/给 EOF）
pi --mode json -p --no-session [--model <provider/model>] [--tools <a,b,c>] "TASK TEXT" < /dev/null

# 形态 B：prompt 走 stdin（推荐；stdin 必须写完即关闭）
printf '%s' "TASK TEXT" | pi --mode json -p --no-session [--model <provider/model>] [--tools <a,b,c>]
```

**M3 冻结模板（Node 侧，实测进程树链为 host node → cmd.exe → pi node）**：

```js
spawn("pi", ["--mode", "json", "-p", "--no-session", ...(model ? ["--model", model] : []),
             ...(tools ? ["--tools", tools.join(",")] : [])], {
  shell: true,                       // Windows 命中 %APPDATA%/npm 的 shim；实测链 cmd.exe → node.exe
  cwd: <工作目录>,                    // 实测 header.cwd 即 spawn 的 cwd
  stdio: ["pipe", "pipe", "pipe"],   // stdin：要么 write(prompt) 后 end()，要么用 "ignore" —— 绝不能保持打开不关（③.4）
})
// 取消/超时：process.kill 树用 execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"])（⑤）
```

逐参数实测依据：

| 参数 | 实测结论 |
|---|---|
| `--mode json` | 事件流模式（本 spike 全部 run 使用）；`-p` 可省（实测 F，见下） |
| `-p` / `--print` | 显式表达非交互；`--mode json` 下与不传 `-p` 行为一致（各 12 行、EXIT=0）——保留以显式 |
| `--no-session` | 会话不落盘：实测 scratch cwd 无任何新文件；**但 stdout 首行仍输出 session header**（④.1） |
| `--model <provider/model>` | 实测 `--model ark/glm-5.3-flash` 生效（事件内 `provider:"ark"`、`model:"glm-5.3-flash"`）；格式须为 `<providerId>/<modelId>` |
| `--tools <a,b,c>` | 逗号分隔白名单，实测 `--tools read` 后 system 消息 `toolsAdded` 恰为 `["read"]`（默认全量为 `["read","bash","edit","write"]`） |

`-p` 可省实测（probe F）：

```
$ echo "只回复两个字：好的" | pi --mode json --no-session
EXIT=0  lines=12  stderr_bytes=0
1: session / 2: agent_start / 3: turn_start / 4: message_start role=system ...
```

环境与进程注意（实测）：

- `shell: true` 时 Node ≥ 22 打印 `[DEP0190] DeprecationWarning: Passing args to a child process with shell option true ...`（不阻断，仅噪声）；M3 若用 cross-spawn 可避免。
- 配自定义 provider 时：`PI_CODING_AGENT_DIR=<dir>` 重定向 agent 目录，`<dir>/models.json` 形如
  `{"providers":{"ark":{"name":...,"baseUrl":"https://ark.cn-beijing.volces.com/api/coding","api":"anthropic-messages","apiKey":"$ARK_API_KEY","headers":{...},"models":[{"id":"glm-5.3-flash",...}]}}}`
  ——实测该方式全新 provider 一次配好即可用，`$ENV` 插值取到 `ARK_API_KEY`（密钥不落盘）。
- 无 anthropic 凭据但配置了唯一 provider 时，不传 `--model` 也会解析到该 provider 的模型并成功（实测 D2/E2：`provider:"ark"`、`stopReason:"stop"`）。

## ③ prompt 传递方式结论（stdin / argv / 临时文件）

**结论：stdin 受支持，是长 prompt 的唯一可靠通道（无需临时文件）。argv 在 40k 字符时被 Windows 拒绝（E2BIG），短 prompt 走 argv 可行。**

### ③.1 stdin 支持——是（实测）

```
$ echo "只回复两个字：好的" | pi --mode json -p --no-session
EXIT=0  wall=1702ms  stdout_bytes=20491  lines=12  stderr_bytes=0
```

user 消息原文到达（末尾换行被 pi 去掉）：

```
{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"只回复两个字：好的"}],"timestamp":1791359096845}}
```

同一命令换 `--model ark/glm-5.3-flash` 走完完整成功路径（EXIT=0，wall=14195ms，29 行，stderr 0 字节，stopReason `"stop"`）。

### ③.2 40k 字符 argv——失败（实测，硬阻断）

```
$ LONG=$(head -c 40000 /dev/zero | tr '\0' 'a'); echo "LONG length = ${#LONG}"   # 40000
$ pi --mode json -p --no-session "$LONG" < /dev/null
EXIT=126  stdout_bytes=0  stderr_bytes=108
--- stderr:
/c/Users/zhangjinglun/AppData/Roaming/npm/pi: line 15: /d/Program Files/nodejs/node: Argument list too long
```

失败发生在 pi 启动**之前**（shim 执行 node 时 E2BIG，stdout 0 字节、无 session header、无事件流）。Windows 命令行上限约 32k 字符，合同全文走 argv 不可靠——**与 design.md §9.2 一致，"argv 仅短 prompt"结论成立**。

### ③.3 40k 字符 stdin——成功且逐字节完整（实测）

```
$ head -c 40000 /dev/zero | tr '\0' 'a' | pi --mode json -p --no-session
EXIT=0  stdout_bytes=140410  lines=12
user text length = 40000 | all-a: true | user message_start events: 1
```

40,000 个字符**一个不少、无重复、单条 user 消息**，事件流正常走完（该次走默认 provider 的失败路径，但**投递链路**已被完整验证）。

### ③.4 stdin 必须关闭（实测，否则无限期阻塞）

反例（宿主 spawn 后 stdin 是打开且永不 EOF 的管道）：

```
host node → cmd.exe → pi node.exe 全链存活；STATUS 每 5s 一次，t=5s..40s 全部：
STATUS t=40s stdoutBytes=0 lines=0
```

40 秒内 **stdout 0 字节**、进程不退（前一轮 spike 曾观察到 ≥6 分钟同现象）。（源码解读：`readPipedStdin()` 在 stdin 非 TTY 时读到 EOF 才返回。）→ **适配器两种正确写法**：`stdio[0] = "ignore"`，或写入 prompt 后立即 `stdin.end()`。写完不关会挂死。

### ③.5 stdin 与 argv 同时给——无分隔符拼接，stdin 在前（实测）

```
$ echo "AAA" | pi --mode json -p --no-session "BBB"
user text = "AAABBB"
```

适配器二者只取其一，避免污染 prompt。

### ③.6 文件副作用（实测）

- scratch cwd 在全部 run 前后**无任何新增文件**（`--no-session` 不留会话文件）。
- agent 目录（`PI_CODING_AGENT_DIR`，缺省 `~/.pi/agent`）在首次运行时被 pi 补齐 `auth.json`、`models-store.json`（各 2 字节；pi 自身状态文件，未读取内容），与 cwd 无关。

### ③.7 认证/环境变量实测（重要，防踩坑）

| 变量 | 实测行为 |
|---|---|
| `ANTHROPIC_BASE_URL` | **不读取**：把 baseUrl 指向不可路由的 `http://127.0.0.1:9` 重跑，事件流内错误与基线**逐字相同**（`403 {"error":{"type":"forbidden","message":"Request not allowed"}}`），未出现连接类错误 → 请求根本没有发往该 URL |
| `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL`（本机值 `deepseek-flash[1m]`） | **不读取**：默认 run 的模型始终解析为内置 `provider:"anthropic"`、`model:"claude-opus-4-8"` |
| `ANTHROPIC_AUTH_TOKEN` | **会读取**：同一命令去掉该变量后（且无其他 provider 配置）pi 直接 EXIT=1，stderr：`No API key found for the selected model. Use /login to log into a provider via OAuth or API key. ...`（stdout 只剩 182 字节的 session header 行）→ 该变量是"存在凭据"的来源 |
| `HTTP(S)_PROXY` | 本轮全部成功 run（Ark，国内端点）**未使用代理**也可直连；网络受限时按需注入（spike 环境事实，非协议内容） |

企业网关场景的正确做法（实测有效）：`PI_CODING_AGENT_DIR` + `models.json` 自定义 provider（②节），而不是宿主端 `ANTHROPIC_*` 约定。

## ④ stdout 事件流字段清单（逐字段）

### ④.0 流格式总则（实测）

- stdout 为 **JSONL**：每行一个 JSON 对象，**LF（`\n`）结尾、无 `\r`、无 BOM**（`od -c` 验证，首字节即 `{`；`\r` 计数 0），UTF-8（中文原样）。
- **首行必为 session header**（`--no-session` 也输出）；行数随流式增量数浮动（同样 prompt 实测 12/29/31 行），**解析必须按行流式处理，不能按行数假设结构**。
- stderr：本 spike 全部成功/LLM 失败 run 均 0 字节；仅"启动期错误"（如模型不存在）走 stderr + 非 0 退出（④.6）。
- 进程退出码：**LLM 调用失败时仍为 0**（③.1/④.4 均 EXIT=0）——成败必须扫事件流判定。

### ④.1 第 1 行：session header

```
{"type":"session","version":3,"id":"01a11552-97ae-730a-ba6a-b38b6c4bdb3c","timestamp":"2026-10-07T07:44:56.751Z","cwd":"C:\\Users\\zhangjinglun\\AppData\\Local\\Temp\\pi-spike-cwd"}
```

| 字段 | 实测值/含义 |
|---|---|
| `type` | 固定 `"session"`（与事件行区分的第一位判据） |
| `version` | `3`（会话格式版本，实测=3） |
| `id` | 每次 run 新生成的 UUID（`--no-session` 也生成） |
| `timestamp` | ISO-8601 UTC 字符串（**注意：与 message 里的 epoch ms 数值不同型**） |
| `cwd` | pi 进程工作目录（JSON 转义的反斜杠）——**适配器可用于验证 spawn cwd 生效** |

### ④.2 短 prompt + LLM 失败（403）时的完整 stdout（brief Step 1 逐行实录）

命令：`pi --mode json -p --no-session "只回复两个字：好的"`（stdin=`/dev/null`）。EXIT=0，stdout 20491 字节 12 行，stderr 0 字节。逐行（第 4/5/11 行为内嵌系统提示词/全历史的大行，按标注截断）：

```
1  {"type":"session","version":3,"id":"01a11552-...","timestamp":"2026-10-07T07:44:56.751Z","cwd":"C:\\Users\\...\\pi-spike-cwd"}
2  {"type":"agent_start"}
3  {"type":"turn_start"}
4  {"type":"message_start","message":{"role":"system","content":"","sections":{...},"timestamp":1791359096847,"toolsAdded":[...]}}   ← 约 6KB，见 ④.3
5  {"type":"message_end","message":{"role":"system","content":"","timestamp":1791359096847}}                                        ← 约 6KB
6  {"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"只回复两个字：好的"}],"timestamp":1791359096845}}
7  {"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"只回复两个字：好的"}],"timestamp":1791359096845}}
8  {"type":"message_start","message":{"role":"assistant","content":[],"api":"anthropic-messages","provider":"anthropic","model":"claude-opus-4-8","usage":{...},"stopReason":"error","timestamp":...,"errorMessage":"403 {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}","thinkingLevel":"medium"}}
9  {"type":"message_end","message":{<与第 8 行同内容>}}
10 {"type":"turn_end","message":{<与第 8 行同内容>},"toolResults":[]}
11 {"type":"agent_end","messages":[<system>,<user>,<assistant>],"willRetry":false}                                                  ← 约 6.5KB
12 {"type":"agent_settled"}
```

要点：LLM 调用失败**不产生任何 `message_update`**；assistant 消息 `content:[]`、`stopReason:"error"`、带 `errorMessage`（含上游 HTTP 状态与错误体），且 `message_start`/`message_end`/`turn_end.message`/`agent_end.messages[]` 中是同一对象。

### ④.3 成功 run 的完整事件型序列（probe：ark/glm-5.3-flash，31 行）

```
session → agent_start → turn_start
→ message_start(system) → message_end(system)        # 见下 system 消息表
→ message_start(user) → message_end(user)            # content[0].text = 原样 prompt
→ message_start(assistant, stopReason:"pending", content:[])
→ message_update × N                                  # 流式增量，见 message_update 表
→ message_end(assistant)                              # 最终 content/usage/stopReason 在此定格
→ turn_end(assistant, toolResults:[]) 
→ agent_end(messages:[system,user,assistant], willRetry:false)
→ agent_settled
```

**system 消息**（适配器解析时跳过；字段实测）：

| 字段 | 实测 |
|---|---|
| `role` | `"system"` |
| `content` | `""`（空串，正文在 sections） |
| `sections` | 对象，键：`preamble`(169字符)/`tools`(339)/`rules`(839)/`docs`(1400)/`cwd`(66)——pi 内置系统提示词全文 |
| `timestamp` | epoch ms（数值） |
| `toolsAdded` | 数组，元素键：`name`/`description`/`parameters`(JSON Schema)/`constrainedSampling`；默认 `["read","bash","edit","write"]`，`--tools read` 后为 `["read"]` |

**assistant 消息**（核心；`message_start` 时 `stopReason:"pending"`、`content:[]`，`message_end` 时定格）：

```json
{"type":"message_end","message":{"role":"assistant",
 "content":[{"type":"thinking","thinking":"The user wants me to reply with only two characters: \"好的\"","thinkingSignature":""},{"type":"text","text":"好的"}],
 "api":"anthropic-messages","provider":"ark","model":"glm-5.3-flash",
 "usage":{"input":1444,"output":17,"cacheRead":0,"cacheWrite":0,"totalTokens":1461,
          "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0},"cacheWrite1h":0},
 "stopReason":"stop","timestamp":1791359129260,
 "responseId":"021791359129926058502d755c26cb6cb15fa4dd1ac2db8e065c8","responseModel":"glm-5-3-flash",
 "rawStopReason":"end_turn","thinkingLevel":"off"}}
```

| 字段 | 实测 | 适配器用法 |
|---|---|---|
| `content` | 数组，元素 `{type:"thinking",thinking,thinkingSignature}` 与 `{type:"text",text}`（**最终 assistant 文本 = `content[]` 中 `type:"text"` 的 `text` 拼接**；工具调用时会另有 `type:"toolCall"`——本轮未实测） |
| `api` / `provider` / `model` | `"anthropic-messages"` / providerId / 请求的 modelId | 日志、告警 |
| `usage` | 见下表 | 计费/统计 |
| `stopReason` | 成功 `"stop"`；LLM 失败 `"error"`；被中断 `"aborted"`（源码解读，未实测）；流式中 `"pending"`  | **成败判据**：非 `"stop"` 即失败 |
| `errorMessage` | 仅失败时存在（如 `403 {...}`） | 失败原因（含上游状态码） |
| `responseId` / `responseModel` | 上游返回 id / 实际上游模型名（与请求 model 可能不同） | 审计 |
| `rawStopReason` | 上游原始停止原因（如 `end_turn`） | 诊断 |
| `thinkingLevel` | 实测 `"medium"`（anthropic 默认）/ `"off"`（ark 该模型） | 忽略即可 |
| `timestamp` | epoch ms | 排序/日志 |

**usage 对象**（在 assistant 消息内；`message_update` 顶层也有一份但我方实测恒为全 0）：

| 键 | 实测（成功 run） | 说明 |
|---|---|---|
| `input` | `1444` | 输入 token |
| `output` | `17` | 输出 token |
| `cacheRead` | `0`（另一次 1408，说明会变） | 缓存命中 |
| `cacheWrite` | `0` | 缓存写入 |
| `totalTokens` | `1461`（= input+output+cacheRead+cacheWrite） | pi 汇总字段 |
| `cost` | `{input,output,cacheRead,cacheWrite,total}` 全 0（实测） | pi 侧估算；模型不在价目表内时为 0，**不可依赖非 0** |
| `cacheWrite1h` | 成功 run 有（0）；403 失败的 usage 中**没有该键** | **usage 键集可变，解析器按可选处理** |

**`message_update`**（流式增量；包裹层 `usage` 顶层字段实测恒全 0，正文在 `assistantMessageEvent`）：

```
{"type":"message_update","usage":{...全0...},"assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"好的"}}
```

`assistantMessageEvent.type` 实测出现：`thinking_start`{contentIndex:0} → `thinking_delta`{contentIndex:0,delta} → `thinking_end`{contentIndex:0,content} → `text_start`{contentIndex:1} → `text_delta`{contentIndex:1,delta} → `text_end`{contentIndex:1,content}。（`contentIndex` 即 `content[]` 下标；M3 若做实时进度可用，取最终文本请用 `message_end`。）

**`turn_end`**：`{"type":"turn_end","message":{<assistant 消息，字段同 message_end>},"toolResults":[]}` —— 一轮结束；工具结果在 `toolResults` 数组。

**`agent_end`**：`{"type":"agent_end","messages":[<system>,<user>,<assistant>,...],"willRetry":false}` —— **整段历史的权威副本**（最终 assistant 消息的文本+usage 在此可取）；`willRetry` 表示 pi 是否自动重试。

**`agent_settled`**：`{"type":"agent_settled"}` —— 完全静止的收尾信号（重试/队列都清空）。

**`agent_start` / `turn_start`**：`{"type":"agent_start"}` / `{"type":"turn_start"}`（无附加字段）。

> 解析器健壮性（源码解读，非实测）：事件全集大于本 spike 所见，还可能出 `tool_execution_start/update/end`、`auto_retry_start`、`compaction_start/end`、`queue_update`、`entry_appended` 等——**解析器必须容忍未知 type（跳过即可）**。

### ④.4 最终文本的取用优先级（实测＋建议）

1. 取**最后一条** assistant 消息的 `content[]` 中 `type:"text"` 项拼接（逐轮都有 `message_end`/`turn_end`，多轮或含工具调用时以 `agent_end.messages` 尾部的 assistant 消息为准；实测单轮即最终答案 `"好的"`）；
2. `agent_end.messages` 的最后一条 assistant 消息（等价权威副本，实测一致）；
3. `message_update` 的 `text_delta` 仅用于实时进度，**不要**当最终值来源。

### ④.5 JSON-only 指令可行性（probe G，实测）

task 末尾追加"只输出 JSON"指令后，实测 glm-5.3-flash 的最终文本为**无栅栏纯净 JSON**：

```
final text = "{\"ok\": true, \"answer\": \"好的\"}"
stopReason = stop | usage.totalTokens = 1529
```

→ design.md §9.2 的"追加 schema 指令 → 解析（剥栅栏）→ 校验"路径可行；仍建议解析端同时处理 ```json 栅栏（其它模型不保证）。

### ④.6 退出码/错误通道总表（实测）

| 场景 | 退出码 | stdout | stderr |
|---|---|---|---|
| 正常完成 | 0 | 完整事件流（`stopReason:"stop"`） | 空 |
| LLM 调用失败（403/401 等） | **0** | 完整事件流（assistant `stopReason:"error"` + `errorMessage`） | 空 |
| 启动期错误（如模型不存在：`--model no-such-provider/no-such-model`） | **1** | **无事件流**（0 字节；仅个别场景可能有 182B 的 header 行） | `Error: Model "no-such-provider/no-such-model" not found. Use --list-models to see available models.` |
| 无任何可用凭据（`~/.pi/agent` 未登录且无 token 且无自定义 provider） | 1 | 182 字节（仅 session header 行） | `No API key found for the selected model. Use /login ...` |
| 被外部杀死（⑤） | 被杀（无收尾事件） | 事件流在任意行边界**戛然截断**（实测 1005 行完整行后终止；末行仍是完整 JSON） | 空 |

适配器规则：**先看退出码**——非 0 即失败（拿 stderr 报错）；退出码 0 时**必须继续扫事件流**，以 assistant 消息 `stopReason`/`errorMessage` 判定成败（退出码 0 不代表 LLM 成功）。被杀场景下最后一行可能不完整（本 spike 未复现出半行，但管道截断语义下**必须容忍尾行不完整**）。

## ⑤ 终止协议（Windows 进程树）

**实测结论：`taskkill /PID <pid> /T /F` 能干净杀掉整棵进程树且无孤儿。注意参数形式因执行上下文而异（见下）。**

### ⑤.1 命令形式（实测两种上下文）

| 上下文 | 命令 | 实测 |
|---|---|---|
| Node 适配器内（推荐） | `execFile("taskkill", ["/PID", String(pid), "/T", "/F"])`（或 spawn 等价形式） | Node 直传参数，不经 MSYS，无改写问题；（M3 实现，本次 spike 以 git-bash 侧等价命令验证了 taskkill 行为） |
| git-bash 内 | `taskkill /PID <pid> /T /F` **失败**：/PID 被 MSYS 改写为 `D:/Program Files/Git/PID`，报 `ERROR: Invalid argument/option - 'D:/Program Files/Git/PID'.`（EXIT=1）。**改用** `cmd //c "taskkill /PID <pid> /T /F"` | 成功，EXIT=0 |

### ⑤.2 验证 1：长任务被杀（进程树 + 孤儿检查）

宿主 node 以 `shell:true` 拉起 pi（长文 prompt，Ark 模型，stdin=`ignore`），运行 35s 后杀宿主树。杀前进程树（PowerShell `Win32_Process` 按 ParentProcessId 展开，实测）：

```
9496   11132  node.exe   "D:\Program Files\nodejs\node.exe" C:/Users/.../mine/host-pi.js
12368  9496   cmd.exe    C:\Windows\system32\cmd.exe /d /s /c "pi --mode json -p --no-session -...
8796   12368  node.exe   "node" "C:\Users\...\npm\\node_modules\@earendil-works\...
```

杀前仍在流式输出（宿主心跳 `STATUS t=35s stdoutBytes=280276 lines=997`）。执行：

```
$ cmd //c "taskkill /PID 9496 /T /F"
SUCCESS: The process with PID 8796 (child process of PID 12368) has been terminated.
SUCCESS: The process with PID 12368 (child process of PID 9496) has been terminated.
SUCCESS: The process with PID 9496 (child process of PID 11132) has been terminated.
EXIT=0
```

杀后验证（命令与输出原文）：

```
$ tasklist | grep -i "node.exe" | sort > nodes-before.txt     # 运行前快照：0 行（文件 0 字节）
$ tasklist | grep -i "node.exe" | sort > nodes-after.txt      # 杀后快照：0 行（文件 0 字节）
$ diff nodes-before.txt nodes-after.txt && echo "(identical to BEFORE snapshot)"
(identical to BEFORE snapshot)
$ tasklist //FI "PID eq 8796"        # 三个 PID（8796/12368/9496）逐个查，均：
INFO: No tasks are running which match the specified criteria.
```

宿主心跳在杀后停止（无任何收尾打印，符合 /F 硬杀）。

### ⑤.3 验证 2：按 spawn 句柄 PID 杀子进程树（M3 用例）+ stdin 开放阻塞交叉验证

- 子进程树（stdin 保持打开）：宿主 14544 → cmd.exe 4416 → pi node 10920；40s 内 stdout 0 字节（③.4）。
- `cmd //c "taskkill /PID 4416 /T /F"`（4416 = Node `spawn` 返回的 `child.pid`，shell:true 下即 cmd.exe）→

```
SUCCESS: The process with PID 10920 (child process of PID 4416) has been terminated.
SUCCESS: The process with PID 4416 (child process of PID 14544) has been terminated.
```

宿主随即收到 `CHILD_EXIT code=1 signal=null`（被杀的子进程退出码为 1，`signal` 为 null——**Windows 下不要依赖 signal 判断被杀**）。杀后清点（命令与输出原文）：

```
$ diff nodes-before2.txt nodes-after2.txt && echo "(no new leftovers vs before)"
(no new leftovers vs before)
```

（两快照均 0 行 / 0 字节。）

### ⑤.4 冻结要点

- **杀整棵树用 `/T`**：shell:true 下 `child.pid` 是 cmd.exe，pi 本体（node.exe）是其孙进程；本轮实测 `/T` 后无孤儿。**不带 `/T` 未测**（按进程链推断会留下 pi 孤儿，故不要用）；如遇环境差异，杀后以 `tasklist` 前后 diff 为准。
- **顺序**：taskkill /T 自叶向根（输出顺序即证明：8796 → 12368 → 9496）。
- **无优雅退出**：`/F` 硬杀，pi 不会输出收尾事件；事件流截断在任意点，宿主侧按"无 `agent_settled`/退出码非 0"处理为"被杀"。
- 杀后清点：`tasklist` 前后 diff 是无孤儿判据（本机 Claude Code 会话非 node.exe，快照干净；其它环境注意排除无关 node 进程）。

## ⑥ 与 design.md §9.2 的差异修正列表

### ⑥.1 本次冻结对 design.md §9.2 的全部改动（与 §9.2 相对原始设计的累计 diff 逐条对应；本次修复轮 R1 的两处措辞修正计入第 4 行）

| # | design.md 位置 | 改动 | 实测依据 |
|---|---|---|---|
| 1 | :499（新增） | 加指针 blockquote："协议细节以《docs/runtime-protocol.md》为准"（冻结关系声明，非实测修正） | — |
| 2 | :501 | stdin 补充：stdin 读到 EOF 为止、spawn **必须关闭 stdin**（否则无限期阻塞）；stdin 与 argv 同时给会无分隔符拼接、适配器二者只取其一 | ③.4 / ③.5 |
| 3 | :503 | 事件流解析补充：**首行 session header（`--no-session` 也输出）需跳过**；最终文本取 `message_end`/`turn_end` 的 assistant `content[].text`（`agent_end.messages` 为权威副本）；usage 在 assistant 消息对象内 | ④.1–④.3 |
| 4 | :503 | 退出码补充：**LLM 失败退出码仍为 0**，成败须看 `stopReason`（`"error"`/`"aborted"`，后者未实测）与 `errorMessage`；启动期错误（模型不存在/无凭据）退出码 1、错误只在 stderr、stdout 无事件流（无凭据场景仍有 182B 的 session header 行）——两套判定都要做 | ④.6 |
| 5 | :503 | 版本探测补充：`pi --version` 输出单行裸 semver，按版本区间校验 | ① |
| 6 | :505 | Windows spawn 补充：npm shim 为 `%APPDATA%/npm/{pi,pi.cmd,pi.ps1}`；杀进程 = `taskkill /PID <spawn 返回的 pid> /T /F`（`/T` 不可省：shell:true 下句柄 PID 是 cmd.exe，pi 本体是其孙进程） | ② / ⑤ |
| 7 | :506 | 认证环境差异修正：`ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL` 不被读取（不可路由 baseUrl 的 marker 实测）；`ANTHROPIC_AUTH_TOKEN` 会被读取（去掉后 `No API key found for the selected model.`，EXIT=1）；企业网关用 `PI_CODING_AGENT_DIR` + `models.json` 自定义 provider | ③.7 / ② |

### ⑥.2 实测补充但**未改动** design.md（仅记录于本文档）

- `--mode json` 下 `-p` 可省（实测行为一致）；`--tools a,b,c` 为逗号分隔白名单（实测 `toolsAdded` 由 `["read","bash","edit","write"]` 精确过滤为 `["read"]`）；`--model` 格式为 `<providerId>/<modelId>`，未知模型 → EXIT=1 + stderr——记录于 ②。
- Node ≥ 22 下 `shell:true` 触发 `[DEP0190]` 弃用告警（噪声，不阻断）；spawn 实测进程链 host node → cmd.exe → pi node——记录于 ②/⑤。
- JSON-only 指令可行性（模型返回无栅栏纯净 JSON）——记录于 ④.5；§9.2 的 schema 条目未改动。
- 终止细节：git-bash 直写 `/PID` 被 MSYS 改写需 `cmd //c`、taskkill `/T` 自叶向根、被杀子进程 `code=1 signal=null`、事件流任意点截断——记录于 ⑤。

其他章节未改动；`--no-session` 不落盘、cwd 无新文件（实测）与 §9.2 原文一致，无修正。

## 附录 A：源码解读备忘（解释用，非协议依据）

以下来自 pi-mono v1.0.4 源码阅读，仅解释实测现象：

- `--version`：main.ts 直接 `console.log(VERSION)` 后退出（实测单行裸版本号吻合）。
- JSON 模式：`modes/print-mode.ts` 逐行 `JSON.stringify(toJsonEvent(event))`；启动时写 session header 行。
- stdin：`readPipedStdin()` 仅在 stdin 非 TTY 时读取，EOF（`end` 事件）返回；`buildInitialMessage` 把 argv 与 stdin 内容 `parts.join("")` 拼接（与实测 `"AAABBB"` 相符）。
- 退出码映射只在 text 模式做（`stopReason` error/aborted → exit 1）；**json 模式下 `stopReason` 不映射退出码**（LLM 失败仍 0）——解释了"LLM 失败退出码 0"；启动期错误不在此列（见 ④.6）。
- stdout 保护（`core/output-guard.ts`）：json/rpc 模式接管 `process.stdout.write`，杂散输出改道 stderr，stdout 只含协议行。
- 事件全集（`packages/agent` 类型定义）大于本 spike 所见：`tool_execution_*`、`auto_retry_start`、`compaction_*`、`queue_update` 等（解析器需容忍未知 type）。
- `--no-session` → `SessionManager.inMemory()`（header 仍生成、不落盘，与实测吻合）。

## 附录 B：复现与原始产物

- 工作目录：`C:/Users/zhangjinglun/AppData/Local/Temp/pi-spike-cwd`（`mine/` 子目录为本次 spike 的脚本与全部原始 stdout/stderr 捕获：`step1-noauth.*`、`success.*`、`stdin-verbatim.*`、`long-argv.*`、`long-stdin.*`、`concat.*`、`tools-read.*`、`badmodel.*`、`nop.*`、`jsononly.*`、`env-*`、`host-*.log`、`host-events.jsonl`、`nodes-before/after*.txt`）。
- 复现脚本：`mine/host-pi.js`（宿主+杀树探针）、`mine/evsum.js`（事件流摘要）、`mine/tree.ps1`（进程树展开）。
- 自定义 provider 配置样例：`pi-home/models.json`（ark provider，`apiKey: "$ARK_API_KEY"`）。
