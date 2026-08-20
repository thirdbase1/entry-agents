# Entry Harness Architecture Review

## Scope

This document consolidates the architecture review of the `entry-agents` and `entry-gateway` repositories.

The goal is to evolve **Entry** into a production-grade AI agent harness rather than simply another AI SDK or model router.

---

## Executive summary

Entry already has the core architecture of a serious agent harness. The correct direction is **not a rewrite**. The system should evolve around stronger contracts between the agent/workflow runtime, context manager, tools, permissions, sandbox, verification layer, and model gateway.

```text
                    ENTRY
                      |
          +-----------+-----------+
          |                       |
      Agent API             Workflow API
          |                       |
          +-----------+-----------+
                      |
                ENTRY HARNESS
                      |
       +--------------+--------------+
       |       |       |       |     |
    Context Execution Policy Sandbox Verify
       |       |       |       |     |
       +--------------+--------------+
                      |
               ENTRY GATEWAY
                      |
          +-----------+-----------+
          |           |           |
        OpenAI    Anthropic     Gemini
```

The main product opportunity is to make Entry the system that can **reliably execute an AI task**, not merely another model SDK or router.

---

# 1. Current architecture

### Entry Agents

The agent side already contains the major ingredients of a harness:

- agent/tool loop
- durable workflow execution
- filesystem and shell tools
- web tools
- GitHub/Vercel integrations
- skills
- subagents
- permission modes
- sandbox execution
- context compaction
- prompt caching support
- dynamic model selection
- model preparation hooks

The current one-step `ToolLoopAgent` pattern is appropriate for durable/serverless execution when the surrounding workflow persists and resumes the run.

### Entry Gateway

The gateway is more than a reverse proxy. It already provides:

- OpenAI-compatible endpoints
- Anthropic-compatible endpoints
- Gemini-compatible access
- model discovery
- provider/model routing
- priority fallback
- circuit breakers
- provider health/metrics
- streaming usage handling
- token normalization
- cost estimation
- cache accounting
- active-request/latency tracking

This separation is a major architectural strength: model infrastructure can evolve without forcing the agent runtime to understand provider-specific infrastructure.

---

# 2. Agent execution should be an explicit state machine

The workflow is effectively the real runtime around one-step model/tool execution. Make that contract explicit.

```text
RUN_CREATED
    -> STEP_STARTED
    -> MODEL_CALLED
    -> TOOL_REQUESTED
    -> TOOL_RUNNING
    -> TOOL_COMPLETED
    -> VERIFICATION
       |-> CONTINUE
       |-> COMPLETE
       |-> RETRY
       `-> FAILED
```

Every transition should be durable and idempotent.

This gives reliable recovery after process crashes, serverless timeouts, deployments/restarts, provider failures, sandbox failures, network disconnects, and duplicate callbacks/webhooks.

Recommended identity:

```text
run_id
  -> step_id
       -> model_call_id
       -> tool_call_id
       -> verification_id
       -> retry_id
```

---

# 3. Tool execution contract

Tool execution should become a first-class runtime primitive.

Recommended metadata:

```text
tool_call_id
run_id
step_id
tool_name
arguments_hash
started_at
finished_at
status
result
error
attempt
idempotency_key
```

The executor should support:

- timeout
- cancellation
- retry policy
- idempotency
- maximum output size
- structured errors
- execution metadata

A read-only filesystem call can safely be repeated. A deployment, GitHub write, database mutation, or external POST may not be safe to repeat.

The runtime should be able to recognize: **“This exact tool call already executed successfully.”**

---

# 4. Permission enforcement

Entry's three permission modes are a strong product model:

- Ask
- Auto Accept
- Full Access

Permissions must be enforced **below the model layer**.

```text
Model
  -> Agent
  -> Tool Registry
  -> Permission Engine   <-- enforce here
  -> Tool Executor
  -> Sandbox / external API
```

The model must never be trusted to enforce its own permissions through prompt instructions.

The permission engine should classify actions and enforce the active policy regardless of which model, subagent, workflow, or tool initiated the request.

---

# 5. Sandbox lifecycle

Treat sandboxes as disposable execution environments. Durable state should belong to the agent run, not a specific VM/container.

```text
Agent Run
  |
  +-- Sandbox #1
  |
  +-- Sandbox #2 after recovery
  |
  `-- Sandbox #3 after restart
```

This enables sandbox replacement, migration, scaling, timeout recovery, and host failure recovery without losing the logical run.

---

# 6. Subagents should be child runs

Subagents should be modeled as child executions:

