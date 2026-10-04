import "server-only";

/**
 * Delete the Modal Volume backing an archived session.
 *
 * The sandbox package owns the only place Modal credentials are resolved
 * (`modal/client.ts`), so this thin wrapper is how the app asks for a
 * volume deletion without ever seeing a token. It is server-only by design:
 * a volume deletion is irreversible and must never be reachable from the
 * client bundle.
 */
export async function deleteModalSessionVolume(volumeName: string) {
  const { deleteModalVolume, createModalClient } = await import(
    "@open-agents/sandbox"
  );
  const client = await createModalClient();
  await deleteModalVolume(client, volumeName);
}
