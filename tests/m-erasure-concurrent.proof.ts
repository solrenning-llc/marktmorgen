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

/** Same real walk and store creation, with the concurrent creator interleaved at the ownership GET. */
async function main(): Promise<void> {
  for (const at of ["before", "after"] as const) {
    await fresh();
    await closedStore();
    dyingAt("SCAN");
    await outcome(walk);
    let armed = true;
    let liveList = "";
    const create = async () => {
      const result = await claimHandle(OWNER, "fresh", "Fresh store", "");
      if (!result.ok) throw new Error("Synthetic fresh store was not created");
      liveList = (await storeForEmail(OWNER))!.listId!;
      await writeOwn(OWNER, "fresh", "live");
    };
    redis.pipeline = (async (commands: Command[]) => {
      const hit = armed && commands.some(c => c[0] === "GET" && String(c[1]).startsWith("nl:store:owner:"));
      if (!hit) return original(commands);
      armed = false;
      if (at === "before") await create();
      const reply = await original(commands);
      if (at === "after") await create();
      return reply;
    }) as typeof redis.pipeline;
    const result = await run();
    is(at + ": the real owner check and real concurrent create were reached", [armed, liveList !== "", result], [false, true, "done:true begun:0 finished:1"]);
    const found = await own(OWNER, "fresh", liveList);
    is(at + ": the new store keeps its pause, last pause and folder owner",
      [found.pause, found.last, found.folderOwner], ["live", "live", OWNER]);
    is(at + ": the new store's private lead list remains",
      found.leads, ["live-buyer@example.com"]);
  }
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
