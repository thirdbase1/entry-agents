# Guided frontend workflow (design.md -> section-by-section build -> skill capture)

Summary: A structured mode for building frontends that replaces "one-shot the whole UI" with design.md as a source of truth, section-by-section build+audit using browser/computer-use, a systematic pass over commonly-skipped states, and an end-of-run option to save the whole workflow as a reusable Global Skill. Inspired by a public workflow writeup (MystiqueMide, X, 2026-08-25); adapted to Entry's existing sandbox + Global Skills + preferences infrastructure rather than introduced as new primitives.

## Context

- Entry already has a sandbox with browser/computer-use capability (used for self-testing/screenshots elsewhere in the agent harness).
- Entry already has a Global Skills concept (`lib/skills/global-skill-refs.ts`, surfaced in `defaultPermissionMode`/preferences UI) that users attach to future sessions -- this workflow's "save as skill" step should produce exactly that artifact, not a new mechanism.
- Today, a "build me a frontend" request goes straight to code generation with no structured design phase and no systematic pass over loading/empty/error/validation/a11y states. Quality is inconsistent and entirely dependent on how detailed the user's prompt was.
- Sessions already track sandbox lifecycle and workflow state (`app/workflows/chat.ts`); this feature is a mode layered on top of the existing agent step loop, not a new execution engine.

## Trigger

- Intent detection on new or existing chat: user asks to build/redesign a frontend, or explicitly asks to "use the guided frontend workflow."
- If the project already has frontend code but no `design.md`: enter "reverse-engineer" sub-mode first (read existing components/styles/tokens, draft a design.md from what's actually there) before asking the user anything net-new.
- If the project is backend-only (no UI code, no frontend framework detected): this mode never triggers automatically; it's opt-in only via explicit request.

## Phase 1: design.md

1. Agent asks a short guided Q&A: product feel/tone, target audience, typography/spacing/color tokens, copy voice, primary user flows.
2. Drafts `design.md` at the repo root (mirrors where `AGENTS.md`/`CLAUDE.md`-style files already live in generated projects), shows it to the user, iterates until approved.
3. `design.md` becomes the source of truth referenced by every later phase and by the agent's own system prompt for that session while this mode is active.

### Scenarios

- User wants to skip straight to code ("just build it, skip design doc"): allowed. Session is flagged internally as one-shot mode so Phase 2/3 know there's no source of truth to audit against -- audits fall back to general best-practice checks instead of design.md conformance checks.
- Existing brand assets or a component library already present: agent merges into a draft design.md rather than overwriting; any real contradiction between what's asked for and what already exists is surfaced explicitly as a numbered list, not silently resolved one way.
- Multi-brand / white-label project: support named variants (`design.md`, `design.client-x.md`) instead of forcing one document to cover every brand.
- User keeps changing their mind on tokens/tone mid-Q&A: cap the Q&A at one revision round before moving to a draft; further changes happen as edits to the draft itself, not infinite back-and-forth in chat.

## Phase 2: section-by-section build + audit

1. Agent proposes a build order derived from `design.md`'s flows (e.g. landing -> auth -> dashboard -> settings); user can reorder before starting.
2. Per section: build -> open in the sandbox's browser/computer-use -> click through real states -> list concrete issues found -> fix -> re-check.
3. A section is "done" when the audit pass finds nothing new, or the fix-loop cap below is hit.

### Scenarios

- Fix-loop cap: max 3 audit passes per section. On the 4th, stop and hand the remaining issue list to the user instead of looping indefinitely chasing polish.
- No browser/computer-use available in the current sandbox mode (e.g. a lightweight/ephemeral session): fall back to static code + any available screenshot diffing; the section's audit result is labeled "lower confidence -- no live inspection" in the UI so users know not to treat it the same as a real click-through.
- User rejects a fix the agent proposes: log it as a candidate `design.md` amendment (with the reasoning) rather than silently discarding it -- keeps the doc from drifting out of sync with what was actually decided.
- Backend-only section (e.g. an API-only feature added mid-project): this phase is skipped for it automatically; no forced UI ritual for non-UI work.
- User wants to jump straight to a later section (e.g. "just do settings, skip dashboard for now"): allowed; order is a suggestion, not a gate.

## Phase 3: systematic pass over commonly-skipped states

Run once, after all sections in the current pass exist -- not per-section, to avoid N redundant full-app passes. Checklist, each item gets pass/fail plus a link to the specific screen/state that failed, surfaced in a checklist UI element rather than buried in chat:

1. Loading states
2. Empty states
3. Errors
4. Validation
5. Mobile responsiveness
6. Navigation
7. Feedback after actions
8. Accessibility
9. Consistency between screens

### Scenarios

- A checklist item doesn't apply to this project at all (e.g. no auth -> no auth error states): marked "n/a" with a one-line reason, not silently skipped/omitted, so the user can see it was considered.
- User disagrees with a "fail" (e.g. thinks the mobile layout is fine as-is): item can be manually marked resolved/accepted by the user; the checklist keeps that decision instead of the agent re-flagging it every future audit pass.

## Phase 4: skill capture

1. At the end of a completed workflow, Entry offers: "save this as a reusable skill?"
2. Generates a skill doc covering: design rules actually applied, patterns used, and specific mistakes the agent made and self-corrected during Phase 2/3 -- stored via the existing Global Skills mechanism, referenced the same way any other global skill is (`globalSkillRefs` in user preferences).

### Scenarios

- User already has a similar skill saved: offer merge-into-existing vs save-as-new; never silently duplicate.
- Skill needs to generalize to a future project with a different `design.md`: skill content is written in terms of principles/patterns/anti-patterns, not literal token values, so it stays portable across projects with different visual identities.
- User declines to save a skill: workflow just ends; no artifact created, nothing forced.

## Cost / UX considerations

- This mode costs materially more turns than one-shot generation (Q&A + per-section audits). Before starting, show a rough turn/cost estimate so credit-conscious users can opt for a lighter variant (design.md only, skip the Phase 2 audit loop, or skip Phase 3 entirely).
- All of Phase 1-4 state (design.md path, current section, checklist results) should live in existing session/workflow state, not a new table, unless a concrete need for cross-session persistence beyond "the file lives in the repo" emerges.

## Open questions / not yet decided

- Exact intent-detection heuristic for auto-triggering vs requiring an explicit opt-in phrase -- needs real usage data before over-fitting a rule.
- Whether Phase 3's checklist should be reusable standalone (i.e. runnable against an existing project with no Phase 1/2 history) -- plausible follow-up, not in scope for v1.
- Whether to expose Phase 2's per-section audit as a user-visible progress panel in the session UI, or keep it purely in the agent's chat narration for v1 and add UI later if it proves valuable.
