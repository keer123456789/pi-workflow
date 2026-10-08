# @wangchengshi/pi-workflow

Deterministic langgraph-style workflow orchestration for the pi coding agent framework.

为 pi coding agent 框架提供 langgraph 风格的确定性工作流编排。

## Install

```bash
npm install @wangchengshi/pi-workflow
```

- **Requires Node >= 22.** ESM-only — no CommonJS entry point.
- The only runtime dependency is `typebox` (schemas and validation).
- **Optional peer dependencies** — `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`. Both are marked optional in `peerDependenciesMeta` and are **never required to install**:
  - `@earendil-works/pi-ai` — provides the default completion implementation for `llm` nodes (only needed if you use `llm` nodes without injecting your own `complete`);
  - `@earendil-works/pi-coding-agent` — provides the in-process `sdk` executor for `agent` nodes (only needed if you declare `executor: "sdk"`).
  - Graphs made of `fn` nodes (or with injected services) need neither.
- Advanced: probe peer availability before `compile()` via the `./runtime` subpath —
  `import { isPiAiAvailable, isPiSdkAvailable } from "@wangchengshi/pi-workflow/runtime"`.
  Both are functions — call them (e.g. `isPiAiAvailable()`) to get a `boolean`.

## Quick start

A minimal graph with one `fn` node. Save as `quick-start.ts` in an ESM project
(`"type": "module"`) and run it directly — Node >= 22.18 executes TypeScript by
stripping types, so no build step is needed (`node quick-start.ts`):

```ts
import { END, START, StateGraph, fnNode } from "@wangchengshi/pi-workflow";

type State = { text: string; shout: string };

const app = new StateGraph<State>({ name: "quick-start" })
  .addNode("shout", fnNode<State>((s) => ({ shout: s.text.toUpperCase() })))
  .addEdge(START, "shout")
  .addEdge("shout", END)
  .compile();

const { state, runId } = await app.run({ text: "hello pi-workflow", shout: "" });

console.log(state.shout); // HELLO PI-WORKFLOW
console.log("runId:", runId); // every run gets an id, used by the JSONL log
```

