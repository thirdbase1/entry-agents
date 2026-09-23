---
name: sandbox
description: >
  How the session sandbox (workspace VM) is created, when it is NOT available, and
  what an agent must do about it. Use whenever a bash/read/write/edit/glob/grep
 /web_fetch tool call fails because the workspace is still starting up, stopped,
  or was migrated, or when answering a question that does not need a workspace.
---

# The sandbox is a dependency, never a precondition

Your workspace (sandbox) is provisioned **asynchronously** and may not exist when
your turn starts. That is normal, and it is not a reason to stop working.

**The ruling principle: answer the user first, use the sandbox only if the answer
actually needs it.** A slow or failed workspace must never be the reason a user
gets no reply.

## When the workspace is not ready yet

Tools that need the workspace (`bash`, `read`, `write`, `edit`, `glob`, `grep`,
`web_fetch`) fail with a "workspace is not ready" style error until provisioning
finishes. Provisioning keeps running in the background while you answer.

Do this, in order:

1. **Answer from what you already have.** The conversation, the model's own
   knowledge, and any earlier tool results in the turn are yours to use. Most
   questions — planning, explanations, writing text, review of content already
   in context — need no workspace at all.
2. **Say the workspace is starting, briefly, once.** One sentence is enough
   ("My workspace is still starting up, so I can't run code yet"). Do not
   apologize at length and do not repeat it on every step.
3. **Retry later in the same turn, not immediately.** If the request genuinely
   needs the workspace, finish the parts that don't, then try one workspace
   tool again. Each tool call re-reads the session's live state, so a tool that
   failed before can succeed a moment later without any ceremony.
4. **Never loop.** Do not spend consecutive steps polling for readiness, and do
   not schedule sleeps or retry chains hoping it comes back. One honest retry,
   then tell the user to resend if it's still down.

## What a workspace error means

A workspace tool error is a **tool result, not a turn failure**. Surface it as
one plain sentence of context next to your actual answer, and keep going. The
turn is not broken and you do not need to explain internals (provisioning
workflows, VM snapshots, lifecycle states, run ids) to the user.

If the workspace was **migrated** mid-turn, the command you already started is
re-run against the fresh workspace. Do not re-issue it yourself.

## Things that are true even with a workspace

- If the user hasn't connected GitHub, do not call GitHub write APIs. Reviewed
  changes are pushed by the application, outside the sandbox.
- Each sandbox is ephemeral. Don't assume a file you wrote earlier in a
  different session is still there.
