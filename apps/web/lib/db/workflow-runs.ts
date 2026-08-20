import { and, desc, eq, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  classifyChatError,
  type ChatErrorCategory,
} from "@/lib/chat/friendly-error";
import { db } from "./client";
import { workflowRuns, workflowRunSteps } from "./schema";

export type WorkflowRunStatus = "completed" | "aborted" | "failed";

export type WorkflowRunStepTiming = {
  stepNumber: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  finishReason?: string;
  rawFinishReason?: string;
};

export async function recordWorkflowRun(data: {
  id: string;
  chatId: string;
  sessionId: string;
  userId: string;
  modelId?: string;
  status: WorkflowRunStatus;
  startedAt: string;
  finishedAt: string;
  totalDurationMs: number;
  stepTimings: WorkflowRunStepTiming[];
  errorMessage?: string;
}) {
  await db.transaction(async (tx) => {
    await tx
      .insert(workflowRuns)
      .values({
        id: data.id,
        chatId: data.chatId,
        sessionId: data.sessionId,
        userId: data.userId,
        modelId: data.modelId ?? null,
        status: data.status,
        startedAt: new Date(data.startedAt),
        finishedAt: new Date(data.finishedAt),
        totalDurationMs: data.totalDurationMs,
        errorMessage: data.errorMessage ?? null,
      })
      .onConflictDoNothing({ target: workflowRuns.id });

    if (data.stepTimings.length === 0) {
      return;
    }

    await tx
      .insert(workflowRunSteps)
      .values(
        data.stepTimings.map((stepTiming) => ({
          id: nanoid(),
          workflowRunId: data.id,
          stepNumber: stepTiming.stepNumber,
          startedAt: new Date(stepTiming.startedAt),
          finishedAt: new Date(stepTiming.finishedAt),
          durationMs: stepTiming.durationMs,
          finishReason: stepTiming.finishReason ?? null,
          rawFinishReason: stepTiming.rawFinishReason ?? null,
        })),
      )
      .onConflictDoNothing({
        target: [workflowRunSteps.workflowRunId, workflowRunSteps.stepNumber],
      });
  });
}

/**
 * Counts how many of a chat's recent FAILED runs (excluding the current
 * one) classify into the same error category. Used to decide whether to
 * append the "this looks like a repeating issue" note (see
 * toFriendlyChatErrorText's isRepeatFailure param) instead of the plain
 * "please try again" text -- added 2026-08-20 alongside the
 * errorMessage column, so a deterministic failure (same category every
 * retry) reads differently to the user than a one-off transient blip.
 *
 * Deliberately re-classifies the stored raw errorMessage text on every
 * call rather than storing a separate category column: classifyChatError
 * is a pure substring match and works fine against a plain string (see
 * extractErrorSignal), so there's nothing to keep in sync.
 */
export async function countRecentFailuresWithCategory(
  chatId: string,
  category: ChatErrorCategory,
  excludeRunId: string,
  lookbackLimit = 20,
): Promise<number> {
  const rows = await db
    .select({ errorMessage: workflowRuns.errorMessage })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.chatId, chatId),
        eq(workflowRuns.status, "failed"),
        ne(workflowRuns.id, excludeRunId),
      ),
    )
    .orderBy(desc(workflowRuns.startedAt))
    .limit(lookbackLimit);

  return rows.filter(
    (row) =>
      row.errorMessage && classifyChatError(row.errorMessage) === category,
  ).length;
}