Note that `run()` resolves to `{ state, runId }`, not the bare state — see
[Differences from langgraph](#differences-from-langgraph) before porting muscle memory.

## Core concepts

- **StateGraph** — `new StateGraph<S>({ name?, channels?, stateSchema? })` builds the
  graph in code. Chain `addNode(name, node)`, `addEdge(from, to)` (with the `START` /
  `END` sentinels) and `addConditionalEdges(from, router)`.
- **compile()** — validates the whole graph at once (all issues collected into a single
  `GraphValidationError`) and then seals the builder: any `addNode` / `addEdge` /
  `addConditionalEdges` afterwards throws `GraphSealedError`. Warnings (unreachable
  nodes, terminal nodes) are non-fatal — compile still succeeds and surfaces them as
  warnings.
- **Channels & reducers** — every state key is a channel. Declare a reducer per key via
  `channels: { clauses: append }`; keys without one are last-value-wins. Standard
  reducers exported by the library: `overwrite` (default), `append` (array concat),
  `concat` (string concat), `setOnce` (a second write throws `InvalidWriteError`).
  Two instances writing the same reducerless key in one superstep is an error, not a
  silent overwrite.
- **Routers** — `(state, lastUpdate) => target` evaluated at most once per node per superstep.
  Returns a node name, `END`, a `Send`, an array of those, or `null`/`undefined`
  (treated as `END`). `lastUpdate` is what the source node wrote this superstep —
  use it in loops to fan out only over fresh data.
- **Send** — dynamic fan-out: `new Send(nodeName, input)` creates one non-deduplicated
  instance of `nodeName` whose input is exactly `input` (map-reduce over runtime data).
  Ordinary edge/router triggers deduplicate by node name per superstep.
- **run / invoke** — `compile()` returns a graph whose `run(initialState, options?)`
  executes the superstep (Pregel BSP) loop and returns a `RunHandle` — a promise of
  `{ state, runId }` with a `cancel()` method. `invoke` is an alias of `run`.
- **Budgets** — `recursionLimit` (default 25, throws `GraphRecursionError`),
  `maxInstancesPerSuperstep` (default 1000) and `maxTotalInstances` (default 10000)
  (both throw `InstanceBudgetError`), `maxConcurrency` (default 8), `runTimeoutMs`
  (default: none). `Send` has no inherent cap — the budgets are the guardrail.
- **Cancellation** — three signal tiers: a run-level signal (`RunOptions.signal`,
  `handle.cancel()`, or `runTimeoutMs` expiry), per-instance signals (also aborted when
  a sibling fails — fail-fast), and per-attempt signals handed to nodes as `ctx.signal`.
  Nodes must respect `ctx.signal` (check it periodically in long loops); the engine
  cannot preempt a node that ignores it.
- **Determinism** — every node instance gets a global monotonic `seq`; state merges
  fold in `seq` order regardless of completion order. The same graph plus the same
  initial state produces bit-identical state trajectories. `clock`, `sleep` and
  `random` are injectable via `compile({ services })` for reproducible tests.
- **Errors** — everything thrown extends `WorkflowError`: `GraphValidationError`,
  `GraphSealedError`, `RouterError`, `InvalidWriteError`, `GraphRecursionError`,
  `InstanceBudgetError`, `TemplateError`, `NodeExecutionError`.

## Node types

Three node factories, one per cost tier — prefer `fn`, escalate to `llm`, reserve
`agent` for tasks that need tools:

### fn — a plain function

```ts
import { fnNode } from "@wangchengshi/pi-workflow";

fnNode<State>((input) => ({ upper: input.text.toUpperCase() }), {
  timeoutMs: 5000, // optional; fn nodes have no timeout by default
});
```

`fn` nodes never retry (code errors are not transient) and have no `retry` option.

### llm — one structured completion

```ts
import { llmNode } from "@wangchengshi/pi-workflow";
import { Type as T } from "typebox";

const RiskReport = T.Object({
  clauseId: T.String(),
  risks: T.Array(T.String()),
});

llmNode<State, "riskReports">({
  prompt: "Review this contract clause for legal risks:\n{clause}",
  schema: RiskReport, // output must be JSON matching this schema
  writeTo: "riskReports", // channel the parsed output is written to
  model: "anthropic/claude-sonnet-4-5", // optional, forwarded to the adapter
  retry: { maxAttempts: 3 }, // total attempts including the first
  // timeoutMs: 120_000,    // per-attempt default
});
```

- `{key}` placeholders are interpolated from the instance input (nested paths like
  `{a.b.c}` work, non-string values are `JSON.stringify`-ed, a missing key throws
  `TemplateError`; literal braces are escaped as `{{` / `}}`). A function
  `(input) => string` is also accepted.
- The response goes through fenced JSON code block stripping → `JSON.parse` →
  typebox validation; JSON or schema violations are retried with the same prompt.
- The completion implementation is resolved at compile time:
  node-level `complete` → `services.complete` → the pi-ai default (when
  `@earendil-works/pi-ai` is installed). If none is available, `compile()` fails with
  an actionable issue.

### agent — one pi agent task

```ts
import { agentNode } from "@wangchengshi/pi-workflow";

agentNode<State, "riskReports">({
  task: "Check the citations in clause {clause} against case files",
  schema: RiskReport, // optional — without it the raw final text is the output
  writeTo: "riskReports",
  tools: ["read", "grep"], // capability selection, NOT a security boundary
  executor: "subprocess",
  timeoutMs: 600_000, // agent default
});
```

**The executor comes in three forms** (`executor` field of `agentNode`):

1. **A custom function** (`AgentExecutor`) — full control, zero dependencies:

   ```ts
   import type { AgentExecutor } from "@wangchengshi/pi-workflow";

   const myExecutor: AgentExecutor = async ({ task, signal }) => ({
     output: await myOwnAgentRuntime(task, signal),
   });

   // agentNode({ ..., executor: myExecutor })
   ```

   The request object carries `{ task, tools?, model?, schema?, signal, timeoutMs,
   runId, instanceId }`; the result is `{ output: string, usage? }`.

2. **`"subprocess"`** — spawns the pi CLI (`pi --mode json -p --no-session …`), feeds
   the task via stdin, parses its JSON event stream, and hard-kills the whole process
   tree on timeout/cancel (`taskkill /T /F` on Windows, process-group SIGKILL on
   POSIX). Configured via `services.agent.subprocess` (`PiSubprocessConfig`, all
   fields optional):

   ```ts
   .compile({
     services: {
       agent: {
         subprocess: {
           bin: "pi", // executable, resolved via PATH; this is the default
           cwd: "/workspace", // child process working directory (default: process.cwd())
           env: { PI_CODING_AGENT_DIR: "/path/to/agent" }, // merged over process.env
           extraArgs: [], // appended to the command line verbatim
           defaultModel: "anthropic/claude-sonnet-4-5", // used when the node has no model
         },
       },
     },
   })
   ```

3. **`"sdk"`** — in-process agent sessions via a dynamic `import()` of
   `@earendil-works/pi-coding-agent` (the optional peer). Each node call gets a fresh
   in-memory session, disposed when the node settles. Configured via
   `services.agent.sdk` (`PiSdkConfig`, all fields optional):

   ```ts
   .compile({
     services: {
       agent: {
         sdk: {
           agentDir: "/path/to/.pi/agent", // dir holding auth.json/models.json
           cwd: "/workspace", // session working directory (default: process.cwd())
           defaultModel: "anthropic/claude-sonnet-4-5", // "<provider>/<id>" string
         },
       },
     },
   })
   ```

Both string forms require the matching `services.agent.subprocess` / `services.agent.sdk`
config to be present at compile time — an empty object `{}` accepts all defaults — and
`"sdk"` additionally requires the peer package to be installed. Missing pieces are
reported at `compile()` with actionable issues, never at runtime.

Retries (`retry: { maxAttempts }`, llm/agent only) fire on transient failures —
429/408/5xx, rate limit, timeout, ECONNRESET, socket hang up, and JSON/schema
mismatches — with exponential backoff (base 500 ms, 30 s cap, full jitter).

## Observability

Every run produces a **JSONL event log, on by default** — no setup needed.

- **Location**: `<dir>/<YYYYMMDDTHHmmssSSSZ>-<runId>/run.jsonl`, where `<dir>`
  resolves as `options.logDir || process.env.PI_WORKFLOW_LOG_DIR || ".pi-workflow/runs"`
  (an empty string counts as unset).
- **Event types**: `run_started`, `node_started`, `node_finished`, `node_retry`,
  `node_failed`, `superstep_committed`, `superstep_aborted`, `run_finished`. Every
  event carries `seq` (globally monotonic), `superstep`, `ts` and `runId`. Events are
  emitted in completion order; consumers needing a total order re-sort by `seq`.
  A superstep is committed if and only if its events are followed by
  `superstep_committed`.
- **Live stream**: pass `onEvent` to `run()` to receive the same events in real time.
- **Redaction**: `logOutputs: "hash"` replaces `run_started.input` and
  `node_finished.output` with `"sha256:<hex>"` digests — both the `onEvent` callback
  and the log file only ever see hashes, so sensitive payloads never leave the process
  in clear.
- **Log write failures**: `onLogError` defaults to `"fail"` — a failing logger rejects
  the run with `WorkflowError("run log write failed: …")` (audit-first, deliberate);
  set `"warn"` to log and continue. Disable logging entirely with
  `compile({ services: { logger: {} } })` (an empty logger is fully silent).

## Differences from langgraph

pi-workflow borrows langgraph's `StateGraph` / channel+reducer / conditional-edge /
`Send` mental model, but v1 is a deliberate subset with a few sharp edges. The design
doc (docs/design.md, §11) is the authoritative list; here is the English rendering:

| # | langgraph | pi-workflow v1 | What to watch for |
|---|---|---|---|
| 1 | `invoke()` returns the final state | `run()` returns `{ state, runId }` | Don't destructure the bare state as in langgraph |
| 2 | Ordinary triggers within a superstep dedupe by node | Same (deliberately fixed) | `Send` is not deduplicated — same as langgraph |
| 3 | Branch functions receive only `state` | Routers take a second argument `lastUpdate` | A superset; ignore it if you don't need it |
| 4 | `recursion_limit` counting semantics | `recursionLimit` = superstep cap | Same meaning |
| 5 | checkpoint / interrupt / store | None (planned for v2) | If you need human-in-the-loop pauses, don't use v1 |
| 6 | `path_map` (routing by logical labels) | None (reserved for v2) | Return node names directly |
| 7 | Static `Send` edges (declared in the graph) | None — `Send` only appears in router return values | Fan-out goes through conditional edges uniformly |
| 8 | Per-node `concurrencyKey` | None (v2) | Global `maxConcurrency` |
| 9 | Nodes mutate shared state by reference | Input is a read-only snapshot; mutating it is undefined behavior | To change state, return a partial state |
| 10 | State schema is mandatory | Optional (`stateSchema`) | Without it only merge-conflict checks are performed |

## Example

[examples/contract-review.ts](examples/contract-review.ts) (in the source repository)
walks through the full design-doc scenario: load a contract → extract clauses (`llm`)
→ per-clause fan-out via `Send` (`llm` review) → risk-gated precedent checks
(`agent`) → aggregate a final report, with `append` channels collecting results.

```bash
npm run build                     # the example imports the package by name (self-reference → dist/)
node examples/contract-review.ts  # Node >= 22.18 runs the .ts file directly
```

- **Mock mode is the default** (`PI_WORKFLOW_EXAMPLE_MOCK` unset): `llm` nodes get a
  frozen mock `complete` and the agent node uses a custom executor function, so the
  whole graph runs **offline, no credentials**.
- **Real mode** (`PI_WORKFLOW_EXAMPLE_MOCK=0`) switches to the pi-ai default
  completion and the `sdk` executor and requires pi credentials. This mode is
  **verified at compile-time wiring only — it has not been executed against real pi**.
- The run log goes to `os.tmpdir()/pi-workflow-example-runs`, keeping the repo clean.

## License

ISC

## Documentation

Both documents live in the source repository (they are not part of the npm tarball):

- [docs/design.md](docs/design.md) — the complete design document, in Chinese:
  execution semantics (supersteps, dedup, seq, budgets), compile-time validation,
  retry/cancellation tiers, the pi adapter layer, and the full v1 scope;
- [docs/publishing.md](docs/publishing.md) — maintainer guide for publishing releases
  (in Chinese).
