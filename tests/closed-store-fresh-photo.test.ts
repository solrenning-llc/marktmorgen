/**
 * A photo put on a closing store's page while its erasure runs is erased with
 * it, never left behind (Codex G's MEDIUM on #3614, review 6782212736; Claude
 * 3's focal comment 6785333946).
 *
 * lib/closed-store-data.ts eraseClosed reads the store record, prepareStore
 * makes many round trips (its team, its hosts' claims, its keys for the API,
 * its webhooks...) and then closeStoreRecord deletes the record, all from
 * that first read. A photo the creator put on in between (the photo route:
 * writePhoto, then setPhotoId under the store's lock) was named only by the
 * record that went: its id was not among the walk's marks, so
 * nl:store:photo:<id> stayed for ever, with nothing naming it and no expiry.
 *
 * Now the record is read again under the store's lock right before it goes,
 * every id it names then is a mark of the walk's entry before the record is
 * deleted (only while that lock is still the erasure's), and a read again
 * that does not read is never "nothing new" (rule 24): the record stays and
 * the store waits a walk. Synthetic stores and photos, in-memory Redis.
 */
import { BATCH_KEY, DUE_KEY, WALK_GAP_MS, eraseClosed, markDue } from "@/lib/closed-store-data";
import { claimHandle, createStore, ensureStatsId, ensureStoreId, moveAccount, setPhotoId, storeForEmail, storeRef, type Store } from "@/lib/store";
import { deletePhoto, writePhoto } from "@/lib/store-photo";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

// What happens while the erasure is between its first read and the record going: run when the walk's entry is
// written (HSET BATCH_KEY), the last step before closeStoreRecord, as a request in that window would.
let inWindow: (() => Promise<void>) | null = null;
// The record's read right before it goes answers what Redis never says for a GET (armed by the window).
let rereadUnknown = false;
// The entry's rewrite with the new marks answered with what HSET never says (armed by the window).
let rewriteUnconfirmed = false;
let ownerOf = "";
// The addresses' hold and the id's release before the record goes answered [] with nothing done (Claude 6's P8 on #3643).
let releaseLost = false;
// How many takings-out of a walk entry (WITHDRAW_ENTRY) answer what EVAL never says, from now.
let withdrawUnknown = 0;
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = async (commands: (string | number)[][]) => {
  if (withdrawUnknown > 0 && commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:closing-withdraw-entry:v1")) {
    withdrawUnknown -= 1;
    return [null];
  }
  if (inWindow && commands.some((c) => c[0] === "HSET" && c[1] === BATCH_KEY)) {
    const run = inWindow;
    inWindow = null;
    await run();
  } else if (rewriteUnconfirmed && commands.length === 1 && commands[0][0] === "HSET" && commands[0][1] === BATCH_KEY) {
    rewriteUnconfirmed = false;
    return [null];
  }
  if (releaseLost && commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:store:handle:") && String(c[2]).startsWith("released:"))) {
    releaseLost = false;
    return [];
  }
  if (rereadUnknown && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === ownerOf) {
    rereadUnknown = false;
    return ["QUEUED"];
  }
  return realPipeline(commands);
};

/** The photo route's order (app/api/store/photo/route.ts): the new picture written, the store pointed at it, the old one deleted. */
async function putPhoto(email: string): Promise<string> {
  const id = await writePhoto(PNG, "image/png");
  const result = await setPhotoId(email, id);
  if (!result.ok) {
    await deletePhoto(id);
    throw new Error("setup: the store is gone");
  }
  await deletePhoto(result.was);
  return id;
}

async function makeStore(email: string, handle: string): Promise<Store> {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  const store = await storeForEmail(email);
  if (!store) throw new Error(`setup: ${handle}`);
  return store;
}

const photoKeys = () => redis.keys().filter((key) => key.startsWith("nl:store:photo:"));
/** Keys still named by one of these ids: the store's own, and every photo it ever had. */
const leftNamedBy = (ids: string[]) => redis.keys().filter((key) => ids.some((id) => key.includes(id)));

async function erase(now: number) {
  return eraseClosed(Date.now() + 30_000, async () => {}, now);
}

