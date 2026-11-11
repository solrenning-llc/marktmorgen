/**
 * A deleted store's records are erased as a closed store's are (Claude 6's probe P3 on #3643, rule 30).
 *
 * The studio's delete (app/api/store/stores, lib/store.ts deleteStore) took the store record, its id and its
 * addresses, and the route forgot what it knows by name (webhooks, keys, phones, notes...). Nothing went through the
 * closing walk's marks (lib/closed-store-data.ts, marksOf), so every other key named by the store's own ids stayed
 * for good with nothing naming it: its page photo (nl:store:photo:<id>, no expiry), its list of contacts, its
 * numbers. Now the store's walk entry is written under its lock before the record goes, waiting for the next walk
 * (one under way may have passed its keys already), and that walk erases every family CLOSING says is erased, as for
 * a closed store; the owner is not emailed that a store closed, since it was deleted.
 *
 * Rule 24: an entry not confirmed written throws with the record still there, so the person sees the error and can
 * try again; a record whose delete did not land is never walked (its entry waits while a delete may be under way,
 * and is dropped once none can be); a record not read leaves the entry waiting. Synthetic data, in-memory Redis.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { BATCH_KEY, WALK_KEY, eraseClosed } from "@/lib/closed-store-data";
import { CLOSING, closingFamilyOf } from "@/lib/data-families";
import { finishClosed } from "@/lib/plan-closing";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { type Store, claimHandle, createStore, ensureListId, ensureStatsId, setPhotoId, storeForEmail, storeForId, storeRef } from "@/lib/store";
import { readPhoto, writePhoto } from "@/lib/store-photo";
import { makeKey, resolveKey } from "@/lib/api-keys";
import { POST as storesRoute } from "@/app/api/store/stores/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const HOUR = 3_600_000;
const pipe = redis.pipeline.bind(redis);
const stateKey = (key: string) => `nl:plan:closing:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;

// Replies replaced for one kind of command, to stand for a reply that was lost or garbled (undefined: Redis's own).
let garble: ((command: (string | number)[]) => unknown[] | undefined) | undefined;
// Run once right after one command's reply is read, before the caller sees it: another request landing in between.
let after: { when: (command: (string | number)[]) => boolean; run: () => Promise<void> } | undefined;
// The same for a whole pipeline of several commands.
let garbleMany: ((commands: (string | number)[][]) => unknown[] | undefined) | undefined;
redis.pipeline = async (commands: (string | number)[][]) => {
  const swapped = commands.length === 1 && garble ? garble(commands[0]) : commands.length > 1 && garbleMany ? garbleMany(commands) : undefined;
  const reply = swapped ?? (await pipe(commands));
  const hook = after;
  if (hook && commands.length === 1 && hook.when(commands[0])) {
    after = undefined;
    await hook.run();
  }
  return reply;
};

async function allKeys(): Promise<string[]> {
  const out: string[] = [];
  let cursor = "0";
  do {
    const [reply] = (await pipe([["SCAN", cursor, "MATCH", "*", "COUNT", 1000]])) as [[string, string[]]];
    cursor = String(reply[0]);
    out.push(...reply[1]);
  } while (cursor !== "0");
  return out.sort();
}

/** Keys of a family the closing walk erases (not by address), named by one of these ids. */
async function erasableBy(ids: string[]): Promise<string[]> {
  const own = new Set(ids);
  return (await allKeys()).filter((key) => {
    const rule = CLOSING[closingFamilyOf(key)];
    return rule?.how === "erase" && !("by" in rule) && key.split(/[:|,]/).some((part) => own.has(part));
  });
}

const idsOf = (store: Store) => [store.sid, store.statsId, store.listId, store.photoId].filter((id): id is string => Boolean(id));

/** A store with a photo, a list with one contact and its numbers' id: what an extra store made and left empty keeps. */
async function furnished(ref: string): Promise<Store> {
  await ensureStatsId(ref);
  await ensureListId(ref);
  const photo = await writePhoto(new Uint8Array([137, 80, 78, 71, 1, 2, 3]), "image/png");
  await setPhotoId(ref, photo);
  const store = (await storeForEmail(ref))!;
  await pipe([["HSET", `nl:store:leads:${store.listId}`, "fan@example.test", JSON.stringify({ e: "fan@example.test" })]]);
  return store;
}

