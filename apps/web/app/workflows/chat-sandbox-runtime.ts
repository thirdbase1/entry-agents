import { createHash } from "node:crypto";
import { discoverSkills } from "@open-agents/agent";
import {
  connectSandbox,
  type Sandbox,
  type SandboxState,
} from "@open-agents/sandbox";
import { getSessionById } from "@/lib/db/sessions";
import {
  ensureUploadsGitignored,
  IMAGE_UPLOADS_DIR,
} from "@/lib/sandbox/uploads-gitignore";
import { kickSandboxProvisioningWorkflow } from "@/lib/sandbox/provisioning-kick";
import { isSandboxActive } from "@/lib/sandbox/utils";
import { getSandboxSkillDirectories } from "@/lib/skills/directories";
import { getCachedSkills, setCachedSkills } from "@/lib/skills-cache";

type SessionRecord = NonNullable<Awaited<ReturnType<typeof getSessionById>>>;
type DiscoveredSkills = Awaited<ReturnType<typeof discoverSkills>>;

export type ResolvedChatSandboxRuntime = {
  sandboxState: SandboxState;
  /**
   * Present only when a live sandbox was actually connected this turn.
   * Absent when the sandbox is still provisioning, migrating, or failed --
   * the turn must not block on any of those, so the agent starts without a
   * workspace and its tools pick one up on their own later.
   */
  workingDirectory?: string;
  currentBranch?: string;
  environmentDetails?: string;
  skills: DiscoveredSkills;
  didSetupWorkspace: boolean;
  sessionTitle: string;
  repoOwner?: string;
  repoName?: string;
};

async function loadSessionSkills(params: {
  sessionId: string;
  sandboxState: SandboxState;
  sandbox: Sandbox;
}): Promise<DiscoveredSkills> {
  const cachedSkills = await getCachedSkills(
    params.sessionId,
    params.sandboxState,
  );
  if (cachedSkills !== null) {
    return cachedSkills;
  }

  const skillDirs = await getSandboxSkillDirectories(params.sandbox);
  const discoveredSkills = await discoverSkills(params.sandbox, skillDirs);
  await setCachedSkills(
    params.sessionId,
    params.sandboxState,
    discoveredSkills,
  );
  return discoveredSkills;
}

async function cachedSessionSkills(params: {
  sessionId: string;
  sandboxState: SandboxState;
}): Promise<DiscoveredSkills> {
  return (await getCachedSkills(params.sessionId, params.sandboxState)) ?? [];
}

type ReadySessionSandbox = {
  session: SessionRecord;
  didSetupWorkspace: boolean;
  /** True only when a usable sandbox is up right now. */
  liveSandbox: boolean;
};

/**
 * Validates the session and reports whether a sandbox is usable *without
 * ever waiting for one to come up*.
 *
 * AGENT-FIRST: kicking provisioning returns immediately; the caller never
 * blocks on it. Previously this waited (up to 120s for migration, then the
 * full provisioning run), which meant a user's message could not reach the
 * model until the VM existed. The sandbox is a tool, not a gate: real tool
 * calls still serialise correctly behind `sandboxLifecycleHooks
 * .beforeCommand()`, which reads live DB state at call time and self-heals
 * the moment provisioning lands.
 */
