/**
 * Modal client construction + error classification.
 *
 * Kept separate from the sandbox implementation so that (a) credential
 * resolution has exactly one home, and (b) the error matchers can be
 * unit-tested without a live Modal account.
 *
 * Credentials come from `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET`, matching
 * Modal's documented machine-environment variables. Nothing here caches a
 * token beyond what ModalClient itself needs to sign requests, and no
 * token is ever written into sandbox state, tool output, or logs.
 */
import { ModalClient } from "modal";
import type { App, Image, Sandbox as ModalSandbox, Volume } from "modal";

/** Modal's App name for Entry. One App holds every Entry sandbox. */
export const MODAL_APP_NAME = "entry-agents";

let cachedApp: App | undefined;

/**
 * Create a ModalClient from ambient credentials.
 *
 * Throws a legible error when the credentials are absent rather than
 * letting Modal's own "no token" failure surface from deep inside the
 * SDK.
 */
export function createModalClient(): ModalClient {
  if (!isModalConfigured()) {
    throw new Error(
      "Modal is not configured: set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET.",
    );
  }
  return new ModalClient();
}

/** Whether the ambient environment carries usable Modal credentials. */
export function isModalConfigured(): boolean {
  const tokenId = process.env.MODAL_TOKEN_ID;
  const tokenSecret = process.env.MODAL_TOKEN_SECRET;
  return (
    typeof tokenId === "string" &&
    tokenId.length > 0 &&
    typeof tokenSecret === "string" &&
    tokenSecret.length > 0
  );
}

/** Resolve (creating if needed) the Modal App that owns our sandboxes. */
export async function getModalApp(
  client: ModalClient,
): Promise<App> {
  if (cachedApp) {
    return cachedApp;
  }
  cachedApp = await client.apps.fromName(MODAL_APP_NAME, {
    createIfMissing: true,
  });
  return cachedApp;
}

/** Resolve (creating if needed) a named Modal Volume. */
export async function getModalVolume(
  client: ModalClient,
  name: string,
): Promise<Volume> {
  return client.volumes.fromName(name, { createIfMissing: true });
}

/**
 * Delete a named Modal Volume. Only call this when the session that owns it
 * is being destroyed -- this is irreversible and the workspace on it is lost.
 *
 * The SDK has no `volumes.list()`, so a volume can only be deleted when its
 * name is already known (which is exactly the case for a session delete).
 */
export async function deleteModalVolume(
  client: ModalClient,
  name: string,
): Promise<void> {
  await client.volumes.delete(name);
}

/** Resolve a public registry image by tag. */
export function getModalImage(client: ModalClient, tag: string): Image {
  return client.images.fromRegistry(tag);
}

/** Reconnect to a running sandbox by id. Throws if it is gone. */
export async function getModalSandbox(
  client: ModalClient,
  sandboxId: string,
): Promise<ModalSandbox> {
  return client.sandboxes.fromId(sandboxId);
}

/**
 * Fold the useful parts of a thrown value into a single string.
 *
 * Modal's error classes do not all expose a `.body`/`.text` pair the way
 * the Vercel SDK's APIError does, so this reads the common shapes
 * defensively instead of importing every error type.
 */
export function toErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const parts: string[] = [error.message];
  const withBody = error as Error & {
    text?: unknown;
    body?: unknown;
    status?: unknown;
    cause?: unknown;
  };
  if (typeof withBody.text === "string") {
    parts.push(withBody.text);
  }
  if (withBody.body !== undefined) {
    if (typeof withBody.body === "string") {
      parts.push(withBody.body);
    } else {
      try {
        parts.push(JSON.stringify(withBody.body));
      } catch {
        // Non-serializable body -- message/text already captured above.
      }
    }
  }
  if (withBody.cause !== undefined && withBody.cause !== null) {
    parts.push(
      withBody.cause instanceof Error
        ? withBody.cause.message
        : String(withBody.cause),
    );
  }
  if (withBody.status !== undefined) {
    parts.push(`status ${String(withBody.status)}`);
  }
  return parts.join(" | ");
}

/**
 * The sandbox handle is dead: terminated, timed out, or never existed.
 *
 * Drives the "provision a fresh sandbox and remount the volume" recovery
 * path in connect.ts. Deliberately broad -- a 404/410/gone sandbox and a
 * NotFoundError all mean the same thing to us, and treating any of them
 * as fatal would wedge the session instead of re-provisioning.
 */
export function isModalSandboxGoneError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("notfound") ||
    message.includes("not found") ||
    message.includes("status 404") ||
    message.includes("status 410") ||
    message.includes("gone") ||
    message.includes("terminated") ||
    message.includes("has already finished") ||
    message.includes("sandbox is not running")
  );
}

/** Modal rejected the request as malformed (bad image, bad params). */
export function isModalBadRequestError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes("status 400") || message.includes("invalid");
}

/** Modal rejected the request for quota/resource reasons. */
export function isModalResourceExhaustedError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("status 429") ||
    message.includes("status 507") ||
    message.includes("quota") ||
    message.includes("capacity") ||
    message.includes("resource exhausted")
  );
}