async function main(): Promise<void> {
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

  part("Control: a photo the store had when its erasure started is erased with it");
  redis.clear();
  {
    const email = "control@example.com";
    const store = await makeStore(email, "controlphoto");
    const shown = await putPhoto(email);
    await markDue(email, Date.now() - 1000);
    const report = await erase(Date.now());
    is("the store is prepared and its walk finishes", [report.stores, report.finished], [1, 1]);
    is("no store photo is left", photoKeys(), []);
    is("nothing named by its ids is left", leftNamedBy([store.sid, store.statsId ?? "-", shown]), []);
  }

  part("A photo replaced while the erasure runs: the new one is erased too, never orphaned (Codex G's probe)");
  redis.clear();
  {
    const email = "replaced@example.com";
    const store = await makeStore(email, "replacedphoto");
    const first = await putPhoto(email);
    let second = "";
    inWindow = async () => {
      second = await putPhoto(email);
    };
    await markDue(email, Date.now() - 1000);
    const report = await erase(Date.now());
    is("the replacement landed in the window, after the first read", second.length === 32 && second !== first, true);
    is("the store is prepared and its walk finishes", [report.stores, report.finished], [1, 1]);
    is("the record is gone", await storeForEmail(email), null);
    is("no store photo is left (no orphan)", photoKeys(), []);
    is("nothing named by its ids or either photo is left", leftNamedBy([store.sid, store.statsId ?? "-", first, second]), []);
  }

  part("A first photo put on while the erasure runs is erased too");
  redis.clear();
  {
    const email = "first@example.com";
    const store = await makeStore(email, "firstphoto");
    let put = "";
    inWindow = async () => {
      put = await putPhoto(email);
    };
    await markDue(email, Date.now() - 1000);
    const report = await erase(Date.now());
    is("the photo landed in the window", put.length, 32);
    is("the store is prepared and its walk finishes", [report.stores, report.finished], [1, 1]);
    is("no store photo is left (no orphan)", photoKeys(), []);
    is("nothing named by its ids or the photo is left", leftNamedBy([store.sid, store.statsId ?? "-", put]), []);
  }

  part("Rule 24: a read again of the record that does not read keeps it, and the store waits a walk");
  redis.clear();
  {
    const email = "unknown@example.com";
    const store = await makeStore(email, "unknownphoto");
    let put = "";
    ownerOf = String(redis.keys().find((key) => key.startsWith("nl:store:owner:") && redis.run(["GET", key]) !== null && String(redis.run(["GET", key])).includes(email)));
    inWindow = async () => {
      put = await putPhoto(email);
      rereadUnknown = true;
    };
    const T = Date.now();
    await markDue(email, T - 1000);
    await erase(T);
    const score = redis.run(["ZSCORE", DUE_KEY, email]);
    is("the record is not deleted on a read that did not read", (await storeForEmail(email))?.photoId ?? null, put);
    is("the store is still in line, moved back a walk", score !== null && Number(score) >= T + WALK_GAP_MS, true);
    const next = await erase(T + WALK_GAP_MS + 1);
    is("the next walk prepares it and finishes", [next.stores, next.finished], [1, 1]);
    is("the record is gone then", await storeForEmail(email), null);
    is("and no store photo is left", photoKeys(), []);
    is("nothing named by its ids or the photo is left", leftNamedBy([store.sid, store.statsId ?? "-", put]), []);
  }

  part("Rule 24: an entry's rewrite with the new photo's id not confirmed keeps the record, and the store waits a walk");
  redis.clear();
  {
    const email = "rewrite@example.com";
    const store = await makeStore(email, "rewritephoto");
    let put = "";
    inWindow = async () => {
      put = await putPhoto(email);
      rewriteUnconfirmed = true;
    };
    const T = Date.now();
    await markDue(email, T - 1000);
    await erase(T);
    const score = redis.run(["ZSCORE", DUE_KEY, email]);
    is("the record is not deleted while the new photo is not a mark", (await storeForEmail(email))?.photoId ?? null, put);
    is("the store is still in line, moved back a walk", score !== null && Number(score) >= T + WALK_GAP_MS, true);
    const next = await erase(T + WALK_GAP_MS + 1);
    is("the next walk prepares it and finishes", [next.stores, next.finished], [1, 1]);
    is("no store photo is left", photoKeys(), []);
    is("nothing named by its ids or the photo is left", leftNamedBy([store.sid, store.statsId ?? "-", put]), []);
  }

  part("Codex G on #3643: another store at the same owner key by the time of the read again is never erased with this one");
  redis.clear();
  {
    const email = "again@example.com";
    const store = await makeStore(email, "againphoto");
    let other = "";
    const otherSid = "f".repeat(32);
    ownerOf = String(redis.keys().find((key) => key.startsWith("nl:store:owner:") && String(redis.run(["GET", key])).includes(email)));
    inWindow = async () => {
      // As if this store's record went and a new store (another sid) was made at the same key, with its own photo.
      other = await writePhoto(PNG, "image/png");
      const record = JSON.parse(String(redis.run(["GET", ownerOf])));
      redis.run(["SET", ownerOf, JSON.stringify({ ...record, sid: otherSid, photoId: other, planEndedAt: "" })]);
      // The new store's break and its last break, kept under the same ref (lib/plan-pause.ts, recordKey and lastKey).
      redis.run(["SET", `nl:pause:${email}`, otherBreak]);
      redis.run(["SET", `nl:pause:last:${email}`, otherLast]);
    };
    const otherBreak = JSON.stringify({ subscription: "sub_againother1", customer: "cus_againother1", paymentMethod: "pm_againother1", tier: "creator", from: 2_000_000_000, until: 2_005_000_000, told: 0 });
    const otherLast = "1900000000";
    const T = Date.now();
    await markDue(email, T - 1000);
    const first = await erase(T);
    const now = await storeForEmail(email);
    is("the other store's record is not deleted", now?.sid ?? null, otherSid);
    // Revisor 2 on #3643: the closing store's entry stayed in the walk's batch with its ref and its owner's folder,
    // both the other store's now, and the walk erased the other store's break and last break by that ref.
    is("the other store's break and last break are kept", [redis.run(["GET", `nl:pause:${email}`]), redis.run(["GET", `nl:pause:last:${email}`])], [otherBreak, otherLast]);
    is("the closing store, its record already gone, is not counted as prepared, and nothing is walked for it", [first.stores, first.started], [0, false]);
    is("its photo is kept", photoKeys().some((key) => key.includes(other)), true);
    const entry = redis.run(["HGET", BATCH_KEY, `${store.sid}`]) ?? Object.values(Object.fromEntries((redis.run(["HGETALL", BATCH_KEY]) as string[] | null ?? []).reduce<[string, string][]>((acc, v, i, all) => (i % 2 ? acc : [...acc, [v, all[i + 1]]]), []))).join("");
    is("and the closing store's entry never names it", String(entry ?? "").includes(other) || String(entry ?? "").includes(otherSid), false);
    // The closing store's ref is out of line (its record is gone, the other is not its own), so no later walk reads the
    // other store under it and erases it (Claude 6's new LOW on #3643, probe D1).
    is("the closing store's ref is out of line", redis.run(["ZSCORE", DUE_KEY, email]), null);
    const next = await erase(T + WALK_GAP_MS + 1);
    is("a second walk prepares nothing", next.stores, 0);
    is("the other store's record is still not deleted after it", (await storeForEmail(email))?.sid ?? null, otherSid);
    is("nor its photo", photoKeys().some((key) => key.includes(other)), true);
  }

  part("Rule 24 (Revisor 2 on #3643): a closing store's entry, with another store at its key, taken out only on Redis's own answer");
  for (const [what, unknown] of [["one answer unknown, then taken on the next try", 1], ["never confirmed", 99]] as const) {
    redis.clear();
    const email = `withdraw${unknown}@example.com`;
    await makeStore(email, `withdraw${unknown}`);
    const otherSid = "e".repeat(32);
    const ownerKey = String(redis.keys().find((key) => key.startsWith("nl:store:owner:") && String(redis.run(["GET", key])).includes(email)));
    const otherBreak = JSON.stringify({ subscription: "sub_withdrawother", customer: "cus_withdrawother", paymentMethod: "pm_withdrawother", tier: "creator", from: 2_000_000_000, until: 2_005_000_000, told: 0 });
    inWindow = async () => {
      const record = JSON.parse(String(redis.run(["GET", ownerKey])));
      redis.run(["SET", ownerKey, JSON.stringify({ ...record, sid: otherSid, planEndedAt: "" })]);
      redis.run(["SET", `nl:pause:${email}`, otherBreak]);
    };
    withdrawUnknown = unknown;
    const T = Date.now();
    await markDue(email, T - 1000);
    const report = await erase(T);
    const left = withdrawUnknown;
    withdrawUnknown = 0;
    is(`${what}: the other store and its break are kept`, [(await storeForEmail(email))?.sid ?? null, redis.run(["GET", `nl:pause:${email}`])], [otherSid, otherBreak]);
    is(`${what}: the ref is out of line, never moved back to be prepared again as the other store`, redis.run(["ZSCORE", DUE_KEY, email]), null);
    is(`${what}: nothing is prepared and no walk starts`, [report.stores, report.started], [0, false]);
    if (unknown === 1) {
      is(`${what}: the entry is out of the batch`, [left, redis.run(["HGET", BATCH_KEY, email])], [0, null]);
      is(`${what}: the run is done`, report.done, true);
    } else {
      is(`${what}: the entry is left in the batch, and the run is not said to be done`, [redis.run(["HGET", BATCH_KEY, email]) !== null, report.done], [true, false]);
    }
  }

  part("Codex on #3643 (MEDIUM, lib/closed-store-data.ts:817): an entry never confirmed out never starts a walk on a later run either");
  {
    redis.clear();
    const email = "stale@example.com";
    await makeStore(email, "staleentry");
    const otherSid = "d".repeat(32);
    const ownerKey = String(redis.keys().find((key) => key.startsWith("nl:store:owner:") && String(redis.run(["GET", key])).includes(email)));
    const otherBreak = JSON.stringify({ subscription: "sub_staleother", customer: "cus_staleother", paymentMethod: "pm_staleother", tier: "creator", from: 2_000_000_000, until: 2_005_000_000, told: 0 });
    const otherLast = "1900000001";
    inWindow = async () => {
      const record = JSON.parse(String(redis.run(["GET", ownerKey])));
      redis.run(["SET", ownerKey, JSON.stringify({ ...record, sid: otherSid, planEndedAt: "" })]);
      redis.run(["SET", `nl:pause:${email}`, otherBreak]);
      redis.run(["SET", `nl:pause:last:${email}`, otherLast]);
    };
    const finished: string[] = [];
    const run = (now: number) => eraseClosed(Date.now() + 30_000, async (entry) => {
      finished.push(entry.ref);
    }, now);
    const T = Date.now();
    await markDue(email, T - 1000);
    // Every taking-out of the entry answers what EVAL never says, in this run and in the next ones.
    withdrawUnknown = 99;
    const first = await run(T);
    is("the first run leaves the entry in the batch and starts no walk", [redis.run(["HGET", BATCH_KEY, email]) !== null, first.started, first.done], [true, false, false]);
    const later: { started: boolean }[] = [];
    for (const at of [T + WALK_GAP_MS + 1, T + 2 * WALK_GAP_MS + 2, T + 3 * WALK_GAP_MS + 3]) later.push(await run(at));
    withdrawUnknown = 0;
    is("no later run starts a walk from the entry never confirmed out", later.map((r) => r.started), [false, false, false]);
    is("the other store's break and last break are kept on every later run", [redis.run(["GET", `nl:pause:${email}`]), redis.run(["GET", `nl:pause:last:${email}`])], [otherBreak, otherLast]);
    is("the other store's record is kept", (await storeForEmail(email))?.sid ?? null, otherSid);
    is("nothing is finished under the other store's ref", finished, []);
    const healed = await run(T + 4 * WALK_GAP_MS + 4);
    is("once Redis answers, the entry is taken out and no walk starts for it", [redis.run(["HGET", BATCH_KEY, email]), healed.started, healed.done], [null, false, true]);
    is("and still the other store's break is kept, and nothing finished", [redis.run(["GET", `nl:pause:${email}`]), finished], [otherBreak, []]);
  }

  part("Rule 24 (Claude 6's P8 on #3643): an addresses' hold and id release that Redis did not confirm keep the record, and the store waits a walk");
  redis.clear();
  {
    const email = "lost@example.com";
    const store = await makeStore(email, "lostrelease");
    releaseLost = true;
    const T = Date.now();
    await markDue(email, T - 1000);
    await erase(T);
    const score = redis.run(["ZSCORE", DUE_KEY, email]);
    is("the hold was answered with nothing", releaseLost, false);
    is("the record is not deleted while its release is unknown", (await storeForEmail(email))?.sid ?? null, store.sid);
    is("the store is still in line, moved back a walk", score !== null && Number(score) >= T + WALK_GAP_MS, true);
    const next = await erase(T + WALK_GAP_MS + 1);
    is("the next walk prepares it and finishes", [next.stores, next.finished], [1, 1]);
    is("the record is gone then", await storeForEmail(email), null);
    const held = redis.run(["GET", "nl:store:handle:lostrelease"]);
    const ttl = Number(redis.run(["PTTL", "nl:store:handle:lostrelease"]));
    is("its address is held back with an expiry, never left naming its owner", [String(held).startsWith("released:"), ttl > 0], [true, true]);
  }

  part("Claude 6's P4 on #3643: an account moved while an extra store's erasure runs keeps the erased store's id at neither address");
  redis.clear();
  {
    const from = "movefrom@example.com";
    const to = "moveto@example.com";
    await makeStore(from, "movehome");
    const made = await createStore(from, "moveextra", "Extra", "");
    if (!made.ok) throw new Error("setup: the extra store");
    const ref = storeRef(made.store);
    let moved = false;
    inWindow = async () => {
      moved = (await moveAccount(from, to)).ok;
    };
    const T = Date.now();
    await markDue(ref, T - 1000);
    const report = await erase(T);
    const lists = redis.keys().filter((key) => key.startsWith("nl:account:stores:"));
    is("the account moved in the window", moved, true);
    is("the extra store is prepared and its walk finishes", [report.stores, report.finished], [1, 1]);
    is("its record is gone", await storeForEmail(ref), null);
    is("its id is in no account's list of stores", lists.filter((key) => (redis.run(["SMEMBERS", key]) as string[]).includes(made.store.sid)), []);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
