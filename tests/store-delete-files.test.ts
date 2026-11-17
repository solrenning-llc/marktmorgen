/**
 * An extra store deleted from the studio (app/api/store/stores, lib/store.ts deleteStore) takes its files with it:
 * the pictures in its picture folder (images/<imageFolder>/: its links', its pages', its emails' pictures) and
 * whatever is left in its own folder (stores/<storeFolder>/: an upload never attached). Before, they stayed in the
 * file store for good: the store's record is gone, so no page, job or closing (lib/plan-closing.ts removeStored reads
 * the record first) ever finds them again, and they were kept, and paid for, for ever. A folder that cannot be listed,
 * or a delete that fails, puts the store in the daily line (lib/store-forget-retry.ts), which lists every folder
 * again, never lost. Synthetic only.
 */
import { NextRequest } from "next/server";
import { POST as storesRoute } from "@/app/api/store/stores/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { sweepTaskUploads } from "@/lib/assignment";
import { deleteFile } from "@/lib/file-store";
import { queueStoreForget, retryStoreForgets } from "@/lib/store-forget-retry";
import { claimHandle, createStore, ensureStatsId, imageFolder, storeFolder, storeRef } from "@/lib/store";
import { files, state } from "./store-delete-files-world";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

async function deleteFromStudio(owner: string, handle: string, sid: string) {
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const form = new FormData();
  form.set("action", "delete");
  form.set("confirm", handle);
  return storesRoute(new NextRequest("https://marktmorgen.com/api/store/stores", { method: "POST", headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie, "x-nimbus-store": sid }, body: form }));
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};

  part("An empty extra store with pictures on its links and pages");
  const owner = "files-owner@example.com";
  await claimHandle(owner, "filesfirst", "Files first", "");
  await ensureStatsId(owner);
  const made = await createStore(owner, "filesextra", "Files extra", "");
  if (!made.ok) throw new Error("no extra store");
  const ref = storeRef(made.store);
  const picture = `images/${await imageFolder(ref)}/link-picture.webp`;
  const leftover = `stores/${await storeFolder(ref)}/never-attached.zip`;
  const homePicture = `images/${await imageFolder(owner)}/home-picture.webp`;
  files.set(picture, 40_000);
  files.set(leftover, 900_000);
  files.set(homePicture, 40_000);
  const response = await deleteFromStudio(owner, "filesextra", made.store.sid);
  is("the store is deleted", [response.status, response.headers.get("Location")?.includes("stores=deleted")], [303, true]);
  is("its pictures and its leftover file are deleted with it", [files.has(picture), files.has(leftover)], [false, false]);
  is("the account's first store keeps its own", files.has(homePicture), true);
  // Claude 6's MEDIUM on #4348 @8a05d01969: every folder listed at the delete, a round the closing walk's admission
  // starts later (lib/closed-store-data.ts admitDeleted) forgets the keys only, and lists none of its folders again.
  const filesAsked: boolean[] = [];
  await queueStoreForget(made.store.statsId ?? null, made.store.sid);
  await retryStoreForgets(Date.now() + 30_000, Date.now(), async (_statsId, _sid, _community, _until, filesToo) => {
    filesAsked.push(filesToo);
  });
  is("a round the walk starts after it does not list its folders again", filesAsked, [false]);

  part("A file store that does not answer at the delete");
  const second = await createStore(owner, "filesother", "Files other", "");
  if (!second.ok) throw new Error("no second extra store");
  const otherPicture = `images/${await imageFolder(storeRef(second.store))}/page-picture.webp`;
  files.set(otherPicture, 40_000);
  // Claude 5's MEDIUM on #4348 @9f5c3bc5b2: a delete that failed handed each path, one by one, to the uploads sweep
  // (a ZADD each, unpriced, its failure only logged) and still noted the store's files as seen to, so a round the
  // walk started later never listed them again. Now the store goes in the line, with its community, which lists every
  // folder again under its priced ceiling, and nothing is noted over files that are still there.
  state.failing = true;
  const failed = await deleteFromStudio(owner, "filesother", second.store.sid);
  state.failing = false;
  is("the store is still deleted", [failed.status, failed.headers.get("Location")?.includes("stores=deleted")], [303, true]);
  const [handed, noted, queued] = (await redis.pipeline([
    ["ZSCORE", "nl:tasks:doors", otherPicture],
    ["HEXISTS", "nl:forget:files", second.store.sid],
    ["HGETALL", "nl:forget:q"],
  ])) as [string | null, number, string[]];
  is(
    "nothing is handed to the uploads sweep path by path, its files are not noted as seen to, and the store is in the line",
    [handed, noted, queued.some((field) => field.endsWith(`|${second.store.sid}`))],
    [null, 0, true],
  );
  const swept = await sweepTaskUploads(deleteFile, Date.now() + 2 * 86_400_000);
  is("the uploads sweep has nothing of it", swept.includes(otherPicture), false);
  const again = await retryStoreForgets(Date.now() + 30_000);
  is("the line's next try lists it again and deletes its picture", [again.done, files.has(otherPicture)], [1, false]);

  // Merge of main into #4348 (16 November 2026): a folder that cannot be listed at the delete was only said in the
  // log, and kept for good; it now puts the store in the daily line (lib/store-forget-retry.ts), which lists again.
  part("A file store that cannot list at the delete");
  const third = await createStore(owner, "filesthird", "Files third", "");
  if (!third.ok) throw new Error("no third extra store");
  const thirdPicture = `images/${await imageFolder(storeRef(third.store))}/kept-picture.webp`;
  files.set(thirdPicture, 40_000);
  state.listFailing = true;
  const unlisted = await deleteFromStudio(owner, "filesthird", third.store.sid);
  state.listFailing = false;
  is("the store is still deleted", [unlisted.status, unlisted.headers.get("Location")?.includes("stores=deleted")], [303, true]);
  const [line] = (await redis.pipeline([["HGETALL", "nl:forget:q"]])) as [string[]];
  is("its picture is still there, and the store is in the daily line", [files.has(thirdPicture), line.some((field) => field.endsWith(`|${third.store.sid}`))], [true, true]);
  const retried = await retryStoreForgets(Date.now() + 30_000);
  is("the line's next try lists it again and deletes its picture", [retried.done, files.has(thirdPicture)], [1, false]);
  done();
}

void main();