```text
parent_run
  |
  +-- child_run A
  |     +-- model calls
  |     `-- tools
  |
  +-- child_run B
  |     +-- model calls
  |     `-- tools
  |
  `-- child_run C
        +-- model calls
        `-- tools
```

Each child run should have bounded context, token budget, cost budget, timeout, tool permissions, sandbox scope, and cancellation.

The parent should receive a bounded result rather than blindly importing the child's entire context.

---

# 7. Context engineering

Entry's current context compaction is a strong foundation. It uses conservative estimation and compacts older information while protecting recent messages.

The long-term goal should be **priority-aware context management**, not merely old-message removal.

Recommended priority model:

```text
Priority 0 — current task/instructions
Priority 1 — current tool chain
Priority 2 — recent results
Priority 3 — important files/artifacts
Priority 4 — relevant memory
Priority 5 — older conversation
Priority 6 — stale tool output
```

The context engine should budget separately for system instructions, tools/tool schemas, skills, conversation, memory, tool output, and reasoning/output budget.

### Adaptive estimation

The harness should compare estimated context size with actual provider usage and adjust estimates over time.

```text
estimated input = 93k
actual input    = 101k
error           = +8.6%
```

---

# 8. Verification is a core harness primitive

A model response saying “done” must not be equivalent to task completion.

```text
Model completion != Task verification
```

Examples:

| Task | Verification |
|---|---|
| Code | tests, typecheck, build, lint |
| UI | browser checks/screenshot inspection |
| API | request/response tests |
| GitHub | status + diff checks |
| Database | schema/migration verification |
| Deployment | health check |
| Research | source/claim validation |

Recommended lifecycle:

```text
Model says completed
        -> verification
        -> pass: COMPLETE
        -> fail: recover/retry/continue
```

This should become one of Entry's strongest differentiators.

---

# 9. Gateway fallback must be state-aware

Provider fallback is valuable, but a partially executed streaming request cannot always be blindly replayed.

The gateway should understand states such as:

```text
REQUEST_NOT_STARTED
REQUEST_STARTED_NO_OUTPUT
STREAMING
TOOL_CALL_GENERATED
TOOL_EXECUTED
COMPLETED
```

Fallback policy should depend on execution state. After a provider has already emitted a tool call, blindly retrying the entire request can duplicate tool execution or produce inconsistent state.

---

# 10. Cost-aware orchestration

The Gateway knows model price, cached-token price, input/output usage, provider health, latency, and availability.

The harness knows task complexity, current step, remaining budget, previous failures, verification status, and expected difficulty.

Combine them to enable policy-driven model selection:

```text
Simple task
  -> cheap/fast model

Complex reasoning
  -> stronger model

Repeated context
  -> cache-friendly route

Provider degraded
  -> alternate provider

Budget nearly exhausted
  -> cheaper route

Verification failed
  -> stronger model/recovery strategy
```

---

# 11. Observability already exists in Entry

**Important correction:** Entry already has useful per-turn observability.

When a turn completes, opening the **Usage** view exposes the individual model steps and their costs. Therefore, observability is **not a missing feature**.

The recommendation is to deepen the existing model rather than replace it.

The underlying execution graph should ideally map:

```text
run_id
  +-- step_id
  |     +-- model_call_id
  |     +-- tool_call_id
  |     +-- verification_id
  |     `-- cost/usage
  |
  +-- step_id
  |     `-- ...
  |
  `-- child_run_id
```

The UI can continue presenting the existing Usage experience while the backend gains a complete traceable execution graph.

---

# 12. Canonical pricing and caching

The recent caching/pricing issue demonstrates why pricing must have one authoritative source.

Avoid having independent pricing semantics in `/v1/models`, cost calculation, analytics, usage UI, and routing.

Instead:

```text
                 Model Registry
                       |
       +---------------+----------------+
       |               |                |
    pricing       capabilities       provider
       |               |                |
       +---------------+----------------+
                       |
        +--------------+--------------+
        |              |              |
    /v1/models      costing       analytics
```

The canonical model registry should own model ID, provider, protocol, input price, output price, cache price/discount, context window, supported features, streaming support, tool support, and reasoning support.

This prevents display pricing and actual billing calculations from drifting apart.

---

# 13. Centralize model capabilities

Agent code should not accumulate provider-specific capability checks forever.

The Gateway model registry should expose capabilities such as:

```json
{
  "id": "model-id",
  "protocol": "anthropic",
  "thinking": true,
  "cache": true,
  "context": 200000,
  "streaming": true,
  "tools": true
}
```

Agents can ask the registry what a model supports instead of embedding provider quirks throughout the runtime.

---

# 14. Recommended Harness Runtime API

Entry should eventually expose a clean runtime abstraction above the underlying workflow implementation.

Conceptually:

```ts
const run = await entry.run({
  task: "...",
  model: "auto",
  tools,
  permissions,
  budget,
  verification,
});

