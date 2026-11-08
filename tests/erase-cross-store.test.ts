/**
 * Rule 30, synthetic only: the closing walk (lib/closed-store-data.ts, eraseClosed and walkPage) deletes only what is
 * proven to be the closed store's, never another store's keys: not a key of a family named by address whose address
 * only contains one of the closed store's, and not a live store's keys named by an id it took up again.
 *
 * A closed store's key is found by its ids. Most are its own for good (its sid, its list, its stats id). Three are not:
 *
 * - its key (storeRef): for an account's first store, the owner's address. The store's record goes when it is
 *   prepared (closeStoreRecord), and from then on its owner may open a first store again under the same address
 *   (lib/store.ts, claimHandle): the new store has the same key, so its keys named by it (nl:pause:<key>,
 *   nl:pause:last:<key>, its place in nl:pause:due) are named exactly as the closed store's were.
 * - its files' folder, which is derived from that key (storeFolder): the new store has the same folder, so its keys
 *   named by it (nl:store:folder-owner:<folder>, its counters) are too.
 * - the addresses it let go of before it closed (releasedHandles), which anyone may claim once their month on the
 *   shelf is over: a store that took one has its own nl:weekly:to:<handle>.
 * - its Stripe account, when no other store of its owner sold through it when it was prepared: its owner's new store
 *   may connect it since, and its records named by it (nl:taxreg:<account>, ...) are named as the closed store's were.
 *
 * And a family named by address (nl:weekly:to:<handle>) matched any part of a key against the closed store's
 * addresses: a closed store whose address is "weekly" took every store's nl:weekly:to: key with it.
 *
 * A walk takes more than one run when the database is large or a run stops (a page that does not read, its deadline),
 * and runs are a day apart at the most when it begins: in between, the owner may open their new store. Before this
 * file's fix the walk deleted every key named by the closed store's key, folder or handles whenever it came to it,
 * whoever held them now.
 */
import { BATCH_KEY, WALK_KEY, eraseClosed, markDue } from "@/lib/closed-store-data";
import { leadsKey } from "@/lib/contacts";
import { claimHandle, createStore, releaseHandle, renameHandle, setStripeAccount, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { closeForErasure } from "./closed-for-erasure";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;

type Command = (string | number)[];
const original = redis.pipeline.bind(redis);

/** Every command `word` on a key passing `key` answers `answer(call, real)`, after the real command ran. */
function answering(word: string, answer: (call: number, real: unknown) => unknown, key: (k: string) => boolean = () => true): void {
  let call = 0;
  const inner = redis.pipeline;
  redis.pipeline = (async (commands: Command[]) => {
    const at = commands.findIndex((c) => c[0] === word && key(String(c[1])));
    if (at < 0) return inner(commands);
    const real = await inner(commands);
    const reply = answer(call++, real[at]);
    if (reply === REAL) return real;
    return [...real.slice(0, at), reply, ...real.slice(at + 1)];
  }) as typeof redis.pipeline;
}
const REAL = Symbol("real");

/** The first pipeline holding the walk's SCAN of the database fails before it reaches the database. */
function dyingAt(word: "SCAN"): void {
  let died = false;
  const inner = redis.pipeline;
  redis.pipeline = (async (commands: Command[]) => {
    if (!died && commands.some((c) => c[0] === word && c[3] === "nl:*")) {
      died = true;
      throw new Error("synthetic: the pipeline did not reach the database");
    }
    return inner(commands);
  }) as typeof redis.pipeline;
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "ok";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : "threw";
  } finally {
    redis.pipeline = original;
  }
}

let finished: string[] = [];
async function walk(): Promise<string> {
  const report = await eraseClosed(Date.now() + 60_000, async (e) => void finished.push(e.ref));
  return `done:${report.done} begun:${report.stores} finished:${report.finished}`;
}
async function run(): Promise<string> {
  try {
    return await walk();
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : "threw";
  } finally {
    redis.pipeline = original;
  }
}

const OWNER = "owner@example.com";
const OTHER = "other@example.com";
const pauseKey = (ref: string) => `nl:pause:${ref}`;
const pauseLastKey = (ref: string) => `nl:pause:last:${ref}`;
const PAUSE_DUE = "nl:pause:due";
const folderOwnerKey = (folder: string) => `nl:store:folder-owner:${folder}`;
const weeklyKey = (handle: string) => `nl:weekly:to:${handle}`;

