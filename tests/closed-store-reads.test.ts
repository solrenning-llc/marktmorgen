/**
 * The walk that deletes closed stores' records, when Redis does not answer
 * as it should (audit SG2, findings 2, 3 and 18; CX-123 rules 24, 28 and 30).
 * An answer that fails, or comes back in any shape but its exact one, never
 * becomes "the store is gone", "it has nothing" or "it is done": nothing of
 * the store is deleted on it, the store stays in line and is tried again, its
 * owner is never told its records are deleted for a part of them, and a store
 * that always fails is tried a bounded number of times and then said, never
 * dropped. All in the in-memory Redis, with failures put in front of it.
 */
import { createHash } from "node:crypto";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, storeForEmail, storeRef } from "@/lib/store";
import { putMember } from "@/lib/team";
import { claimsKey, hostId } from "@/lib/host-claims";
import { finishClosed } from "@/lib/plan-closing";
import { type Batched, DUE_KEY, FOLLOWERS, PARKED_AT, PREPARE_TRIES, WALK_GAP_MS, deleteSalesTraces, eraseClosed, markDue, stopRenewals } from "@/lib/closed-store-data";

type Command = (string | number)[];
const real = redis.pipeline;
/** Each rule answers a command in place of Redis, or throws for it; `times` of them at the most. */
type Rule = { when: (command: Command) => boolean; answer: (command: Command) => unknown; times: number; used: number };
let rules: Rule[] = [];
redis.pipeline = async (commands: Command[]) => {
  const out: unknown[] = [];
  for (const command of commands) {
    const rule = rules.find((r) => r.used < r.times && r.when(command));
    if (rule) {
      rule.used += 1;
      out.push(rule.answer(command));
    } else out.push((await real([command]))[0]);
  }
  return out;
};
const timeout = () => {
  throw new Error("Redis request timed out");
};
function failing(when: Rule["when"], answer: Rule["answer"] = timeout, times = 1): Rule {
  const rule = { when, answer, times, used: 0 };
  rules.push(rule);
  return rule;
}
const is1 = (name: string, prefix: string) => (command: Command) => String(command[0]) === name && String(command[1] ?? "").startsWith(prefix);

const DAY = 86_400_000;
let clock = Date.UTC(2026, 10, 5);
const later = () => (clock += WALK_GAP_MS + DAY);
const run = () => eraseClosed(Date.now() + 30_000, finishClosed, clock);
const dueScore = async (ref: string) => (await real([["ZSCORE", DUE_KEY, ref]]))[0];
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const before = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = before;
  }
}

async function closing(handle: string): Promise<string> {
  const email = `${handle}@example.com`;
  await claimHandle(email, handle, `${handle} studio`, "");
  await markDue(email, clock);
  return email;
}

/** One part: an error it did not expect is a failing check, and the parts after it still run. */
async function section(name: string, work: () => Promise<void>): Promise<void> {
  part(name);
  rules = [];
  try {
    await work();
  } catch (error) {
    is(`${name}: runs to its end`, String(error), "no error");
  }
}

