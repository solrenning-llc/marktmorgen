import { reserveStorage, bindStorage, releaseStorage, retireStorage } from "@/lib/storage-reservations";
import { storageUsed, type StorageUse } from "@/lib/storage-quota";
import { openVaultUpload, closeVaultUpload, abortVaultUpload, vaultReservationId, retireVaultSession, retireExpiredVaultSession, forgetVaultUploadRecord, headVault } from "@/lib/vault";
import { readVaultPath, UPLOAD_SECONDS } from "@/lib/vault-rules";

/**
 * Opens one upload against the folder's storage. With the store's fence (input.fence, lib/live-fence.ts), every write
 * of the open (the cleanup's, the reservation, the upload record, the bind and a release) is made only while the store
 * is live: a provider that answers after the store's erasure began writes nothing of it back, and the session it made
 * is retired (Codex L-20261120-0141). The route always passes it (app/api/store/vault/route.ts).
 */
export async function openReservedVault(input: Parameters<typeof openVaultUpload>[0], limit: number, measure: () => Promise<StorageUse> = () => storageUsed(input.folder, limit)) {
  const fence = input.fence;
  // Opportunistic cleanup is bounded to one session per admission attempt.
  await retireStorage(input.folder, Date.now() - UPLOAD_SECONDS * 1000,
    async row => !!row.pathname && !!row.uploadId && retireExpiredVaultSession(row.pathname, row.uploadId), fence);
  const entry = await reserveStorage(input.folder, input.bytes, limit, async () => {
    const held = await measure();
    if (held.available !== true) throw new Error("storage_unknown");
    return held.bytes;
  }, fence);
  let opened: Awaited<ReturnType<typeof openVaultUpload>> | undefined;
  try {
    opened = await openVaultUpload({ ...input, multipart: true, reservation: entry.id });
    if (!opened.ok) { await releaseStorage(input.folder, entry.id, fence).catch(gone); return opened; }
    await bindStorage(input.folder, entry.id, opened.upload.pathname, opened.sessionId, fence);
    return opened;
  } catch (error) {
    // No path or signatures have reached the browser at this point. The record is forgotten only once the provider
    // retired the session: refused, the record is what an expired-session sweep would still find it by.
    if (opened?.ok) {
      const retired = await retireVaultSession(opened.upload.pathname, opened.sessionId).catch(() => false);
      if (retired) await forgetVaultUploadRecord(opened.upload.pathname).catch(() => undefined);
    }
    await releaseStorage(input.folder, entry.id, fence).catch(() => undefined);
    throw error;
  }
}
/** A release refused because the store's erasure began: nothing of it is left to give back. Anything else is thrown. */
function gone(error: unknown): void {
  if (!(error instanceof Error && error.message === "storage_store_gone")) throw error;
}
async function release(pathname: string, id: string | undefined) {
  const folder = readVaultPath(pathname)?.folder;
  if (id && folder) await releaseStorage(folder, id).catch(error => console.error("storage reservation retained", error));
}
/**
 * Whether an upload is provably over with nothing kept: its record read back as gone (an exact null) and its object
 * as absent (a 404). Anything else, a read that cannot be told or a store that does not answer, is false.
 */
async function deadUpload(pathname: string): Promise<boolean> {
  const record = await vaultReservationId(pathname).then((id) => id === undefined, () => false);
  return record && (await headVault(pathname).catch(() => "unreachable" as const)) === null;
}
export async function closeReservedVault(pathname: string, etags: string[]) {
  const id = await vaultReservationId(pathname);
  const result = await closeVaultUpload(pathname, etags);
  if (result.ok) await release(pathname, id);
  // A file joined at the wrong size is deleted with its upload record (closeVaultUpload): nothing can close, cancel
  // or retire it after that, so its reservation is given back here (#4283). Only when both are confirmed: the record
  // read back as gone and the object as absent. A refusal with the record still there (a wrong part count, a
  // provider's refusal) keeps the upload open and its bytes held, and an answer that cannot be read gives nothing back.
  else if (id && result.reason === "invalid" && (await deadUpload(pathname))) await release(pathname, id);
  return result;
}
export async function abortReservedVault(pathname: string) {
  const id = await vaultReservationId(pathname);
  const result = await abortVaultUpload(pathname);
  if (result) await release(pathname, id);
  return result;
}
