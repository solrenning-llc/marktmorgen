/**
 * Deleting one of an account's other stores deletes its files (lib/deleted-store-files.ts, app/api/store/stores).
 *
 * The defect (uploads audit, Claude 1, 12 November 2026): deleteStore removed the store's record and the route forgot
 * its integrations, webhooks and keys, but no file was ever deleted. An empty store (no product) still keeps its link,
 * page and email pictures under images/<imageFolder>/ and its community's pictures under community/<folder>/, which
 * app/api/image and the community route hand to anybody with the address; with the record gone, no job could find
 * them again, so they stayed, public and paid for, for good.
 */
import { readFileSync } from "node:fs";
import { claimHandle, createStore, deleteStore, imageFolder, setCommunity, storeFolder, storeRef } from "@/lib/store";
import { communityFolder } from "@/lib/community-image";
import { picturesKept, takePicturePlace } from "@/lib/community-files";
import { type FolderHands, deletedStoreFolders, removeDeletedStoreFiles } from "@/lib/deleted-store-files";
import { queueStoreForget, retryStoreForgets } from "@/lib/store-forget-retry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function rejects(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "maker@example.com";
  await claimHandle(owner, "maker-home", "Maker Home", "");
  const made = await createStore(owner, "maker-spare", "Maker Spare", "");
  if (!made.ok) throw new Error("no second store");
  const spare = made.store;
  const withCommunity = await setCommunity(storeRef(spare), true);
  const communityId = withCommunity!.community!.id;
  const cf = communityFolder(communityId);
  await takePicturePlace(`community/${cf}/${"a".repeat(16)}.jpg`, 10);

  const ref = storeRef(spare);
  const [folder, pictures, homeFolder, homePictures] = [await storeFolder(ref), await imageFolder(ref), await storeFolder(owner), await imageFolder(owner)];
  const kept = new Map<string, number>([
    [`images/${pictures}/${"b".repeat(32)}.webp`, 1],
    [`images/${pictures}/${"c".repeat(32)}.jpg`, 1],
    [`community/${cf}/${"a".repeat(16)}.jpg`, 1],
    [`vault/${folder}/p1/0011223344556677-left.pdf`, 1],
    [`stores/${folder}/p1/old.pdf`, 1],
    // The account's first store, and its pictures: never touched.
    [`images/${homePictures}/${"d".repeat(32)}.webp`, 1],
    [`vault/${homeFolder}/p2/0011223344556677-guide.pdf`, 1],
  ]);
  const listed: string[] = [];
  let failOn = "";
  const hands = (vault = true, blob = true): FolderHands => ({
    list: async (prefix) => {
      listed.push(prefix);
      return [...kept.keys()].filter((path) => path.startsWith(prefix));
    },
    remove: async (paths) => {
      if (failOn && paths.some((path) => path.startsWith(failOn))) throw new Error("the store did not answer");
      for (const path of paths) kept.delete(path);
    },
    vault: () => vault,
    blob: () => blob,
  });

  part("Which folders are a deleted store's");
  is("its own folders in both file stores, its pictures and its community's, made from its id alone", (await deletedStoreFolders(spare.sid, communityId)).map((f) => f.prefix), [`vault/${folder}/`, `stores/${folder}/`, `images/${pictures}/`, `community/${cf}/`]);
  is("with no community, no community folder", (await deletedStoreFolders(spare.sid, null)).length, 3);
  is("a community id in another shape names no folder", (await deletedStoreFolders(spare.sid, "../x")).length, 3);

  part("A deleted store's files go with it");
  is("deleting the store itself leaves them all, as it always did", [(await deleteStore(ref)).ok, kept.size], [true, 7]);
  failOn = `images/${pictures}/`;
  is("a folder that cannot be deleted fails the try, so the line tries again", await rejects(() => removeDeletedStoreFiles(spare.sid, communityId, hands())), true);
  is("after every other folder was still seen to", [...kept.keys()].filter((path) => !path.includes(homeFolder) && !path.includes(homePictures)).sort(), [`images/${pictures}/${"b".repeat(32)}.webp`, `images/${pictures}/${"c".repeat(32)}.jpg`].sort());
  is("and the community's picture count is kept until every file is gone", await picturesKept(cf), 1);
  failOn = "";
  is("tried again, the rest goes", await removeDeletedStoreFiles(spare.sid, communityId, hands()), 2);
  is("nothing of the deleted store is left, and the first store keeps everything", [...kept.keys()].sort(), [`images/${homePictures}/${"d".repeat(32)}.webp`, `vault/${homeFolder}/p2/0011223344556677-guide.pdf`].sort());
  is("its community's picture count is forgotten", await picturesKept(cf), 0);
  listed.length = 0;
  is("a file store this deployment is not set up for is not asked", [await removeDeletedStoreFiles(spare.sid, null, hands(false, true)), listed.some((prefix) => prefix.startsWith("vault/"))], [0, false]);

  part("The line remembers the community, and the route does both");
  await queueStoreForget(null, spare.sid, Date.now(), communityId);
  const seen: (string | null)[] = [];
  const tried = await retryStoreForgets(Date.now() + 10_000, Date.now(), async (_stats, _sid, community) => { seen.push(community); });
  is("a try from the line is handed the community the store had", [tried.done, seen], [1, [communityId]]);
  const route = readFileSync("app/api/store/stores/route.ts", "utf8");
  is("the studio's delete deletes the files on its first try, and puts the community in line when it fails", [
    route.includes("await removeDeletedStoreFiles(result.store.sid, result.store.community?.id ?? null);"),
    route.includes("queueStoreForget(result.store.statsId ?? null, result.store.sid, Date.now(), result.store.community?.id ?? null)"),
  ], [true, true]);
  is("and the daily line's own work deletes them too", readFileSync("lib/store-forget-retry.ts", "utf8").includes("await removeDeletedStoreFiles(sid, community);"), true);

  done();
}

void main();