async function main(): Promise<void> {
  redis.clear();

  await section("Finding 2: a failed read of a closed store keeps it in line", async () => {
  const ada = await closing("adaclosing");
  const lost = failing(is1("GET", "nl:store:owner:"));
  const first = await quietly(run);
  is("its record's read timed out: nothing is deleted, it stays in line, the failure is counted", [lost.used, first.stores, first.failed, first.started, await dueScore(ada) !== null, (await storeForEmail(ada))?.handle], [1, 0, 1, false, true, "adaclosing"]);
  later();
  failing(is1("GET", "nl:store:owner:"), () => ({ not: "a record" }));
  const second = await quietly(run);
  is("an answer of an unknown shape is no answer either", [second.failed, await dueScore(ada) !== null, (await storeForEmail(ada))?.handle], [1, true, "adaclosing"]);
  later();
  let walked = await run();
  for (let i = 0; i < 5 && !walked.done; i += 1) walked = await run();
  is("once Redis answers, it is prepared, walked and finished", [walked.done, await dueScore(ada), await storeForEmail(ada)], [true, null, null]);

  });

  await section("Only an exact \"gone\" that is truly done takes a store out of line", async () => {
  const ghost = "never-a-store@example.com";
  later();
  await markDue(ghost, clock);
  const ghostRun = await quietly(run);
  is("a record that is gone, and was never prepared for its walk, stays in line and is said", [ghostRun.failed, await dueScore(ghost) !== null], [1, true]);
  await real([["ZREM", DUE_KEY, ghost], ["HDEL", "nl:closed:walk", `tries:${ghost}`]]);
  later();
  const bea = await closing("beaclosing");
  failing((c) => c[0] === "ZREM" && c[1] === DUE_KEY && c[2] === bea);
  failing((c) => c[0] === "HLEN");
  const crashed = await quietly(() => run().then(() => "ran", () => "stopped"));
  const inBatch = async () => (await real([["HEXISTS", "nl:closed:batch", bea]]))[0];
  is("prepared, then taking it out of line failed and the run stopped: in the walk's batch, its record gone, still in line", [crashed, await inBatch(), await storeForEmail(bea), await dueScore(bea) !== null], ["stopped", 1, null, true]);
  later();
  let after = await run();
  is("the next run finds its record exactly gone and its walk prepared: out of line, not a failure", [after.failed, after.started, await dueScore(bea)], [0, true, null]);
  for (let i = 0; i < 5 && !after.done; i += 1) after = await run();
  is("and its walk is finished", [after.done, await inBatch()], [true, 0]);

  });

  await section("Finding 3: a failed read of what a store is made of stops its deletion before anything goes", async () => {
  later();
  const cyd = await closing("cydclosing");
  const cydStore = (await storeForEmail(cyd))!;
  is("a helper joins its team", await putMember(cydStore, "helper@example.com", "editor"), true);
  await real([["HSET", claimsKey(hostId(cyd)), "claim1", `1|2|0|${cydStore.sid}`]]);
  const team = failing(is1("GET", "nl:team:"));
  const teamRun = await quietly(run);
  is("its team could not be read: its record, its claims and its team are kept, it stays in line", [team.used, teamRun.failed, teamRun.started, (await storeForEmail(cyd))?.handle, (await real([["HLEN", claimsKey(hostId(cyd))]]))[0], await dueScore(cyd) !== null], [1, 1, false, "cydclosing", 1, true]);
  const marks = failing(is1("GET", "nl:mail:flows:"), timeout, 1);
  is("a failed read of what it is made of is never taken for nothing on its closing day either", [await deleteSalesTraces(cydStore).then(() => "deleted", () => "failed"), marks.used], ["failed", 1]);
  marks.used = marks.times;
  });

  await section("Finding 18: a reply of another shape stops the step, and nothing is said done for a part", async () => {
  later();
  const fin = await closing("finclosing");
  const finStore = (await storeForEmail(fin))!;
  await real([["HSET", claimsKey(hostId(fin)), "claim1", `1|2|0|${finStore.sid}`]]);
  failing((c) => c[0] === "HSCAN" && c[1] === claimsKey(hostId(fin)), () => "not a page");
  const claimsRun = await quietly(run);
  is("a host's claims answered in another shape: its record and claims are kept", [claimsRun.failed, (await storeForEmail(fin))?.handle, (await real([["HLEN", claimsKey(hostId(fin))]]))[0]], [1, "finclosing", 1]);
  later();
  failing((c) => c[0] === "SCAN", () => ["0", "no keys"]);
  const scanRun = await quietly(() => run().then((r) => r, (e: unknown) => e as Error));
  const stateOf = async () => JSON.parse(String((await real([["GET", `nl:plan:closing:${createHash("sha256").update(storeRef(finStore)).digest("hex").slice(0, 40)}`]]))[0] ?? "{}")) as { erased?: number };
  is("a page of the walk in another shape: the run stops, its store is not finished, its owner not told", [scanRun instanceof Error, (await stateOf()).erased ?? null, await storeForEmail(fin)], [true, null, null]);
  let resumed = await run();
  for (let i = 0; i < 5 && !resumed.done; i += 1) resumed = await run();
  is("the next run walks the database again from where it was, and finishes it", [resumed.done, resumed.finished, (await real([["HLEN", claimsKey(hostId(fin))]]))[0]], [true, 1, 0]);

  });

  await section("Finding 18: each follower's read refuses a reply of another shape", async () => {
  const entry: Batched = { ref: "x@example.com", email: "x@example.com", sid: "0".repeat(32), statsId: null, name: "x", handle: "x", handles: ["x"], marks: [], endedAt: 0, at: 0 };
  const rejects = (work: Promise<unknown>) => work.then(() => "answered", () => "refused");
  await real([["SET", "nl:pod:by:a1", "tokenA"], ["SET", "nl:pod:by:a2", "tokenB"]]);
  failing((c) => c[0] === "MGET", () => ["tokenA"]);
  is("MGET answering fewer values than keys is refused, never lined up with the wrong keys", await rejects(FOLLOWERS["nl:pod:by:"].find(["nl:pod:by:a1", "nl:pod:by:a2"], entry)), "refused");
  await real([["SADD", "nl:erase:ix:a1", "nl:erase:link:one"]]);
  failing((c) => c[0] === "SUNION", () => "OK");
  is("SUNION answering anything but its members is refused", await rejects(FOLLOWERS["nl:erase:ix:"].find(["nl:erase:ix:a1"], entry)), "refused");
  failing((c) => c[0] === "SUNION");
  is("SUNION timing out is refused, never read again key by key as if the keys were of another kind", await rejects(FOLLOWERS["nl:erase:ix:"].find(["nl:erase:ix:a1"], entry)), "refused");
  await real([["SADD", "nl:agree:s:a1", "f".repeat(32)]]);
  failing((c) => c[0] === "SSCAN", () => ["0"]);
  is("SSCAN answering without its page is refused", await rejects(FOLLOWERS["nl:agree:s:"].find(["nl:agree:s:a1"], entry)), "refused");
  failing((c) => c[0] === "TYPE", () => 42);
  is("TYPE answering no kind is refused, never taken for a key that is gone", await rejects(FOLLOWERS["nl:agree:s:"].find(["nl:agree:s:a1"], entry)), "refused");
  await real([["HSET", `nl:store:leads:${"a".repeat(32)}`, "one", "{}"]]);
  failing((c) => c[0] === "HSCAN", () => [0, []]);
  is("HSCAN answering a cursor that is not one is refused", await rejects(FOLLOWERS["nl:store:leads:"].find([`nl:store:leads:${"a".repeat(32)}`], entry)), "refused");
  is("and when each answers as it should, each is read", [await FOLLOWERS["nl:pod:by:"].find(["nl:pod:by:a1", "nl:pod:by:a2"], entry).then((k) => k.length), await FOLLOWERS["nl:agree:s:"].find(["nl:agree:s:a1"], entry).then((k) => k.length > 0)], [2, true]);

  });

  await section("A store that always fails is tried a bounded number of times, then said, never dropped; the others go on", async () => {
  later();
  const dan = await closing("danclosing");
  const eve = await closing("eveclosing");
  const danStore = (await storeForEmail(dan))!;
  await putMember(danStore, "helper2@example.com", "editor");
  failing((c) => c[0] === "GET" && c[1] === `nl:team:${danStore.sid}`, timeout, 1_000);
  let tries = 0;
  let parked = 0;
  for (let attempt = 0; attempt < PREPARE_TRIES + 3; attempt += 1) {
    later();
    let report = await quietly(run);
    tries += report.failed;
    parked = report.parked;
    for (let i = 0; i < 5 && !report.done; i += 1) report = await quietly(run);
  }
  is("it is tried exactly PREPARE_TRIES times, then parked in line and said on every run", [tries, parked, await dueScore(dan), (await storeForEmail(dan))?.handle], [PREPARE_TRIES, 1, String(PARKED_AT), "danclosing"]);
  is("the store due beside it is deleted all the same", [await storeForEmail(eve), await dueScore(eve)], [null, null]);
  });

  await section("The same rule on Stripe: renewals are never said all stopped on an answer of another shape", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_closed_store_reads_only_a_stand_in";
  const seller = { ...(await storeForEmail(await closing("gusclosing")))!, stripeAccountId: "acct_closedreads01" };
  const before = globalThis.fetch;
  const answer = (search: (page: string) => unknown, deleted: unknown = { id: "sub_1", status: "canceled" }) => {
    const asked: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      asked.push(`${init?.method ?? "GET"} ${url.pathname}`);
      return Response.json(init?.method === "DELETE" ? deleted : search(url.searchParams.get("page") ?? ""));
    }) as typeof fetch;
    return asked;
  };
  const outcome = (work: Promise<{ done: boolean; stopped: number }>) => work.then((r) => (r.done ? `done, ${r.stopped} stopped` : `not done, ${r.stopped} stopped`), () => "refused");
  try {
    answer(() => ({ error: "not a list" }));
    is("a search answered without its list is refused, never \"none to stop\"", await outcome(stopRenewals(seller, Date.now() + 10_000)), "refused");
    answer(() => ({ object: "search_result", data: [{ status: "active" }], has_more: false, next_page: null }));
    is("a membership without its id is refused, never passed over", await outcome(stopRenewals(seller, Date.now() + 10_000)), "refused");
    answer(() => ({ object: "search_result", data: [], has_more: true, next_page: null }));
    is("more to read, and no page to read it by: refused", await outcome(stopRenewals(seller, Date.now() + 10_000)), "refused");
    answer((page) => ({ object: "search_result", data: [], has_more: true, next_page: `p${Number(page.slice(1) || 0) + 1}` }));
    is("pages that never end are not all stopped", await outcome(stopRenewals(seller, Date.now() + 10_000)), "not done, 0 stopped");
    answer(() => ({ object: "search_result", data: [{ id: "sub_1", status: "active" }], has_more: false, next_page: null }), { id: "sub_1", status: "active" });
    is("a cancel Stripe answers without ending it is not counted stopped", await outcome(stopRenewals(seller, Date.now() + 10_000)), "not done, 0 stopped");
    answer(() => ({ object: "search_result", data: [{ id: "sub_1", status: "active" }, { id: "sub_2", status: "canceled" }], has_more: false, next_page: null }), { id: "sub_1", status: "canceled" });
    is("and the exact answers stop it", await outcome(stopRenewals(seller, Date.now() + 10_000)), "done, 1 stopped");
  } finally {
    globalThis.fetch = before;
  }
  });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