await run.resume();
await run.cancel();
await run.inspect();
```

Internally:

```text
Run
  +-- Context
  +-- Execution
  +-- Policy
  +-- Model
  +-- Tools
  +-- Sandbox
  +-- Memory
  +-- Verification
  +-- Persistence
  `-- Observability
```

The Gateway remains the model infrastructure layer underneath the runtime.

---

# 15. What NOT to do

Do not:

- rewrite the whole architecture
- remove the Gateway
- collapse Agents and Gateway into one repository
- make the system dependent on one model provider
- replace the durable one-step execution model with an uncontrolled infinite loop
- rely on prompts to enforce security/permissions
- discard the current context-compaction system
- replace existing usage observability just for the sake of redesign

---

# 16. Priority roadmap

## P0 — Reliability foundations

1. Formalize the durable run/step state machine.
2. Make tool execution idempotent and resumable.
3. Audit permission enforcement at the actual execution boundary.
4. Define sandbox recovery semantics.
5. Define cancellation and timeout semantics.

## P1 — Harness intelligence

6. Make verification a first-class primitive.
7. Upgrade context management to priority-aware budgeting.
8. Make subagents child runs with independent budgets and cancellation.
9. Add cost-aware model selection.
10. Make provider fallback execution-state aware.

## P2 — Platform consistency

11. Establish one canonical model/capability/pricing registry.
12. Connect existing step-level Usage data to stable run/step/tool IDs.
13. Unify Gateway and Agents traces around one execution graph.
14. Expose a clean Harness Runtime API.

## P3 — Advanced differentiation

15. Adaptive context estimation from actual provider usage.
16. Verification-driven recovery loops.
17. Policy-driven routing based on cost, latency, quality, and provider health.
18. Cross-run evaluation and harness performance analytics.
19. Portable skills/tools/harness configuration.

---

# 17. Final architecture target

```text
                         ENTRY
                           |
                +----------+----------+
                |                     |
           Agent API            Workflow API
                |                     |
                +----------+----------+
                           |
                    ENTRY HARNESS
                           |
    +----------+-----------+-----------+----------+
    |          |           |           |          |
 Context   Execution    Policy      Sandbox   Verification
    |          |           |           |          |
    +----------+-----------+-----------+----------+
                           |
                    Model Orchestrator
                           |
                    +------+------+
                    |             |
              Entry Gateway   Cache/Cost
                    |
        +-----------+-----------+-----------+
        |           |           |           |
      OpenAI     Anthropic    Gemini    Other providers
```

The final goal is a runtime that can reliably:

**plan -> execute -> observe -> verify -> recover -> continue -> finish**

while the Gateway makes model selection, provider reliability, caching, and economics transparent to the harness.

---

# Overall assessment

| Area | Assessment |
|---|---|
| Model abstraction | Strong |
| Gateway architecture | Strong |
| Provider flexibility | Strong |
| Streaming | Strong foundation |
| Cost accounting | Strong foundation |
| Prompt caching | Strong foundation; canonical accounting needed |
| Context management | Very good foundation |
| Agent loop | Good |
| Durable execution | Promising/important strength |
| Tool architecture | Needs stronger execution contract |
| Permissions | Needs runtime-level enforcement audit |
| Sandbox recovery | Needs stronger durability guarantees |
| Subagents | Needs stronger isolation/budgeting |
| Verification | Biggest architectural opportunity |
| Observability | **Already present at UI/Usage level; deepen underlying trace model** |
| Idempotency | Needs to be formalized |
| Cost-aware orchestration | Major opportunity |
| Capability registry | Should move toward Gateway |
| General-purpose harness | Strong foundation; needs execution contracts |

## Bottom line

**Entry Agents + Entry Gateway should be evolved, not rewritten.**

The strongest path is to turn the existing pieces into explicit, durable contracts: execution state, tool execution, permissions, sandbox lifecycle, context, verification, model capabilities, pricing, fallback, and cost-aware orchestration.

The key product distinction should be:

> **Entry should be the system that reliably executes AI work — not merely the SDK that lets developers call models.**

---

# Addendum: review findings against the current codebase (2026-08-20)

The test plan above asked for a review of this document's accuracy against
the real code. Rather than a paper review, the sections below cite exact,
verified evidence from `entry-agents` and `entry-gateway` as they exist
today, so the roadmap items aren't purely theoretical.

## Section 9 (gateway fallback state-awareness) — CONFIRMED, still an open gap

