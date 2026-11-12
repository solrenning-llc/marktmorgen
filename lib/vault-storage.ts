import { reserveStorage, bindStorage, releaseStorage, retireStorage } from "@/lib/storage-reservations";
import { storageUsed, type StorageUse } from "@/lib/storage-quota";
import { openVaultUpload, closeVaultUpload, abortVaultUpload, vaultReservationId, retireVaultSession, headVault } from "@/lib/vault";
import { readVaultPath, UPLOAD_SECONDS } from "@/lib/vault-rules";

export async function openReservedVault(input: Parameters<typeof openVaultUpload>[0], limit: number, measure: () => Promise<StorageUse> = () => storageUsed(input.folder, limit)) {
  // Opportunistic cleanup is bounded to one session per admission attempt.
  await retireStorage(input.folder, Date.now() - UPLOAD_SECONDS * 1000,
    async row => !!row.pathname && !!row.uploadId && retireVaultSession(row.pathname, row.uploadId));
  const entry = await reserveStorage(input.folder, input.bytes, limit, async () => {
    const held = await measure();
    if (held.available !== true) throw new Error("storage_unknown");
    return held.bytes;
  });
  let opened: Awaited<ReturnType<typeof openVaultUpload>> | undefined;
  try {
    opened = await openVaultUpload({ ...input, multipart: true, reservation: entry.id });
    if (!opened.ok) { await releaseStorage(input.folder, entry.id); return opened; }
    await bindStorage(input.folder, entry.id, opened.upload.pathname, opened.sessionId);
    return opened;
  } catch (error) {
    // No path or signatures have reached the browser at this point.
    if (opened?.ok) await retireVaultSession(opened.upload.pathname, opened.sessionId).catch(() => false);
    await releaseStorage(input.folder, entry.id).catch(() => undefined);
    throw error;
  }
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