async function getReadySessionSandbox(params: {
  sessionId: string;
  userId: string;
}): Promise<ReadySessionSandbox> {
  const session = await getSessionById(params.sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  if (session.userId !== params.userId) {
    throw new Error("Unauthorized");
  }
  if (session.status === "archived") {
    throw new Error("Session is archived");
  }

  if (isSandboxActive(session.sandboxState)) {
    return { session, didSetupWorkspace: false, liveSandbox: true };
  }

  // Migration owns the workspace while the old sandbox is packed and
  // replaced. Never connect (or start a competing provision) mid-migration
  // -- just report "not live" and let this turn proceed without a
  // workspace; beforeCommand() blocks the actual tool use until it ends.
  if (session.lifecycleState === "migrating") {
    return { session, didSetupWorkspace: false, liveSandbox: false };
  }

  // Fire-and-forget: kick returns once the workflow run is claimed, without
  // waiting for the VM to finish provisioning.
  await kickSandboxProvisioningWorkflow(params.sessionId);

  return { session, didSetupWorkspace: true, liveSandbox: false };
}

/**
 * Resolves the session's workspace runtime for this turn.
 *
 * AGENT-FIRST CONTRACT: this never waits for a sandbox to start. When one
 * is already active it connects and discovers skills; when one is not, it
 * kicks provisioning in the background and returns the session context
 * only (no `workingDirectory`), so the model turn begins immediately and a
 * sandboxed tool call simply self-heals later via beforeCommand().
 *
 * Every value returned here crosses a `"use step"` boundary, so no property
 * may be `undefined`: the Workflow SDK rejects `undefined` outright and
 * fails the run with a non-retryable SerializationError. Optional fields
 * are therefore *omitted*, not set to undefined.
 */
export async function resolveChatSandboxRuntime(params: {
  userId: string;
  sessionId: string;
}): Promise<ResolvedChatSandboxRuntime> {
  "use step";

  const { session, didSetupWorkspace, liveSandbox } =
    await getReadySessionSandbox({
      sessionId: params.sessionId,
      userId: params.userId,
    });

  const sandboxState = session.sandboxState;
  if (!sandboxState) {
    throw new Error("Workspace setup failed");
  }

  const sessionContext = {
    sandboxState,
    didSetupWorkspace,
    sessionTitle: session.title,
    ...(session.repoOwner ? { repoOwner: session.repoOwner } : {}),
    ...(session.repoName ? { repoName: session.repoName } : {}),
  };

  if (!liveSandbox) {
    // No VM yet: hand back session context plus whatever skills were
    // already discovered on a previous turn. Omitting workingDirectory is
    // what tells the caller to run this turn without a workspace attached.
    return {
      ...sessionContext,
      skills: await cachedSessionSkills({
        sessionId: params.sessionId,
        sandboxState,
      }),
    };
  }

  const sandbox = await connectSandbox(sandboxState);

  const skills = await loadSessionSkills({
    sessionId: params.sessionId,
    sandboxState,
    sandbox,
  });

  return {
    ...sessionContext,
    workingDirectory: sandbox.workingDirectory,
    ...(sandbox.currentBranch !== undefined
      ? { currentBranch: sandbox.currentBranch }
      : {}),
    ...(sandbox.environmentDetails !== undefined
      ? { environmentDetails: sandbox.environmentDetails }
      : {}),
    skills,
  };
}

// ── Image attachment offload ────────────────────────────────────────
//
// Owner decision (2026-08-12): images attached in chat should never be
// re-sent to the model as raw multimodal content on every turn (expensive,
// and most of our current models aren't vision-capable anyway). Instead,
// write the decoded image once into the session's own sandbox filesystem
// and hand the agent nothing but the file path -- it already has `read`
// and `bash` tools to look at the file itself if it needs to.

export type PendingImageAttachment = {
  /** e.g. "image/png" */
  mediaType: string;
  /** data: URL, e.g. "data:image/png;base64,...." */
  dataUrl: string;
};

function extensionForMediaType(mediaType: string): string {
  const subtype = mediaType.split("/")[1] ?? "bin";
  // jpeg is the only common mismatch between MIME subtype and conventional extension.
  return subtype === "jpeg" ? "jpg" : subtype.replace(/[^a-z0-9]/gi, "");
}

function decodeImageDataUrl(dataUrl: string): Buffer {
  const commaIndex = dataUrl.indexOf(",");
  const base64Payload =
    commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
  return Buffer.from(base64Payload, "base64");
}

function buildImagePath(image: PendingImageAttachment, buffer: Buffer): string {
  // Content-addressed path: identical bytes always resolve to the same
  // path, so re-sending the same image across turns is a no-op (we check
  // existence before writing) instead of piling up duplicate files.
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const extension = extensionForMediaType(image.mediaType);
  return `${IMAGE_UPLOADS_DIR}/${hash}.${extension}`;
}

/**
 * Writes each attached image into the sandbox (skipping any that are
 * already there) and returns the workspace-relative path for each, in the
 * same order as the input array.
 */
export async function persistImageAttachmentsToSandbox(params: {
  sandboxState: SandboxState;
  images: PendingImageAttachment[];
}): Promise<string[]> {
  "use step";

  if (params.images.length === 0) {
    return [];
  }

  const sandbox = await connectSandbox(params.sandboxState);

  // Belt-and-suspenders: make sure this directory is gitignored *before*
  // writing anything into it, so there's no window where an uncommitted
  // auto-commit step (or the agent's own bash tool) could sweep it up.
  await ensureUploadsGitignored(sandbox);

  const paths: string[] = [];

  for (const image of params.images) {
    const buffer = decodeImageDataUrl(image.dataUrl);
    const path = buildImagePath(image, buffer);

    const alreadyExists = await sandbox
      .access(path)
      .then(() => true)
      .catch(() => false);

    if (!alreadyExists) {
      await sandbox.writeFileBuffer(path, buffer);
    }

    paths.push(path);
  }

  return paths;
}
