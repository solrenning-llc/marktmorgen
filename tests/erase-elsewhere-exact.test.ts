/**
 * Rules 24 and 30, synthetic only (Claude 6's review of #3156): what the closing walk's preparation reads before it
 * deletes something that is not only the closing store's is read exactly, and an answer it cannot read keeps it.
 *
 * - MEDIUM: a host's own calendar (lib/host-calendar.ts) goes with the last store they serve. prepareStore asked
 *   whether the host serves another store through accountStores (lib/store.ts), which reads an account set that does
 *   not answer as a list as "no other store", and through memberStores (lib/team.ts), which leaves out a store whose
 *   team or record does not read and stops at fifty: an owner with a live extra store, or a teammate on another live
 *   store, lost their calendar when one of those reads failed. Now each is read exactly, and one that does not read
 *   is unknown: the host's own calendar is kept and the rest of the store is erased (Claude 4's review of #3660:
 *   until then such a read moved the store back a walk, and a host whose team index held more than fifty stores
 *   made every closing store they host unerasable, forever). Only a known "no other store" deletes the calendar.
 * - LOW: a page of a host's claims (HSCAN) that does not read was taken as their end, and fifty pages not at their
 *   end as all of them: the closing store's claims stayed while it was reported erased. Now each is unknown, and
 *   the scan goes on from where it stopped on the next walk, CLAIM_PAGES pages a walk, until it reaches its end
 *   (Claude 4 on #3660: until then a host with more than fifty pages of claims made the store unerasable, forever).
 * - LOW: a store in line whose record is there but does not read as a store, or is not a string at all, left the line
 *   as "gone", so a closed store with a damaged record was never erased. Now it waits a walk; only Redis's nil is gone.
 *
 * In-memory Redis; nothing real is sent.
 */
import { createHash } from "node:crypto";
import { BATCH_KEY, DUE_KEY, WALK_GAP_MS, WALK_KEY, eraseClosed, markDue } from "@/lib/closed-store-data";
import { claimHandle, createStore, ensureStoreId, storeForEmail } from "@/lib/store";
import { putMember } from "@/lib/team";
import { hostCalendarKeys } from "@/lib/host-calendar";
import { claimsKey, hostId } from "@/lib/host-claims";
import { store as redis } from "./redis-stub";
import { closeForErasure } from "./closed-for-erasure";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;

type Command = (string | number)[];
const realPipeline = redis.pipeline.bind(redis);
const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 40);
const ownerKey = (ref: string) => `nl:store:owner:${sha(`nimbus-store:${ref.toLowerCase()}`)}`;
const accountStoresKey = (email: string) => `nl:account:stores:${sha(`nimbus-account-stores:${email.toLowerCase()}`)}`;
const teamIndexKey = (email: string) => `nl:team:of:${sha(`nimbus-team-of:${email.toLowerCase()}`)}`;
const teamKey = (sid: string) => `nl:team:${sid}`;

/**
 * Replies replaced: every command `word` on a key `key` answers `reply` instead of what the database said, or what
 * `reply` answers for the command when it is a function.
 */
let replaced: { word: string; key: string; reply: unknown }[] = [];
redis.pipeline = (async (commands: Command[]) => {
  const real = await realPipeline(commands);
  if (!replaced.length) return real;
  return real.map((reply: unknown, i: number) => {
    const swap = replaced.find((r) => commands[i][0] === r.word && String(commands[i][1]) === r.key);
    if (!swap) return reply;
    return typeof swap.reply === "function" ? (swap.reply as (command: Command) => unknown)(commands[i]) : swap.reply;
  });
}) as typeof redis.pipeline;

const OWNER = "owner@example.com";
const calendarOf = (email: string) => hostCalendarKeys(hostId(email));
const calendarKept = (email: string) => calendarOf(email).map((key) => redis.run(["EXISTS", key]));

async function walkAt(at: number): Promise<number> {
  return (await eraseClosed(Date.now() + 60_000, async () => {}, at)).stores;
}
/** The store's place in line: null when out of it, or whether it was moved back a walk from `from`. */
const line = (ref: string, from: number) => {
  const score = redis.run(["ZSCORE", DUE_KEY, ref]);
  return score === null ? "out" : Number(score) >= from + WALK_GAP_MS ? "moved back" : "in line";
};
/** The walk's keys of where a closing store's claims scan stopped (lib/closed-store-data.ts), whatever their name. */
const claimProgress = () => (redis.run(["SCAN", "0", "MATCH", "nl:closed:claims:*", "COUNT", 100_000]) as [string, string[]])[1];
/** The walk `k` walks after one at `at`: each a gap and a minute later, so a store moved back a walk is due again. */
const walkTime = (at: number, k: number) => at + k * (WALK_GAP_MS + 60_000);