async function deleteFromStudio(owner: string, store: Store): Promise<string> {
  const form = new FormData();
  form.set("action", "delete");
  form.set("confirm", store.handle);
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const response = await storesRoute(new NextRequest("https://marktmorgen.com/api/store/stores", { method: "POST", headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie, "x-nimbus-store": store.sid }, body: form }));
  const to = response.headers.get("Location") ?? "";
  return to.includes("stores=deleted") ? "deleted" : to.includes("stores=error") ? "error" : to;
}

const inBatch = async (ref: string) => (await pipe([["HGET", BATCH_KEY, ref]]))[0];
const deadline = () => Date.now() + 20_000;

async function main(): Promise<void> {
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

  part("an extra store deleted from the studio: every key named by its ids is erased by the next walk");
  redis.clear();
  const OWNER = "keeps@example.test";
  await claimHandle(OWNER, "keepshome", "Keeps Home", "");
  const home = await furnished(OWNER);
  const made = await createStore(OWNER, "keepsextra", "Keeps Extra", "");
  if (!made.ok) throw new Error(`no extra store: ${JSON.stringify(made)}`);
  const extra = await furnished(storeRef(made.store));
  const ref = storeRef(extra);
  const theirs = await erasableBy(idsOf(extra));
  const homes = await erasableBy(idsOf(home));
  is("before: the extra store keeps its photo, its id, its list and its contact", [Boolean(await readPhoto(extra.photoId!)), theirs.includes(`nl:store:photo:${extra.photoId}`), theirs.includes(`nl:store:leads:${extra.listId}`), theirs.length >= 3], [true, true, true, true]);
  is("the studio answers that it is deleted, as before", await deleteFromStudio(OWNER, extra), "deleted");
  is("no longer found by its id", await storeForId(extra.sid), null);
  is("it waits in the walk's line, its record gone", [typeof (await inBatch(ref)), await storeForEmail(ref)], ["string", null]);
  const now = Date.now();
  const walked = await eraseClosed(deadline(), finishClosed, now);
  is("the next walk takes it and is done", [walked.started, walked.done], [true, true]);
  is("every key named by its ids is gone, its photo too", [await erasableBy(idsOf(extra)), await readPhoto(extra.photoId!)], [[], null]);
  is("it left the walk's line", await inBatch(ref), null);
  is("no closing record is written for it: its owner is never told a store closed", (await pipe([["GET", stateKey(ref)]]))[0], null);
  is("the owner's first store keeps every key of its own", [await erasableBy(idsOf(home)), Boolean(await readPhoto(home.photoId!)), (await storeForEmail(OWNER))?.handle], [homes, true, "keepshome"]);

  part("deleted while a walk is under way: that walk leaves it, the next one erases it");
  redis.clear();
  await claimHandle(OWNER, "keepshome", "Keeps Home", "");
  const late = await createStore(OWNER, "keepslate", "Keeps Late", "");
  if (!late.ok) throw new Error("no late store");
  const lateStore = await furnished(storeRef(late.store));
  const t0 = Date.now();
  await pipe([["HSET", WALK_KEY, "phase", "walk", "cursor", "0", "started", t0 - HOUR]]);
  is("deleted from the studio", await deleteFromStudio(OWNER, lateStore), "deleted");
  const under = await eraseClosed(deadline(), finishClosed, t0);
  is("the walk under way finishes without it: still in line, its keys still there", [under.done, typeof (await inBatch(storeRef(lateStore))), (await erasableBy(idsOf(lateStore))).length > 0], [true, "string", true]);
  const next = await eraseClosed(deadline(), finishClosed, t0 + 21 * HOUR);
  is("the next walk erases them and takes it out of line", [next.started, await erasableBy(idsOf(lateStore)), await inBatch(storeRef(lateStore))], [true, [], null]);

  part("rule 24: an entry not confirmed written keeps the store, and the person can try again");
  redis.clear();
  await claimHandle(OWNER, "keepshome", "Keeps Home", "");
  const kept = await createStore(OWNER, "keepskept", "Keeps Kept", "");
  if (!kept.ok) throw new Error("no kept store");
  const keptStore = await furnished(storeRef(kept.store));
  const keptKeys = await erasableBy(idsOf(keptStore));
  garble = (command) => (command[0] === "HSET" && command[1] === BATCH_KEY ? ["garbled"] : undefined);
  is("the studio says it went wrong", await deleteFromStudio(OWNER, keptStore), "error");
  garble = undefined;
  is("the store, its keys and its photo are all still there, nothing in line", [(await storeForId(keptStore.sid))?.handle, await erasableBy(idsOf(keptStore)), await inBatch(storeRef(keptStore))], ["keepskept", keptKeys, null]);
  is("trying again deletes it", await deleteFromStudio(OWNER, keptStore), "deleted");
  await eraseClosed(deadline(), finishClosed, Date.now());
  is("and the walk erases its keys", await erasableBy(idsOf(keptStore)), []);

  part("rule 24: a record whose delete did not land is never walked");
  redis.clear();
  await claimHandle(OWNER, "keepshome", "Keeps Home", "");
  const stays = await createStore(OWNER, "keepsstays", "Keeps Stays", "");
  if (!stays.ok) throw new Error("no staying store");
  const staysStore = await furnished(storeRef(stays.store));
  const staysRef = storeRef(staysStore);
  const staysKeys = await erasableBy(idsOf(staysStore));
  // The store record's own delete, fenced by its lock, answers something no script answers.
  garble = (command) => (command[0] === "EVAL" && /DEL/.test(String(command[1])) && String(command[3] ?? "").startsWith("nl:store:lock:") && String(command[4] ?? "").startsWith("nl:store:owner:") ? ["garbled"] : undefined);
  is("the studio says it went wrong", await deleteFromStudio(OWNER, staysStore), "error");
  garble = undefined;
  is("the store still stands, found by its id", (await storeForId(staysStore.sid))?.handle, "keepsstays");
  const t1 = Date.now();
  await eraseClosed(deadline(), finishClosed, t1);
  is("a walk while a delete may still be under way keeps its keys and leaves its entry waiting", [await erasableBy(idsOf(staysStore)), typeof (await inBatch(staysRef))], [staysKeys, "string"]);
  garble = (command) => (command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:closed-batch-swap:v1\n") ? ["garbled"] : undefined);
  const lost = await eraseClosed(deadline(), finishClosed, t1 + 2 * HOUR);
  garble = undefined;
  is("rule 24: a drop answered in an unknown shape keeps the entry, and the run is not done", [lost.done, typeof (await inBatch(staysRef)), await erasableBy(idsOf(staysStore))], [false, "string", staysKeys]);
  await eraseClosed(deadline(), finishClosed, t1 + 21 * HOUR);
  is("once no delete can be under way, its entry is dropped and its keys are kept", [await erasableBy(idsOf(staysStore)), await inBatch(staysRef), (await storeForId(staysStore.sid))?.handle], [staysKeys, null, "keepsstays"]);

  part("a retry inside a stale admission: its fresh entry is never dropped for the old one (Codex T and reviewer 2 on #3670)");
  redis.clear();
  await claimHandle(OWNER, "keepshome", "Keeps Home", "");
  const again = await createStore(OWNER, "keepsagain", "Keeps Again", "");
  if (!again.ok) throw new Error("no retried store");
  const againStore = await furnished(storeRef(again.store));
  const againRef = storeRef(againStore);
  garble = (command) => (command[0] === "EVAL" && /DEL/.test(String(command[1])) && String(command[3] ?? "").startsWith("nl:store:lock:") && String(command[4] ?? "").startsWith("nl:store:owner:") ? ["garbled"] : undefined);
  is("first delete fails, its entry E0 left waiting", [await deleteFromStudio(OWNER, againStore), typeof (await inBatch(againRef))], ["error", "string"]);
  garble = undefined;
  const e0 = await inBatch(againRef);
  let retried = "";
  // The walk's admission reads the record standing; the owner's retry runs to its end before the admission goes on.
  after = { when: (command) => command[0] === "GET" && String(command[1]).startsWith("nl:store:owner:"), run: async () => { retried = await deleteFromStudio(OWNER, againStore); } };
  const t2 = Date.now();
  await eraseClosed(deadline(), finishClosed, t2 + 2 * HOUR);
  after = undefined;
  is("the interleaving happened and the retry says deleted", retried, "deleted");
  is("the record is gone", await storeForEmail(againRef), null);
  const e1 = await inBatch(againRef);
  is("the retry's fresh entry survives the stale admission", [typeof e1, e1 !== e0], ["string", true]);
  await eraseClosed(deadline(), finishClosed, t2 + 30 * HOUR);
  is("a later walk erases every key named by its ids", [await erasableBy(idsOf(againStore)), await readPhoto(againStore.photoId!), await inBatch(againRef)], [[], null, null]);

  part("the record gone, then the addresses' holds answered in an unknown shape: what reaches the store is still forgotten (Claude 6's Q5 on #3670)");
  redis.clear();
  await claimHandle(OWNER, "keepshome", "Keeps Home", "");
  const half = await createStore(OWNER, "keepshalf", "Keeps Half", "");
  if (!half.ok) throw new Error("no half store");
  const halfStore = await furnished(storeRef(half.store));
  const halfRef = storeRef(halfStore);
  const apiKey = await makeKey(halfStore.sid, "Synthetic key");
  if (!apiKey.ok) throw new Error("no key");
  is("before: its API key answers for it", (await resolveKey(apiKey.key))?.sid, halfStore.sid);
  // The pipeline that holds its addresses back and releases its places, sent once its record is gone, answers [].
  garbleMany = (commands) => (commands.some((command) => command[0] === "SET" && String(command[1]).startsWith("nl:store:handle:") && String(command[2]).startsWith("released:")) ? [] : undefined);
  const halfAnswer = await deleteFromStudio(OWNER, halfStore);
  garbleMany = undefined;
  is("its record is gone", await storeForEmail(halfRef), null);
  is("the studio says it was deleted with a last step not confirmed, never that nothing was deleted", halfAnswer.includes("stores=partly"), true);
  is("its API key no longer answers, its lookup gone", [await resolveKey(apiKey.key), (await allKeys()).filter((key) => key.startsWith("nl:api:k:"))], [null, []]);
  await eraseClosed(deadline(), finishClosed, Date.now());
  is("after the walk, every key named by its ids is gone and no API key lookup is left", [await erasableBy(idsOf(halfStore)), (await allKeys()).filter((key) => key.startsWith("nl:api:")), await inBatch(halfRef)], [[], [], null]);

  part("rule 24: a record not read at the walk leaves the entry waiting, never walked nor dropped");
  redis.clear();
  await claimHandle(OWNER, "keepshome", "Keeps Home", "");
  const unread = await createStore(OWNER, "keepsunread", "Keeps Unread", "");
  if (!unread.ok) throw new Error("no unread store");
  const unreadStore = await furnished(storeRef(unread.store));
  const unreadRef = storeRef(unreadStore);
  is("deleted from the studio", await deleteFromStudio(OWNER, unreadStore), "deleted");
  garble = (command) => (command[0] === "GET" && String(command[1]).startsWith("nl:store:owner:") ? [42] : undefined);
  const blind = await eraseClosed(deadline(), finishClosed, Date.now());
  garble = undefined;
  is("the run is not done, the entry still waits, its keys are still there", [blind.done, typeof (await inBatch(unreadRef)), (await erasableBy(idsOf(unreadStore))).length > 0], [false, "string", true]);
  await eraseClosed(deadline(), finishClosed, Date.now() + 21 * HOUR);
  is("the next run reads it gone and erases them", [await erasableBy(idsOf(unreadStore)), await inBatch(unreadRef)], [[], null]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
