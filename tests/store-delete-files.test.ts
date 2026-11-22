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
import { FORGET_TRIES, queueStoreForget, retryStoreForgets } from "@/lib/store-forget-retry";
import { eraseClosed } from "@/lib/closed-store-data";
import { finishClosed } from "@/lib/plan-closing";
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

  part("A webhook failure never spends the file cleanup round without trying its readable files");
  const blocked = await createStore(owner, "filesblocked", "Files blocked", "");
  if (!blocked.ok) throw new Error("no extra store for independent cleanup");
  const blockedRef = storeRef(blocked.store);
  const blockedStore = (await ensureStatsId(blockedRef))!;
  const blockedPicture = `images/${await imageFolder(blockedRef)}/person-picture.webp`;
  files.set(blockedPicture, 40_000);
  state.listFailing = true;
  try { await deleteFromStudio(owner, "filesblocked", blocked.store.sid); }
  finally { state.listFailing = false; }
  is("the initially unreadable picture is still queued", [files.has(blockedPicture), redis.run(["HEXISTS", "nl:forget:q", `${blockedStore.statsId}|${blocked.store.sid}`])], [true, 1]);
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = async commands => {
    if (commands.some(([name, key]) => name === "LRANGE" && key === `nl:hooks:log:${blockedStore.statsId}`)) throw new Error("synthetic webhook log outage");
    return pipeline(commands);
  };
  let givenUp = 0;
  try {
    for (let i = 1; i < FORGET_TRIES; i++) {
      const attempt = await retryStoreForgets(Date.now() + 30_000);
      givenUp += attempt.gaveUp;
      is("an unavailable Redis family never reports the whole cleanup done", attempt.done, 0);
    }
  } finally { redis.pipeline = pipeline; }
  is("webhooks remain unconfirmed but their failure did not retain the readable picture", [givenUp, files.has(blockedPicture)], [1, false]);
  await queueStoreForget(blockedStore.statsId, blocked.store.sid);
  await retryStoreForgets(Date.now() + 30_000);
  is("a later Redis-only recovery has no forgotten picture left behind", files.has(blockedPicture), false);


  part("A readable file pass cut off after a Redis failure keeps its unspent try");
  const late = await createStore(owner, "fileslate", "Files late", "");
  if (!late.ok) throw new Error("no extra store for bounded cleanup");
  const lateRef = storeRef(late.store);
  const lateStore = (await ensureStatsId(lateRef))!;
  const latePicture = `images/${await imageFolder(lateRef)}/person-late.webp`;
  files.set(latePicture, 40_000);
  state.listFailing = true;
  try { await deleteFromStudio(owner, "fileslate", late.store.sid); }
  finally { state.listFailing = false; }
  const realNow = Date.now;
  let clock = realNow();
  const until = clock + 5000;
  Date.now = () => clock;
  redis.pipeline = async commands => {
    if (commands.some(([name, key]) => name === "LRANGE" && key === `nl:hooks:log:${lateStore.statsId}`)) {
      clock = until + 1;
      throw new Error("synthetic webhook outage at the deadline");
    }
    return pipeline(commands);
  };
  try {
    const cut = await retryStoreForgets(until, clock);
    const entry = JSON.parse(String(redis.run(["HGET", "nl:forget:q", `${lateStore.statsId}|${late.store.sid}`])));
    is("the deadline retains the picture and spends a late pass, not a failed try", [cut.left, cut.failed, entry.tries, entry.late, files.has(latePicture)], [1, 0, 1, 1, true]);
  } finally { redis.pipeline = pipeline; Date.now = realNow; }
  const lateRecovered = await retryStoreForgets(Date.now() + 30_000);
  is("the next bounded run deletes its picture and finishes", [lateRecovered.done, files.has(latePicture)], [1, false]);

  // Codex X6's LOW on #4348 @0b21818b90: a request cut off while it deleted the files (its function's time out) neither
  // noted them nor put the store in line, so the folders it had not reached yet were kept for good. The walk's entry is
  // written before the record goes (queueDeleted), and its admission now puts such a store in line for its files.
  part("A delete cut off part way through its files");
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  // A walk begins a day after the last one began (WALK_GAP_MS): each walk below is a day after the one before.
  const DAY = 86_400_000;
  const walkAt = Date.now();
  await eraseClosed(Date.now() + 20_000, finishClosed, walkAt);
  for (const field of (redis.run(["HKEYS", "nl:forget:q"]) as string[])) redis.run(["HDEL", "nl:forget:q", field]);
  const cut = await createStore(owner, "filescut", "Files cut", "");
  if (!cut.ok) throw new Error("no extra store to cut off");
  const cutRef = storeRef(cut.store);
  const cutPicture = `images/${await imageFolder(cutRef)}/cut-picture.webp`;
  const cutLeftover = `stores/${await storeFolder(cutRef)}/cut-upload.zip`;
  files.set(cutPicture, 40_000);
  files.set(cutLeftover, 900_000);
  state.cutOff = true;
  void deleteFromStudio(owner, "filescut", cut.store.sid);
  for (let i = 0; i < 200 && files.has(cutPicture); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 50));
  state.cutOff = false;
  const cutField = (redis.run(["HKEYS", "nl:forget:q"]) as string[]).find((field) => field.endsWith(`|${cut.store.sid}`));
  is(
    "cut off after its first folder: one file gone, one kept, nothing noted and nothing in line",
    [files.has(cutPicture), files.has(cutLeftover), redis.run(["HEXISTS", "nl:forget:files", cut.store.sid]), cutField],
    [false, true, 0, undefined],
  );
  await eraseClosed(Date.now() + 20_000, finishClosed, walkAt + DAY);
  const admitted = (redis.run(["HKEYS", "nl:forget:q"]) as string[]).filter((field) => field.endsWith(`|${cut.store.sid}`));
  is("the walk's admission puts it in line for its files", admitted.length, 1);
  const cutRound = await retryStoreForgets(Date.now() + 30_000);
  is("the line's round deletes the file the cut-off request never reached, and notes it", [cutRound.done, files.has(cutLeftover), redis.run(["HEXISTS", "nl:forget:files", cut.store.sid])], [1, false, 1]);

  part("A delete that saw to every file is not put in line again by the walk");
  const whole = await createStore(owner, "fileswhole", "Files whole", "");
  if (!whole.ok) throw new Error("no extra store seen to whole");
  const wholePicture = `images/${await imageFolder(storeRef(whole.store))}/whole-picture.webp`;
  files.set(wholePicture, 40_000);
  const wholeResponse = await deleteFromStudio(owner, "fileswhole", whole.store.sid);
  is("deleted, its picture with it, and its files noted as seen to", [wholeResponse.status, files.has(wholePicture), redis.run(["HEXISTS", "nl:forget:files", whole.store.sid])], [303, false, 1]);
  await eraseClosed(Date.now() + 20_000, finishClosed, walkAt + 2 * DAY);
  is("the walk's admission puts nothing in line for it", (redis.run(["HKEYS", "nl:forget:q"]) as string[]).some((field) => field.endsWith(`|${whole.store.sid}`)), false);

  done();
}

void main();
