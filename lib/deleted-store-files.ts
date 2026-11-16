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
 * The file store that charges nothing for a download (lib/vault.ts) is set up from this deployment's own settings
 * alone, so one not set up cannot hold anything it wrote, and its folder is passed over rather than failing every
 * try. Blob is never passed over: @vercel/blob signs in with a read-write token or with an OIDC token (from the
 * environment or the request) and a store id, which only the SDK can tell, so its folders are always asked, and
 * a Blob that cannot be asked (no credentials, no answer) fails the try, never reads as an empty folder (review of
 * #4348, MÉDIO 1).
 *
 * Past `until` (the daily line's deadline) it stops before the next folder or batch and throws OutOfTime: what was
 * not reached is not a failure, and the line keeps the store for its next run without counting a try (MÉDIO 2).
 *
 * Its cost (review of #4348, Claude 7's MÉDIO on f0320f0425): a pass lists each folder at most
 * DELETED_STORE_LIST_PAGES pages (a thousand paths a page; a folder with more fails the pass, which the line counts
 * and finally gives up and reports, never lists further), sends at most one delete a DELETED_STORE_DELETE_BATCH
 * files listed, and one Redis DEL for its community's picture count. The delete's own first try (app/api/store/stores,
 * forgetStoreFiles) lists with the same ceiling. A deleted store's files take the delete's own try and one round of
 * the line at most (lib/store-forget-retry.ts: a round that finished, or a delete that listed every folder, is noted
 * in nl:forget:files, and a round started after it forgets the keys only), FORGET_TRIES tries and FORGET_LATE_PASSES
 * passes cut off by the deadline in all; all of them priced, at Blob's paid Advanced Operation price, in the line deleted-store-files of
 * tests/plan-cost-registry.ts, held by tests/deleted-store-files-cost.test.ts.
 */
import { deleteFile, listFiles } from "@/lib/file-store";
import { communityFolder } from "@/lib/community-image";
import { forgetPictures } from "@/lib/community-files";
import { COMMUNITY_ID } from "@/lib/community-text";
import { imageFolder, storeFolder } from "@/lib/store";
import { isVaultConfigured } from "@/lib/vault";

/** Files deleted in one call. */
export const DELETED_STORE_DELETE_BATCH = 100;
/** Pages (a thousand paths each) one listing of a deleted store's folder may read: Blob's own page, as filesHeld bounds a store's folder. */
export const DELETED_STORE_LIST_PAGES = 20;

/** A deletion stopped at its deadline before every folder was seen to: not a failure, tried again whole next time. */
export class OutOfTime extends Error {
  constructor() {
    super("out of time: a deleted store's files were not all reached before the deadline");
    this.name = "OutOfTime";
  }
}

export type FolderHands = {
  /** Every path under a prefix. Throws when it cannot be read to its end. */
  list: (prefix: string) => Promise<string[]>;
  /** Deletes files. Throws when one could not be. */
  remove: (pathnames: string[]) => Promise<void>;
  /** Whether the file store that charges nothing for a download is set up here. Blob is always asked. */
  vault: () => boolean;
};

const HANDS: FolderHands = {
  list: (prefix) => listFiles(prefix, DELETED_STORE_LIST_PAGES),
  remove: deleteFile,
  vault: isVaultConfigured,
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
 * when a folder could not be read to its end or a file could not be deleted, after trying every folder, and
 * OutOfTime when `until` passed before every folder was seen to and nothing else failed.
 */
export async function removeDeletedStoreFiles(sid: string, communityId: string | null, hands: FolderHands = HANDS, until = Number.POSITIVE_INFINITY): Promise<number> {
  let removed = 0;
  const failures: unknown[] = [];
  let late = false;
  for (const { prefix, store } of await deletedStoreFolders(sid, communityId)) {
    if (store === "vault" && !hands.vault()) continue;
    if (Date.now() > until) {
      late = true;
      break;
    }
    try {
      const paths = await hands.list(prefix);
      for (let at = 0; at < paths.length; at += DELETED_STORE_DELETE_BATCH) {
        if (Date.now() > until) {
          late = true;
          break;
        }
        const some = paths.slice(at, at + DELETED_STORE_DELETE_BATCH);
        await hands.remove(some);
        removed += some.length;
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "a deleted store's files could not all be deleted");
  if (late) throw new OutOfTime();
  if (communityId && COMMUNITY_ID.test(communityId)) await forgetPictures(communityFolder(communityId));
  return removed;
}