/** A fresh database, the walk idle, a store closed as the closing job leaves it and in line, its host's calendar written. */
async function closing(email: string, handle: string, before: () => Promise<void> = async () => {}): Promise<number> {
  await claimHandle(email, handle, handle, "");
  await ensureStoreId(email);
  await before();
  await closeForErasure(email);
  for (const key of calendarOf(email)) redis.run(["SET", key, "test"]);
  const at = Date.now();
  await markDue(email, at - 1000);
  return at;
}
function fresh(): void {
  redis.clear();
  replaced = [];
  redis.run(["HSET", WALK_KEY, "phase", "idle", "cursor", "0", "started", 1, "finished", 1]);
}

async function extraStore(): Promise<void> {
  const made = await createStore(OWNER, "livestore", "Live store", "");
  if (!made.ok) throw new Error(`setup: the extra store was not made (${made.reason})`);
}

async function main(): Promise<void> {
  part("MEDIUM: an owner with a live extra store keeps their calendar when their account's stores do not read, and the closing store is erased");
  {
    fresh();
    // The owner's first store closes; their extra store stays live.
    const at = await closing(OWNER, "closing", extraStore);
    if (redis.run(["SCARD", accountStoresKey(OWNER)]) !== 1) throw new Error("setup: the account set formula does not match lib/store.ts");
    replaced = [{ word: "SMEMBERS", key: accountStoresKey(OWNER), reply: "ERR synthetic unreadable reply" }];
    const stores = await walkAt(at);
    replaced = [];
    is("the closing store is prepared and out of line", [stores, line(OWNER, at)], [1, "out"]);
    is("the owner's calendar is kept (unknown is never \"no other store\")", calendarKept(OWNER), [1, 1, 1, 1]);
    is("the closing store's record is gone; the extra store is still there", [(await storeForEmail(OWNER)) === null, redis.run(["SCARD", accountStoresKey(OWNER)])], [true, 1]);
  }
  {
    fresh();
    const at = await closing(OWNER, "closing", extraStore);
    // The extra store's record answers in a shape that is not a store.
    const extra = `#${redis.run(["SMEMBERS", accountStoresKey(OWNER)])[0]}`;
    replaced = [{ word: "GET", key: ownerKey(extra), reply: 42 }];
    const stores = await walkAt(at);
    replaced = [];
    is("an extra store whose record does not read: prepared, out of line, calendar kept", [stores, line(OWNER, at), calendarKept(OWNER)], [1, "out", [1, 1, 1, 1]]);
  }
  {
    fresh();
    const at = await closing(OWNER, "closing");
    const stores = await walkAt(at);
    is("control: an owner with no other store loses their calendar with their last store", [stores, calendarKept(OWNER)], [1, [0, 0, 0, 0]]);
  }

  // X owns the closing store and hosts on Y's live store as a teammate.
  const X = "host-x@example.com";
  const Y = "owner-y@example.com";
  async function teammate(junk = 0): Promise<{ at: number; sid: string }> {
    fresh();
    await claimHandle(Y, "owneryb", "Owner Y", "");
    const b = (await ensureStoreId(Y))!;
    // Other stores' ids in X's index first, each with no team: none of them is a store X serves.
    for (let i = 0; i < junk; i += 1) redis.run(["SADD", teamIndexKey(X), createHash("md5").update(`junk${i}`).digest("hex")]);
    if (!(await putMember(b, X, "admin"))) throw new Error("setup: X is not on Y's team");
    if (redis.run(["SISMEMBER", teamIndexKey(X), b.sid]) !== 1) throw new Error("setup: the team index formula does not match lib/team.ts");
    return { at: await closing(X, "hostxa"), sid: b.sid };
  }

  part("MEDIUM: a teammate on another live store keeps their calendar when that store's team does not read; the closing store is erased");
  {
    const { at, sid } = await teammate();
    replaced = [{ word: "GET", key: teamKey(sid), reply: 42 }];
    const stores = await walkAt(at);
    replaced = [];
    is("prepared, out of line, calendar kept", [stores, line(X, at), calendarKept(X)], [1, "out", [1, 1, 1, 1]]);
  }
  part("MEDIUM: ... or when that store's record does not read");
  {
    const { at } = await teammate();
    replaced = [{ word: "GET", key: ownerKey(Y), reply: 42 }];
    const stores = await walkAt(at);
    replaced = [];
    is("prepared, out of line, calendar kept", [stores, line(X, at), calendarKept(X)], [1, "out", [1, 1, 1, 1]]);
  }
  part("MEDIUM (Claude 4 on #3660): a host on more stores than are read never makes a closing store unerasable");
  {
    const { at } = await teammate(50);
    const stores = await walkAt(at);
    is("fifty-one stores in the index, the live one among them: the closing store is erased, at the first walk", [stores, line(X, at), (await storeForEmail(X)) === null], [1, "out", true]);
    is("... and the host's calendar is kept", calendarKept(X), [1, 1, 1, 1]);
  }
  {
    fresh();
    await claimHandle(Y, "owneryb", "Owner Y", "");
    for (let i = 0; i < 51; i += 1) redis.run(["SADD", teamIndexKey(X), createHash("md5").update(`junk${i}`).digest("hex")]);
    const at = await closing(X, "hostxa");
    const stores = await walkAt(at);
    is("fifty-one ids, none a live store: erased, the calendar kept (more than are read is unknown, never \"none\")", [stores, line(X, at), calendarKept(X)], [1, "out", [1, 1, 1, 1]]);
  }
  {
    const { at } = await teammate(49);
    const stores = await walkAt(at);
    is("control: fifty, the live one among them: prepared, calendar kept", [stores, calendarKept(X)], [1, [1, 1, 1, 1]]);
  }
  {
    fresh();
    await claimHandle(Y, "owneryb", "Owner Y", "");
    for (let i = 0; i < 3; i += 1) redis.run(["SADD", teamIndexKey(X), createHash("md5").update(`junk${i}`).digest("hex")]);
    const at = await closing(X, "hostxa");
    const stores = await walkAt(at);
    is("control: on no other store's team (stale index): prepared, calendar gone", [stores, calendarKept(X)], [1, [0, 0, 0, 0]]);
  }

  part("MEDIUM (Claude 4 on #3660 at af59d74bde): one unreadable reply never keeps a host's calendar for good");
  /** The batch's entries left: a store whose host's calendar is still to decide stays in it, set aside. */
  const batchLeft = () => redis.run(["HLEN", BATCH_KEY]);
  {
    fresh();
    // The owner serves no other store; their team index answers once in a shape that is not a list.
    const at = await closing(OWNER, "transient");
    replaced = [{ word: "SMEMBERS", key: teamIndexKey(OWNER), reply: "ERR synthetic transient" }];
    const stores = await walkAt(walkTime(at, 0));
    replaced = [];
    is("first walk: prepared, out of line, record gone, calendar kept while unknown", [stores, line(OWNER, at), (await storeForEmail(OWNER)) === null, calendarKept(OWNER)], [1, "out", true, [1, 1, 1, 1]]);
    is("... and the store stays in the batch, set aside, so its host's calendar is decided again", batchLeft(), 1);
    for (let k = 1; k <= 3; k += 1) await walkAt(walkTime(at, k));
    is("a later run reads it: the host serves no other store, so their calendar goes, and the store leaves the batch", [calendarKept(OWNER), batchLeft()], [[0, 0, 0, 0], 0]);
  }
  {
    // Fifty-one stores in X's index, the live one among them, first: found among those read, so X is known to serve it.
    fresh();
    await claimHandle(Y, "owneryb", "Owner Y", "");
    const b = (await ensureStoreId(Y))!;
    if (!(await putMember(b, X, "admin"))) throw new Error("setup: X is not on Y's team");
    for (let i = 0; i < 50; i += 1) redis.run(["SADD", teamIndexKey(X), createHash("md5").update(`junk${i}`).digest("hex")]);
    const at = await closing(X, "hostxa");
    await walkAt(walkTime(at, 0));
    is("more stores than are read, the live one found among them: the calendar kept and nothing left to decide", [calendarKept(X), batchLeft()], [[1, 1, 1, 1], 0]);
  }
  {
    // The same, the live one past those read: still not known, so kept and decided again, but the store is told once.
    const { at } = await teammate(50);
    let told = 0;
    const count = async () => { told += 1; };
    for (let k = 0; k <= 2; k += 1) await eraseClosed(Date.now() + 60_000, count, walkTime(at, k));
    is("the live one past those read: the calendar kept, still to decide, and the store's last mark written once", [calendarKept(X), batchLeft(), told], [[1, 1, 1, 1], 1, 1]);
  }

  part("LOW: a page of a host's claims that does not read is never their end");
  async function claimed(): Promise<{ at: number; key: string }> {
    fresh();
    await claimHandle(OWNER, "claims", "Claims", "");
    const store = (await ensureStoreId(OWNER))!;
    const key = claimsKey(hostId(OWNER));
    const start = Date.now() + 86_400_000;
    redis.run(["HSET", key, "claim1", `${start}|${start + 1_800_000}|0|${store.sid}`]);
    await closeForErasure(OWNER);
    const at = Date.now();
    await markDue(OWNER, at - 1000);
    return { at, key };
  }
  {
    const { at, key } = await claimed();
    replaced = [{ word: "HSCAN", key, reply: "ERR synthetic unreadable reply" }];
    const stores = await walkAt(at);
    replaced = [];
    is("an HSCAN that is not a page: not prepared, its claim kept, moved back", [stores, redis.run(["HEXISTS", key, "claim1"]), line(OWNER, at)], [0, 1, "moved back"]);
    const again = await walkAt(at + WALK_GAP_MS + 60_000);
    is("control: once it reads, prepared, its claim gone", [again, redis.run(["HEXISTS", key, "claim1"])], [1, 0]);
  }
  {
    const { at, key } = await claimed();
    replaced = [{ word: "HSCAN", key, reply: ["0", ["claim1"]] }];
    const stores = await walkAt(at);
    replaced = [];
    is("a page with a field and no value: not prepared, moved back", [stores, line(OWNER, at)], [0, "moved back"]);
  }
  {
    const { at, key } = await claimed();
    replaced = [{ word: "HSCAN", key, reply: ["1", []] }];
    const stores = await walkAt(at);
    replaced = [];
    is("fifty pages not at their end: not prepared, its claim kept, moved back", [stores, redis.run(["HEXISTS", key, "claim1"]), line(OWNER, at)], [0, 1, "moved back"]);
  }

  part("LOW (Claude 4 on #3660): more pages of claims than a walk reads go on from where they stopped, to their end");
  /** A host's claims as 121 pages: cursor n answers n + 1 and nothing, and the last page the claim, with cursor 0. */
  function pages(key: string, asked: string[], failAt = -1): void {
    const value = redis.run(["HGET", key, "claim1"]);
    let failed = false;
    replaced = [{
      word: "HSCAN",
      key,
      reply: (command: Command) => {
        const cursor = Number(command[2]);
        asked.push(String(command[2]));
        if (cursor === failAt && !failed) {
          failed = true;
          return "ERR synthetic unreadable reply";
        }
        return cursor >= 120 ? ["0", ["claim1", value]] : [String(cursor + 1), []];
      },
    }];
  }
  {
    const { at, key } = await claimed();
    const asked: string[] = [];
    pages(key, asked);
    const first = await walkAt(walkTime(at, 0));
    is("first walk: fifty pages read, not prepared, claim kept, moved back", [first, asked.length, asked[0], redis.run(["HEXISTS", key, "claim1"]), line(OWNER, walkTime(at, 0))], [0, 50, "0", 1, "moved back"]);
    asked.length = 0;
    const second = await walkAt(walkTime(at, 1));
    is("second walk: goes on at the page where the first stopped", [second, asked.length, asked[0]], [0, 50, "50"]);
    asked.length = 0;
    const third = await walkAt(walkTime(at, 2));
    replaced = [];
    is("third walk: reaches the end, deletes the claim and erases the store", [third, asked[0], asked.at(-1), redis.run(["HEXISTS", key, "claim1"]), line(OWNER, at), (await storeForEmail(OWNER)) === null], [1, "100", "120", 0, "out", true]);
    is("where the scan stopped is not kept once the store is prepared", claimProgress(), []);
  }
  {
    const { at, key } = await claimed();
    const asked: string[] = [];
    pages(key, asked, 70);
    await walkAt(walkTime(at, 0));
    asked.length = 0;
    const second = await walkAt(walkTime(at, 1));
    is("an unreadable page on the second walk: not prepared, moved back", [second, asked.at(-1), line(OWNER, walkTime(at, 1))], [0, "70", "moved back"]);
    asked.length = 0;
    const third = await walkAt(walkTime(at, 2));
    is("... and the third walk reads that page again, losing nothing", [third, asked[0], asked.length], [0, "70", 50]);
    const fourth = await walkAt(walkTime(at, 3));
    replaced = [];
    is("the fourth walk reaches the end and erases the store", [fourth, redis.run(["HEXISTS", key, "claim1"]), line(OWNER, at), claimProgress()], [1, 0, "out", []]);
  }

  part("LOW: a store in line whose record does not read waits a walk; only nil is gone");
  for (const [what, reply] of [["a string that is not a store", "not a store {"], ["a number", 42], ["a record of another key", null]] as const) {
    fresh();
    const at = await closing(OWNER, "damaged");
    if (reply === null) {
      // The record under the owner's key, but of another store (its own key is another).
      const raw = redis.run(["GET", ownerKey(OWNER)]) as string;
      redis.run(["SET", ownerKey(OWNER), JSON.stringify({ ...JSON.parse(raw), email: "other@example.com" })]);
    } else replaced = [{ word: "GET", key: ownerKey(OWNER), reply }];
    const stores = await walkAt(at);
    replaced = [];
    is(`${what}: not prepared, still in line, moved back a walk`, [stores, line(OWNER, at)], [0, "moved back"]);
  }
  {
    fresh();
    const at = await closing(OWNER, "gone");
    redis.run(["DEL", ownerKey(OWNER)]);
    const stores = await walkAt(at);
    is("control: no record (nil): out of line, nothing prepared", [stores, line(OWNER, at)], [0, "out"]);
  }
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
