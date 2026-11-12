/**
 * The files of one of an account's other stores, deleted with it (app/api/store/stores, action "delete").
 *
 * Only an empty store can be deleted (lib/store.ts deleteStore: no product, no plan, no domain), but empty of
 * products is not empty of files: its link, page and email pictures (images/<imageFolder>/), its community's
 * pictures (community/<communityFolder>/: a community is switched on without any product), and whatever an earlier
 * delete or an upload never attached left in its own folders (vault/<folder>/, stores/<folder>/). The store's record
 * is gone the moment it is deleted, so no later job can find these folders from it: they go now, and a delete that
 * fails is put in the daily line of lib/store-forget-retry.ts, which runs this again from the store's id.
 *
 * app/api/image serves images/ to anybody with the address, with a year's cache, whether the store is there or not;
 * the privacy policy says a store's files go with it. Every folder is read to its end (lib/file-store.ts listFiles
 * throws on a page in any other shape), and a file that cannot be deleted throws, so the line tries again.
 *
 * A file store this deployment is not set up for (no vault settings, no Blob token) cannot hold anything it wrote,
 * so its folders are passed over rather than failing every try; one that is set up and does not answer fails.
 *
 * Its cost: one listing per folder page and one delete per hundred files, at the supplier's paid operation prices,
 * bounded by what the store kept (its storage brake) and run at most FORGET_TRIES times a deleted store.
 */
import { deleteFile, listFiles } from "@/lib/file-store";
import { communityFolder } from "@/lib/community-image";
import { forgetPictures } from "@/lib/community-files";
import { COMMUNITY_ID } from "@/lib/community-text";
import { imageFolder, storeFolder } from "@/lib/store";
import { isVaultConfigured } from "@/lib/vault";

/** Files deleted in one call. */
const DELETE_BATCH = 100;

export type FolderHands = {
  /** Every path under a prefix. Throws when it cannot be read to its end. */
  list: (prefix: string) => Promise<string[]>;
  /** Deletes files. Throws when one could not be. */
  remove: (pathnames: string[]) => Promise<void>;
  /** Which file stores this deployment is set up for. */
  vault: () => boolean;
  blob: () => boolean;
};

const HANDS: FolderHands = {
  list: listFiles,
  remove: deleteFile,
  vault: isVaultConfigured,
  blob: () => Boolean((process.env.BLOB_READ_WRITE_TOKEN ?? "").trim()),
};

/** The key one of an account's other stores is kept under (lib/store.ts storeRef), from which its folders are made. */
function refOf(sid: string): string {
  return `#${sid}`;
}

/** The folders a deleted store's files are in, each with the file store that keeps it. */
export async function deletedStoreFolders(sid: string, communityId: string | null): Promise<{ prefix: string; store: "vault" | "blob" }[]> {
  const ref = refOf(sid);
  const folder = await storeFolder(ref);
  return [
    { prefix: `vault/${folder}/`, store: "vault" },
    { prefix: `stores/${folder}/`, store: "blob" },
    { prefix: `images/${await imageFolder(ref)}/`, store: "blob" },
    ...(communityId && COMMUNITY_ID.test(communityId) ? [{ prefix: `community/${communityFolder(communityId)}/`, store: "blob" as const }] : []),
  ];
}

/**
 * Deletes every file of a deleted store, and its community's picture count. Returns how many were deleted; throws
 * when a folder could not be read to its end or a file could not be deleted, after trying every folder.
 */
export async function removeDeletedStoreFiles(sid: string, communityId: string | null, hands: FolderHands = HANDS): Promise<number> {
  let removed = 0;
  const failures: unknown[] = [];
  for (const { prefix, store } of await deletedStoreFolders(sid, communityId)) {
    if (store === "vault" ? !hands.vault() : !hands.blob()) continue;
    try {
      const paths = await hands.list(prefix);
      for (let at = 0; at < paths.length; at += DELETE_BATCH) {
        const some = paths.slice(at, at + DELETE_BATCH);
        await hands.remove(some);
        removed += some.length;
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "a deleted store's files could not all be deleted");
  if (communityId && COMMUNITY_ID.test(communityId)) await forgetPictures(communityFolder(communityId));
  return removed;
}