/** What a store of `email` writes under its key, its folder and its handle, as plan-pause.ts, delivery.ts and stats-report.ts write them. */
async function writeOwn(email: string, handle: string, tag: string): Promise<void> {
  const store = (await storeForEmail(email))!;
  const ref = storeRef(store);
  await original([
    ["SET", pauseKey(ref), JSON.stringify({ subscription: `sub_${tag}`, tag })],
    ["SET", pauseLastKey(ref), tag],
    ["ZADD", PAUSE_DUE, Date.now() + 86_400_000, ref],
    ["SET", folderOwnerKey(await storeFolder(ref)), ref],
    ["SADD", weeklyKey(handle), `${tag}@example.com`],
    ["HSET", leadsKey(store.listId!), `${tag}-buyer@example.com`, JSON.stringify({ agreed: true, t: "" })],
  ]);
}

/** What is there of what writeOwn wrote: by key, the tag it holds, or null. */
async function own(email: string, handle: string, listId: string): Promise<Record<string, unknown>> {
  const folder = await storeFolder(email);
  const [pause, last, due, folderOwner, weekly, leads] = await original([
    ["GET", pauseKey(email)],
    ["GET", pauseLastKey(email)],
    ["ZSCORE", PAUSE_DUE, email],
    ["GET", folderOwnerKey(folder)],
    ["SMEMBERS", weeklyKey(handle)],
    ["HKEYS", leadsKey(listId)],
  ]);
  return {
    pause: pause === null ? null : (JSON.parse(String(pause)) as { tag: string }).tag,
    last,
    due: due !== null,
    folderOwner,
    weekly,
    leads,
  };
}

/** A clean database and an idle walk that ran long ago. */
async function fresh(): Promise<void> {
  redis.clear();
  finished = [];
  await original([["HSET", WALK_KEY, "phase", "idle", "cursor", "0", "started", 1, "finished", 1]]);
}

/** OWNER's first store "closing", with its own keys, closed and in line. Answers its list. */
async function closedStore(): Promise<string> {
  await claimHandle(OWNER, "closing", "Closing store", "");
  const store = (await storeForEmail(OWNER))!;
  await writeOwn(OWNER, "closing", "closed");
  await closeForErasure(OWNER);
  await markDue(storeRef(store), Date.now() - 1_000);
  return store.listId!;
}

const GONE = { pause: null, last: null, due: false, folderOwner: null, weekly: [], leads: [] };

