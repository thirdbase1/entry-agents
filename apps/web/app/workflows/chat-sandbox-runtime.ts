import { createHash } from "node:crypto";
import { discoverSkills } from "@entry/agent";
import {
  connectSandbox,
  type Sandbox,
  type SandboxState,
} from "@entry/sandbox";
import { getSessionById } from "@/lib/db/sessions";
import {
  kickSandboxProvisioningWorkflow,
  waitForSandboxProvisioningRun,
} from "@/lib/sandbox/provisioning-kick";
import { isSandboxActive } from "@/lib/sandbox/utils";
import { getSandboxSkillDirectories } from "@/lib/skills/directories";
import { getCachedSkills, setCachedSkills } from "@/lib/skills-cache";

type SessionRecord = NonNullable<Awaited<ReturnType<typeof getSessionById>>>;
type DiscoveredSkills = Awaited<ReturnType<typeof discoverSkills>>;

export type ResolvedChatSandboxRuntime = {
  sandboxState: SandboxState;
  workingDirectory: string;
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

async function getReadySessionSandbox(params: {
  sessionId: string;
  userId: string;
}): Promise<{ session: SessionRecord; didSetupWorkspace: boolean }> {
  let session = await getSessionById(params.sessionId);
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
    return { session, didSetupWorkspace: false };
  }

  const kick = await kickSandboxProvisioningWorkflow(params.sessionId);
  if (kick.runId) {
    await waitForSandboxProvisioningRun(kick.runId);
  }

  session = await getSessionById(params.sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  if (!isSandboxActive(session.sandboxState)) {
    throw new Error(session.lifecycleError ?? "Workspace setup failed");
  }

  return { session, didSetupWorkspace: true };
}

export async function resolveChatSandboxRuntime(params: {
  userId: string;
  sessionId: string;
}): Promise<ResolvedChatSandboxRuntime> {
  "use step";

  const { session, didSetupWorkspace } = await getReadySessionSandbox({
    sessionId: params.sessionId,
    userId: params.userId,
  });
  const sandboxState = session.sandboxState;
  if (!sandboxState) {
    throw new Error("Workspace setup failed");
  }
  const sandbox = await connectSandbox(sandboxState);

  const skills = await loadSessionSkills({
    sessionId: params.sessionId,
    sandboxState,
    sandbox,
  });

  return {
    sandboxState,
    workingDirectory: sandbox.workingDirectory,
    currentBranch: sandbox.currentBranch,
    environmentDetails: sandbox.environmentDetails,
    skills,
    didSetupWorkspace,
    sessionTitle: session.title,
    repoOwner: session.repoOwner ?? undefined,
    repoName: session.repoName ?? undefined,
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

const IMAGE_UPLOADS_DIR = "uploads";

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