`entry-gateway/server.js`'s `handle()` retries the next candidate route on
*any* throw from `proxy()`, with no check for whether the previous
candidate already started streaming to the real client:

```js
for (let i = 0; i < available.length; i++) {
  const r = available[i];
  ...
  try {
    await proxy(req, res, r, p, model, action, id, i > 0);
    return;
  } catch (e) {
    failures.push(`${provider}: ${e.message}`);
    ...
  }
}
if (!res.headersSent) res.status(502).json({ ... });
```

`res.headersSent` is only checked once, on the final failure response —
never before attempting the *next* candidate. `proxy()` calls
`res.status(response.status).set("x-gateway-request-id", id)` and then
copies upstream headers via `res.setHeader(k, v)` before it starts
streaming the body. If candidate #1 fails partway through an SSE stream
(headers already sent, some `res.write()` calls already flushed to the
real client) and `handle()` falls through to candidate #2, that second
`proxy()` call hits `res.setHeader()` on an already-sent response —
Node throws `ERR_HTTP_HEADERS_SENT` synchronously. That throw is caught by
`handle()`'s own try/catch (recorded as just another failure) and the loop
keeps trying remaining candidates, each hitting the identical error, until
candidates are exhausted — at which point `res.headersSent` is now `true`,
so the 502 branch is correctly skipped, but `res.end()` is never called
either. Net effect: the real end user's connection is left half-written
and never cleanly closed.

This is exactly the class of bug Section 9 describes in the abstract
(`REQUEST_STARTED_NO_OUTPUT` / `STREAMING` states retried as if they were
`REQUEST_NOT_STARTED`) — it is not hypothetical, it reproduces from the
current fallback loop as written. P0/P1 work on this should start with a
`res.headersSent` guard before attempting the next candidate at all (fail
closed with a clean stream termination instead of a corrupted retry).

## Section 1 (Gateway capabilities) — circuit breakers CONFIRMED real

`isCircuitOpen` / `recordBreakerFailure` / `recordBreakerSuccess` /
`getAllCircuitBreakers` are implemented and wired into `proxy()` (checked
before every upstream call, tripped on 5xx/429/network failure, exposed
per-route on `/health`). The "provider health/metrics" and "circuit
breakers" bullets in Section 1 are accurate, not aspirational.

## Section 12 (canonical pricing) — the "recent caching/pricing issue" is a real, dated incident

This isn't a hypothetical cautionary tale — it already happened:
`entry-gateway`'s `/v1/models` returned `route.cost` raw for `gpt-5.6-*` /
`gemini-*` / `gemma-*` routes using the fallback discount multiplier
instead of resolving the actual per-tier cache-read rate, and
`entry-agents`' cost estimator uses that endpoint as its *only* pricing
source for both UI display and the real credit-ledger debit — meaning
real user accounts were billed full input rate on cached tokens (no
discount) on every affected request from 2026-08-17 until the fix
(`resolvedCostFor()`) shipped 2026-08-19. A second, related bug in the
same area: `entry-agents`' `resolveCostTier` hardcoded the tier key
`context_over_200k` (grok-4.5's specific threshold) instead of matching
any `context_over_Nk`, so gpt-5.6's real 272k threshold silently never
applied (undercharge direction that time). Both are now fixed at the
point level, but neither fix moved pricing into one canonical
registry — Section 12's core recommendation (single source of truth
across `/v1/models`, costing, and analytics) is still the right call and
is still outstanding. Treat P2 item #11 as validated by a real incident,
not a speculative risk.

## Section 11 (observability) — one concrete step already taken toward the target shape

`workflow_runs.error_message` (migration 0047) plus
`serializeErrorForDiagnostics()` now persist the raw, server-side-only
error for a chat run, added specifically because Vercel Hobby's ~1hr log
retention made a real, repeating Luna failure unrecoverable to
root-cause after the fact. This is a small piece of the
`run_id -> step_id -> ...` execution graph Section 11 asks for (durable,
queryable, survives log rotation) — worth citing as evidence the
direction is already underway, not just recommended.

## Net effect on the priority roadmap

No section needs walking back. Section 9 and Section 12 both move from
"recommended because this class of bug is plausible" to "recommended
because this exact class of bug already happened in production" — if
anything, that raises their priority rather than lowering it. Suggest
tagging P0 item "audit permission enforcement at the actual execution
boundary" with a sibling item: **audit the gateway fallback loop for
`res.headersSent` before any retry** — same category of bug (untrusted
assumption about execution state), same fix shape (check real state
before acting), and now backed by a concrete reproduction path instead of
a hypothetical one.