async function main(): Promise<void> {
  part("Controls: a closed store with no store after it is erased whole, once");
  {
    await fresh();
    const closedList = await closedStore();
    is("before the walk: its keys by its key, its folder and its handle are there", (await own(OWNER, "closing", closedList)).pause, "closed");
    is("the walk erases it and finishes it once", [await run(), finished], ["done:true begun:1 finished:1", [OWNER]]);
    is("every key of it is gone: by its key, its folder, its handle, its list", await own(OWNER, "closing", closedList), GONE);

    await fresh();
    const stoppedList = await closedStore();
    dyingAt("SCAN");
    is("a walk that stops at its first page, after the store was prepared", await outcome(walk), "threw");
    is("the next run carries it on and erases it whole", [await run(), finished, await own(OWNER, "closing", stoppedList)], ["done:true begun:0 finished:1", [OWNER], GONE]);
  }

  part("The owner opens a first store again under the same address while the walk runs: its keys are kept");
  {
    await fresh();
    const closedList = await closedStore();
    dyingAt("SCAN");
    is("the walk prepares the closed store and stops at its first page", [await outcome(walk), (await original([["HLEN", BATCH_KEY]]))[0]], ["threw", 1]);
    is("its record is gone, so its owner may open a first store again", (await claimHandle(OWNER, "fresh", "Fresh store", "")).ok, true);
    const live = (await storeForEmail(OWNER))!;
    is("the new store has the closed one's key and folder", [storeRef(live), await storeFolder(storeRef(live))], [OWNER, await storeFolder(OWNER)]);
    await writeOwn(OWNER, "fresh", "live");
    const report = await run();
    is("the walk carries on and finishes the closed store once", [report, finished], ["done:true begun:0 finished:1", [OWNER]]);
    is("the closed store's own list is gone", (await own(OWNER, "closing", closedList)).leads, []);
    is("the live store keeps its pause, its last pause, its place in line for its pause, its folder's owner, its weekly team and its list",
      await own(OWNER, "fresh", live.listId!),
      { pause: "live", last: "live", due: true, folderOwner: OWNER, weekly: ["live@example.com"], leads: ["live-buyer@example.com"] });
    is("and it is still there, live", (await storeForEmail(OWNER))?.sid, live.sid);
  }

  part("An address the closed store let go of, claimed since by another store: that store's keys are kept");
  {
    await fresh();
    await claimHandle(OWNER, "oldname", "Closing store", "");
    is("renamed to closing", (await renameHandle(OWNER, "closing")).ok, true);
    is("and lets oldname go", (await releaseHandle(OWNER, "oldname")).ok, true);
    is("oldname is in the closed store's released addresses", (await storeForEmail(OWNER))?.releasedHandles, ["oldname"]);
    // Its month on the shelf is over (the released mark expired): another owner claims it.
    await original([["DEL", "nl:store:handle:oldname"]]);
    is("another owner claims oldname", (await claimHandle(OTHER, "oldname", "Other store", "")).ok, true);
    const other = (await storeForEmail(OTHER))!;
    await writeOwn(OTHER, "oldname", "other");
    const store = (await storeForEmail(OWNER))!;
    await writeOwn(OWNER, "closing", "closed");
    await closeForErasure(OWNER);
    await markDue(storeRef(store), Date.now() - 1_000);
    is("the walk erases the closed store once", [await run(), finished], ["done:true begun:1 finished:1", [OWNER]]);
    is("the closed store's own keys are gone", await own(OWNER, "closing", store.listId!), GONE);
    is("the other store keeps its weekly team, and everything else of it",
      await own(OTHER, "oldname", other.listId!),
      { pause: "other", last: "other", due: true, folderOwner: OTHER, weekly: ["other@example.com"], leads: ["other-buyer@example.com"] });
  }

  part("Whether a live store holds the closed store's key, read exactly: unknown stops the run with nothing deleted");
  {
    const unknowns: [string, unknown][] = [
      ["the store record's read answers a number", 42],
      ["the store record's read answers a list", ["x"]],
    ];
    for (const [label, reply] of unknowns) {
      await fresh();
      const closedList = await closedStore();
      dyingAt("SCAN");
      await outcome(walk);
      await claimHandle(OWNER, "fresh", "Fresh store", "");
      const live = (await storeForEmail(OWNER))!;
      await writeOwn(OWNER, "fresh", "live");
      answering("GET", () => reply, (k) => k.startsWith("nl:store:owner:"));
      const stopped = await run();
      const [cursor] = await original([["HGET", WALK_KEY, "cursor"]]);
      is(`${label}: the run stops, nothing finished, its cursor where it was`, [stopped, finished, cursor], ["unknown", [], "0"]);
      is(`${label}: the live store's keys are all there`, (await own(OWNER, "fresh", live.listId!)).pause, "live");
      is(`${label}: the next run, whose replies read, finishes the closed store and keeps the live one's`,
        [await run(), finished, (await own(OWNER, "closing", closedList)).leads, (await own(OWNER, "fresh", live.listId!)).folderOwner],
        ["done:true begun:0 finished:1", [OWNER], [], OWNER]);
    }
  }

  part("A key of a family named by address is named by the address that follows the family's name, whole");
  {
    await fresh();
    await claimHandle(OTHER, "other-shop", "Other store", "");
    await original([["SADD", weeklyKey("other-shop"), "team@example.com"], ["SADD", weeklyKey("weekly-two"), "team2@example.com"]]);
    await claimHandle(OWNER, "weekly", "Closing store", "");
    const store = (await storeForEmail(OWNER))!;
    await original([["SADD", weeklyKey("weekly"), "closed@example.com"]]);
    await closeForErasure(OWNER);
    await markDue(storeRef(store), Date.now() - 1_000);
    is("a closed store whose address is \"weekly\" is erased once", [await run(), finished], ["done:true begun:1 finished:1", [OWNER]]);
    const [mine, others, two] = await original([["EXISTS", weeklyKey("weekly")], ["SMEMBERS", weeklyKey("other-shop")], ["SMEMBERS", weeklyKey("weekly-two")]]);
    is("its own weekly team goes; every other store's stays", [mine, others, two], [0, ["team@example.com"], ["team2@example.com"]]);
  }

  part("The closed store's Stripe account, connected since by its owner's new store: what is named by it is kept");
  {
    const ACCOUNT = "acct_1closing0store0";
    const taxKey = `nl:taxreg:${ACCOUNT}`;

    await fresh();
    await claimHandle(OWNER, "closing", "Closing store", "");
    await setStripeAccount(OWNER, ACCOUNT, true);
    const alone = (await storeForEmail(OWNER))!;
    await original([["SET", taxKey, "closed"]]);
    await closeForErasure(OWNER);
    await markDue(storeRef(alone), Date.now() - 1_000);
    is("control: no store sells through it after the closed one, so what is named by it goes", [await run(), finished, (await original([["EXISTS", taxKey]]))[0]], ["done:true begun:1 finished:1", [OWNER], 0]);

    await fresh();
    await claimHandle(OWNER, "closing", "Closing store", "");
    await setStripeAccount(OWNER, ACCOUNT, true);
    const store = (await storeForEmail(OWNER))!;
    await original([["SET", taxKey, "closed"]]);
    await closeForErasure(OWNER);
    await markDue(storeRef(store), Date.now() - 1_000);
    dyingAt("SCAN");
    await outcome(walk);
    await claimHandle(OWNER, "fresh", "Fresh store", "");
    await setStripeAccount(OWNER, ACCOUNT, true);
    await original([["SET", taxKey, "live"]]);
    is("the walk finishes the closed store and the new store keeps its account's records", [await run(), finished, (await original([["GET", taxKey]]))[0]], ["done:true begun:0 finished:1", [OWNER], "live"]);
  }

  part("The closed store's Stripe account, connected since by another store of its owner: kept, its owner's stores read exactly");
  {
    const ACCOUNT = "acct_1closing0other0";
    const taxKey = `nl:taxreg:${ACCOUNT}`;
    for (const [label, reply] of [["read", REAL], ["a number", 42], ["a list of numbers", [7]]] as [string, unknown][]) {
      await fresh();
      is(`${label}: the owner has a first store`, (await claimHandle(OWNER, "owners-home", "Home store", "")).ok, true);
      const made = await createStore(OWNER, "closing", "Closing store", "");
      if (!made.ok) throw new Error(`no other store: ${made.reason}`);
      const ref = storeRef(made.store);
      await setStripeAccount(ref, ACCOUNT, true);
      await original([["SET", taxKey, "closed"]]);
      await closeForErasure(ref);
      await markDue(ref, Date.now() - 1_000);
      dyingAt("SCAN");
      is(`${label}: the walk prepares the owner's other store and stops at its first page`, [await outcome(walk), (await original([["HLEN", BATCH_KEY]]))[0]], ["threw", 1]);
      const again = await createStore(OWNER, "fresh", "Fresh store", "");
      if (!again.ok) throw new Error("no new store");
      is(`${label}: the owner's new other store connects the same account`, (await setStripeAccount(storeRef(again.store), ACCOUNT, true)).ok, true);
      await original([["SET", taxKey, "live"]]);
      if (reply !== REAL) {
        answering("SMEMBERS", () => reply, (k) => k.startsWith("nl:account:stores:"));
        is(`the owner's other stores' read answers ${label}: the run stops, nothing finished, the account's records kept`,
          [await run(), finished, (await original([["GET", taxKey]]))[0]], ["unknown", [], "live"]);
      }
      is(`${label}: the walk finishes the closed store and the new store keeps its account's records`,
        [await run(), finished, (await original([["GET", taxKey]]))[0]], ["done:true begun:0 finished:1", [ref], "live"]);
    }
  }

  part("Whether a store holds an address the closed store let go of, read exactly: unknown stops the run");
  {
    for (const [label, reply] of [["a number", 7], ["a list", ["x"]]] as [string, unknown][]) {
      await fresh();
      await claimHandle(OWNER, "oldname", "Closing store", "");
      await renameHandle(OWNER, "closing");
      await releaseHandle(OWNER, "oldname");
      await original([["DEL", "nl:store:handle:oldname"]]);
      await claimHandle(OTHER, "oldname", "Other store", "");
      await original([["SADD", weeklyKey("oldname"), "other@example.com"]]);
      const store = (await storeForEmail(OWNER))!;
      await closeForErasure(OWNER);
      await markDue(storeRef(store), Date.now() - 1_000);
      answering("GET", () => reply, (k) => k === "nl:store:handle:oldname");
      const stopped = await run();
      is(`the address's read answers ${label}: the run stops, nothing finished, the other store's team kept`,
        [stopped, finished, (await original([["SMEMBERS", weeklyKey("oldname")]]))[0]], ["unknown", [], ["other@example.com"]]);
      is(`answers ${label}: the next run, whose replies read, finishes it and keeps the team`,
        [await run(), finished, (await original([["SMEMBERS", weeklyKey("oldname")]]))[0]], ["done:true begun:0 finished:1", [OWNER], ["other@example.com"]]);
    }
  }

  done();
}

main();
