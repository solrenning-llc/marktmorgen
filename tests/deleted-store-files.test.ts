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
import * as blobWorld from "./deleted-store-files-world";
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
  const hands = (vault = true): FolderHands => ({
    list: async (prefix) => {
      listed.push(prefix);
      return [...kept.keys()].filter((path) => path.startsWith(prefix));
    },
    remove: async (paths) => {
      if (failOn && paths.some((path) => path.startsWith(failOn))) throw new Error("the store did not answer");
      for (const path of paths) kept.delete(path);
    },
    vault: () => vault,
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
  is("a file store this deployment is not set up for is not asked", [await removeDeletedStoreFiles(spare.sid, null, hands(false)), listed.some((prefix) => prefix.startsWith("vault/"))], [0, false]);

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
  is("and the daily line's own work deletes them too", readFileSync("lib/store-forget-retry.ts", "utf8").includes("await removeDeletedStoreFiles(sid, community, undefined, until);"), true);

  // Review of #4348 (Claude 7), MÉDIO 1: Blob was taken as set up only from BLOB_READ_WRITE_TOKEN, and its folders were
  // passed over otherwise. @vercel/blob 2.8.0 also signs in with an OIDC token (from the environment or the request)
  // and BLOB_STORE_ID, tried first: a deployment set up that way deleted nothing, said 0, and never put it in line.
  part("Blob is asked however it is set up, and a Blob that cannot be asked fails the try");
  const env = { rw: process.env.BLOB_READ_WRITE_TOKEN, oidc: process.env.VERCEL_OIDC_TOKEN, storeId: process.env.BLOB_STORE_ID };
  const setEnv = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  setEnv("BLOB_READ_WRITE_TOKEN", undefined);
  setEnv("VERCEL_OIDC_TOKEN", "oidc-test-not-a-token");
  setEnv("BLOB_STORE_ID", "store_test");
  blobWorld.files.add(`images/${pictures}/${"e".repeat(32)}.webp`);
  blobWorld.files.add(`stores/${folder}/p1/left.pdf`);
  is("signed in by OIDC and a store id, with no read-write token: its pictures and files are deleted", [await removeDeletedStoreFiles(spare.sid, null), [...blobWorld.files]], [2, []]);
  setEnv("VERCEL_OIDC_TOKEN", undefined);
  setEnv("BLOB_STORE_ID", undefined);
  blobWorld.files.add(`images/${pictures}/${"f".repeat(32)}.webp`);
  is("with no Blob credentials in sight, the try fails (so the line tries again), never reads as nothing there", await rejects(() => removeDeletedStoreFiles(spare.sid, null)), true);
  is("and the picture is still counted as there, not as deleted", [...blobWorld.files], [`images/${pictures}/${"f".repeat(32)}.webp`]);
  setEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test_token");
  is("with a read-write token it goes", [await removeDeletedStoreFiles(spare.sid, null), [...blobWorld.files]], [1, []]);

  // MÉDIO 2: the daily line checked its deadline only before each store; a slow Blob ran one store's folders past it,
  // into the closing job's own time, and a pass the job cut off was counted as a failed try, until it was given up.
  part("A slow Blob stops at the line's deadline, and a pass cut off by it is not a try");
  let slowListed = 0;
  const slowHands: FolderHands = {
    list: async (prefix) => {
      slowListed += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return [...kept.keys()].filter((path) => path.startsWith(prefix));
    },
    remove: async (paths) => {
      for (const path of paths) kept.delete(path);
    },
    vault: () => true,
  };
  kept.set(`community/${cf}/${"g".repeat(16)}.jpg`, 1);
  const cutOff = await removeDeletedStoreFiles(spare.sid, communityId, slowHands, Date.now() + 30).then(() => "seen through", (error: unknown) => (error instanceof Error && /out of time/.test(error.message) ? "out of time" : String(error)));
  is("past its deadline it stops before the next folder and says it ran out of time", [cutOff, slowListed, kept.has(`community/${cf}/${"g".repeat(16)}.jpg`)], ["out of time", 1, true]);

  blobWorld.files.add(`stores/${folder}/p2/late.pdf`);
  blobWorld.files.add(`images/${pictures}/${"h".repeat(32)}.webp`);
  blobWorld.files.add(`community/${cf}/${"i".repeat(16)}.jpg`);
  await queueStoreForget(null, spare.sid, Date.now(), communityId);
  const line = async () => {
    const [flat] = (await redis.pipeline([["HGETALL", "nl:forget:q"]])) as [string[]];
    const at = flat.indexOf(`-|${spare.sid}`);
    return at < 0 ? null : (JSON.parse(flat[at + 1]) as { tries: number });
  };
  blobWorld.world.waitMs = 40;
  const late = await retryStoreForgets(Date.now() + 30);
  is("the daily line, on a slow Blob, stops at its deadline: the store is left for the next run, not failed", late, { done: 0, failed: 0, gaveUp: 0, left: 1 });
  is("it stays in line with its tries as they were", (await line())?.tries, 1);
  is("and what was not reached is still there", blobWorld.files.has(`community/${cf}/${"i".repeat(16)}.jpg`), true);
  blobWorld.world.waitMs = 0;
  const next = await retryStoreForgets(Date.now() + 10_000);
  is("the next run, in time, sees it through", [next, await line(), [...blobWorld.files]], [{ done: 1, failed: 0, gaveUp: 0, left: 0 }, null, []]);
  setEnv("BLOB_READ_WRITE_TOKEN", env.rw);
  setEnv("VERCEL_OIDC_TOKEN", env.oidc);
  setEnv("BLOB_STORE_ID", env.storeId);

  done();
}

void main();
