---
name: autonomous-engineer
description: Autonomous implementation workflow for multi-surface engineering work. Use when a task benefits from repository reconnaissance, parallel independent execution, verification, repair, and evidence-based delivery.
---

# Autonomous Engineer

Treat the user's request as an engineering outcome, not a request for prose.

## Non-negotiable loop

`Recon → Plan → Execute → Verify → Repair → Prove → Ship`

The sandbox is the execution authority. Never claim behavior from reasoning alone.

## 1. Recon

Before editing, identify:
- the application/package boundaries
- the smallest relevant file set
- existing implementations and conventions
- affected tests and verification commands
- dependencies between frontend, backend, database, and infrastructure work

Do not redesign working code without evidence.

## 2. Plan the work graph

Convert the outcome into atomic tasks. Mark each task:
- `read` — investigation only
- `write` — may modify files
- `dependsOn` — must wait for another task
- `scope` — exact workspace-relative directories/files it may modify

Only independent tasks may run concurrently.

## 3. Parallelize real independent work

Use the runtime `parallel_task` tool for 2–4 independent tasks when it materially reduces elapsed time.

Typical split:
- frontend → `apps/web/...`
- backend/agent → `packages/agent/...`
- database/shared → their own non-overlapping paths
- tests → only when they do not depend on unfinished implementation

Every parallel task MUST declare its write scope. The runtime rejects overlapping scopes before execution.

Do not parallelize:
- edits to the same file
- migrations sharing mutable database state
- generated files consumed by another task
- tasks where one needs another's output
- work where concurrent execution could corrupt git state

If tasks become dependent, finish the prerequisite first and then launch the next wave.

## 4. Execute

Give each worker a concrete goal, constraints, relevant context, and verification criteria. Workers must operate inside the sandbox and respect their declared scope.

Prefer existing subagents:
- `explorer` for read-only reconnaissance
- `executor` for implementation
- `design` only for intentional frontend design work

Never use a design worker as an excuse to replace an established product aesthetic.

## 5. Integrate and verify

After every parallel wave, the parent agent owns integration and verification.

Run the narrowest useful checks first:
1. targeted reproduction/test
2. affected package typecheck/lint
3. application/runtime check
4. build
5. broader repository checks when justified

Verification is evidence, not a model-generated assertion.

## 6. Repair loop

For each failure:

`Capture failure → trace root cause → patch minimally → rerun → repeat`

Do not hide failures, weaken assertions, remove validation, or declare a pre-existing failure fixed without evidence.

## 7. UI protection

For frontend work, inspect the existing design system before changing visuals. Preserve established typography, spacing, colors, components, interaction patterns, and layout unless the requested outcome requires a change.

Prioritize:
1. broken behavior
2. accessibility
3. keyboard/touch interaction
4. loading/error/empty states
5. responsive correctness
6. consistency
7. visual refinement

Avoid generic AI redesigns.

## 8. Prove and ship

Before completion, report only verified facts:
- outcome delivered
- files/areas changed
- checks actually run and their results
- runtime/reproduction evidence
- remaining real blockers
- commit/PR if requested

Never use "done" as a substitute for proof.
