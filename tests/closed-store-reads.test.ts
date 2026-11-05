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
import { finishClosed, renewalsAskToday, renewalsLate, renewalsMayClose, RENEWAL_LATE_GAP_DAYS, RENEWAL_TRY_DAYS } from "@/lib/plan-closing";
import { COMMAND, PREPARE_COMMANDS } from "./plan-cost-registry";
import { type Batched, DUE_KEY, FOLLOWERS, LEFT_WALKS, PRUNE_KEY, UNREAD_TRIES, closedDataLine, closedDataNow, PAGE_TRIES, PARKED_GAP_MS, PARKED_TRIES, PREPARE_TRIES, STOPPED_AT, WALK_GAP_MS, retryCommandsAtMost, deleteSalesTraces, eraseClosed, markDue, stopRenewals } from "@/lib/closed-store-data";

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
      out.push(await rule.answer(command));
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

  await section("A store that always fails is tried a bounded number of times a day, then once a week by itself, said, never dropped; the others go on", async () => {
  later();
  const dan = await closing("danclosing");
  const eve = await closing("eveclosing");
  const danStore = (await storeForEmail(dan))!;
  await putMember(danStore, "helper2@example.com", "editor");
  const team = failing((c) => c[0] === "GET" && c[1] === `nl:team:${danStore.sid}`, timeout, 1_000);
  let tries = 0;
  let parked = 0;
  for (let attempt = 0; attempt < PREPARE_TRIES * 2 && tries < PREPARE_TRIES; attempt += 1) {
    later();
    let report = await quietly(run);
    tries += report.failed;
    parked = report.parked;
    for (let i = 0; i < 5 && !report.done; i += 1) report = await quietly(run);
  }
  is("it is tried PREPARE_TRIES times a gap apart, then parked: due again a week later, said, its record kept", [tries, parked, Number(await dueScore(dan)) - clock, (await storeForEmail(dan))?.handle], [PREPARE_TRIES, 1, PARKED_GAP_MS, "danclosing"]);
  is("the store due beside it is deleted all the same", [await storeForEmail(eve), await dueScore(eve)], [null, null]);
  clock += PARKED_GAP_MS - DAY;
  const waiting = await quietly(run);
  is("within the week it is not tried, and it is said on every run", [waiting.failed, waiting.parked], [0, 1]);
  clock += 2 * DAY;
  const weekly = await quietly(run);
  is("a week later it is tried again by itself, with no hand", [weekly.failed, team.used > PREPARE_TRIES], [1, true]);
  team.times = team.used;
  clock += PARKED_GAP_MS + DAY;
  let healed = await quietly(run);
  for (let i = 0; i < 5 && !healed.done; i += 1) healed = await quietly(run);
  const after = await quietly(run);
  is("once the cause is gone, the next weekly try deletes it, and nothing is parked any more", [await storeForEmail(dan), await dueScore(dan), after.parked], [null, null, 0]);
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
    const unfiltered = { ...seller, handle: "gusopen", previousHandles: [], releasedHandles: [] };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const statusAsked = /status:/.test(url.searchParams.get("query") ?? "");
      const n = Number((url.searchParams.get("page") ?? "p0").slice(1)) || 0;
      return Response.json(statusAsked ? { object: "search_result", data: [], has_more: false, next_page: null } : { object: "search_result", data: [{ id: `sub_old_${n}`, status: "canceled" }], has_more: n < 60, next_page: n < 60 ? `p${n + 1}` : null });
    }) as typeof fetch;
    is("more pages with no status asked than a day reads: not all stopped that day", await outcome(stopRenewals(unfiltered, Date.now() + 10_000)), "not done, 0 stopped");
    is("and the next day reads on from where it stopped, to the end", await outcome(stopRenewals(unfiltered, Date.now() + 10_000)), "done, 0 stopped");
    answer(() => ({ object: "search_result", data: [{ id: "sub_1", status: "active" }, { id: "sub_2", status: "canceled" }], has_more: false, next_page: null }), { id: "sub_1", status: "canceled" });
    is("and the exact answers stop it", await outcome(stopRenewals(seller, Date.now() + 10_000)), "done, 1 stopped");
  } finally {
    globalThis.fetch = before;
  }
  });

  /** Every run to the end of its walk; after each, a store said erased never has its record still there. */
  async function walkedOut(refs: string[], runs = 8): Promise<boolean> {
    let honest = true;
    for (let i = 0; i < runs; i += 1) {
      later();
      for (let j = 0; j < 6; j += 1) {
        const report = await quietly(() => run().catch(() => ({ done: false })));
        for (const ref of refs) if ((await stateOfRef(ref)).erased && (await storeForEmail(ref)) !== null) honest = false;
        if (report.done) break;
      }
    }
    return honest;
  }
  const stateOfRef = async (ref: string) => JSON.parse(String((await real([["GET", `nl:plan:closing:${createHash("sha256").update(ref).digest("hex").slice(0, 40)}`]]))[0] ?? "{}")) as { erased?: number };

  await section("Review A: the first step failing after its walk has it never finishes a store with its record kept", async () => {
  // Each aimed at this store alone: another store due in the same run must not take the failure.
  const points: [string, (ref: string) => (c: Command) => boolean, Rule["answer"]][] = [
    ["the batch's write, done and then timed out", (ref) => (c) => c[0] === "HSET" && c[1] === "nl:closed:batch" && c[2] === ref, async (c) => {
      await real([c]);
      throw new Error("Redis request timed out");
    }],
    ["taking it out of the closing day's line", (ref) => (c) => c[0] === "ZREM" && c[1] === "nl:closing:final" && c[2] === ref, timeout],
    ["its record's delete", () => (c) => c[0] === "DEL" && String(c[1]).startsWith("nl:store:owner:"), timeout],
  ];
  for (const [name, when, answer] of points) {
    rules = [];
    // Nothing else due: every store before this one is finished first.
    await walkedOut([], 2);
    later();
    const ref = await closing(`pt${points.findIndex((p) => p[0] === name)}closing`);
    const hit = failing(when(ref), answer);
    const honest = await walkedOut([ref]);
    is(`${name}: never erased with its record there; in the end its record is gone, it is erased and out of line`, [hit.used, honest, await storeForEmail(ref), (await stateOfRef(ref)).erased !== undefined, await dueScore(ref)], [1, true, null, true, null]);
  }
  });

  await section("A store its owner deleted while it waited for its walk is finished, its keys named by its id deleted", async () => {
  later();
  const sid = "e".repeat(32);
  const ref = `#${sid}`;
  await real([["SET", `nl:api:keys:${sid}`, "{}"]]);
  await markDue(ref, clock);
  await walkedOut([ref], 2);
  is("out of line, its key named by its id gone, its closing record says erased", [await dueScore(ref), (await real([["EXISTS", `nl:api:keys:${sid}`]]))[0], (await stateOfRef(ref)).erased !== undefined], [null, 0, true]);
  });

  await section("A key the walk can never read is passed over after PAGE_TRIES runs: its store waits for the next walk, the others finish", async () => {
  later();
  const hal = await closing("halclosing");
  const ivy = await closing("ivyclosing");
  const halSid = (await storeForEmail(hal))!.sid;
  await real([["SET", `nl:pod:by:${halSid}`, "token-hal"]]);
  const stuck = failing((c) => c[0] === "MGET" && c.includes(`nl:pod:by:${halSid}`), () => "not a list", 1_000);
  later();
  const reports: { left: number; finished: number; done: boolean }[] = [];
  for (let i = 0; i < PAGE_TRIES + 2; i += 1) reports.push(await quietly(() => run().catch(() => ({ left: -1, finished: 0, done: false }))));
  const last = reports.find((r) => r.done);
  is("it fails PAGE_TRIES runs, then the page is passed: hal left, ivy finished, hal's key kept", [stuck.used, last?.left, await storeForEmail(ivy), (await stateOfRef(ivy)).erased !== undefined, (await stateOfRef(hal)).erased ?? null, (await real([["EXISTS", `nl:pod:by:${halSid}`]]))[0]], [PAGE_TRIES + 1, 1, null, true, null, 1]);
  stuck.times = stuck.used;
  await walkedOut([hal], 2);
  is("the next walk takes it again by itself and finishes it, its key gone", [(await stateOfRef(hal)).erased !== undefined, (await real([["EXISTS", `nl:pod:by:${halSid}`]]))[0]], [true, 0]);
  });

  await section("A record a follower reads that cannot be read is unknown, never \"no token\"", async () => {
  const entry: Batched = { ref: "y@example.com", email: "y@example.com", sid: "1".repeat(32), statsId: null, name: "y", handle: "y", handles: ["y"], marks: [], endedAt: 0, at: 0 };
  await real([["SET", "nl:inbox:a1:c:b1", "not json"]]);
  is("an unreadable conversation is refused", await FOLLOWERS["nl:inbox:"].find(["nl:inbox:a1:c:b1"], entry).then(() => "answered", () => "refused"), "refused");
  });

  await section("Renewals: asked every day for RENEWAL_TRY_DAYS, then weekly; closed past them only when every member is held", async () => {
  const day = Date.UTC(2026, 10, 1);
  is("within the days: asked every day, never closed without them", [renewalsLate(day + (RENEWAL_TRY_DAYS - 1) * DAY, day), renewalsAskToday(day + DAY, day, day), renewalsMayClose(false, true, 0)], [false, true, false]);
  const late = day + RENEWAL_TRY_DAYS * DAY;
  is("past them: asked once a week", [renewalsLate(late, day), renewalsAskToday(late, day, late - DAY), renewalsAskToday(late, day, late - RENEWAL_LATE_GAP_DAYS * DAY)], [true, false, true]);
  is("and it closes only when every member is held and none is left to hold", [renewalsMayClose(true, true, 0), renewalsMayClose(true, false, 0), renewalsMayClose(true, true, 1)], [true, false, false]);
  });

  await section("Second review, G: a store whose record cannot be deleted sits its walk out, on the air; what a visitor writes then is deleted by the walk that takes it", async () => {
  await walkedOut([], 2);
  later();
  const kim = await closing("kimlive");
  const kimStore = (await storeForEmail(kim))!;
  const leads = `nl:store:leads:${kimStore.statsId}`;
  // The record's DEL fails in its first step and again before its walk: it is not walked, and stays on the air.
  const del = failing((c) => c[0] === "DEL" && String(c[1]).startsWith("nl:store:owner:"), timeout, 2);
  const first = await quietly(() => run().catch(() => null));
  is("its record could not be deleted twice: it sat the walk out, left, never erased", [del.used, (await storeForEmail(kim))?.handle, first?.left, (await stateOfRef(kim)).erased ?? null], [2, "kimlive", 1, null]);
  // A visitor joins the store, still on the air.
  await real([["HSET", leads, "visitor@example.com", JSON.stringify({ e: "visitor@example.com", t: "tok" })]]);
  await walkedOut([kim], 2);
  is("the next walk deletes its record first, then the visitor's address with the rest, and only then says erased", [await storeForEmail(kim), (await real([["EXISTS", leads]]))[0], (await stateOfRef(kim)).erased !== undefined], [null, 0, true]);
  });

  await section("Second review, G: a visitor who joins while its walk runs: the store is off the air for the whole walk", async () => {
  await walkedOut([], 2);
  later();
  const lia = await closing("lialive");
  const liaStore = (await storeForEmail(lia))!;
  const leads = `nl:store:leads:${liaStore.statsId}`;
  // Its first step's DEL of the record times out once; the batch was written before it.
  failing((c) => c[0] === "DEL" && String(c[1]).startsWith("nl:store:owner:"), timeout);
  // After the walk read its pages, before its finish: a visitor joins the store if it is still on the air.
  let live = false;
  failing((c) => c[0] === "HSET" && c[1] === "nl:closed:walk" && c.includes("finish"), async (c) => {
    live = (await storeForEmail(lia)) !== null;
    if (live) await real([["HSET", leads, "visitor@example.com", JSON.stringify({ e: "visitor@example.com", t: "tok" })]]);
    return (await real([c]))[0];
  });
  later();
  let report = await quietly(() => run().catch(() => ({ done: false })));
  for (let i = 0; i < 5 && !report.done; i += 1) report = await quietly(() => run().catch(() => ({ done: false })));
  is("its record is deleted before the walk: off the air, no visitor, erased with nothing of it kept", [live, (await real([["EXISTS", leads]]))[0], (await stateOfRef(lia)).erased !== undefined, await storeForEmail(lia)], [false, 0, true, null]);
  });

  await section("Second review, D: its owner opens a store again under the same key during its walk; what that key alone names is the new store's", async () => {
  await walkedOut([], 2);
  later();
  const lou = await closing("louold");
  // At the walk's first page the owner opens a store again (EC1), and pauses it: nl:pause:<key> is the new store's.
  failing((c) => c[0] === "SCAN", async (c) => {
    await claimHandle(lou, "lounew", "lou new studio", "");
    await real([["SET", `nl:pause:${lou}`, "{\"until\":1}"], ["ZADD", "nl:plan:ended", 1, lou]]);
    return (await real([c]))[0];
  });
  await walkedOut([lou], 3);
  is("the closed store is finished once, the new one untouched: its pause and its place in the company's lists kept", [(await stateOfRef(lou)).erased !== undefined, (await real([["HEXISTS", "nl:closed:batch", lou]]))[0], (await storeForEmail(lou))?.handle, (await real([["EXISTS", `nl:pause:${lou}`]]))[0], (await real([["ZSCORE", "nl:plan:ended", lou]]))[0] !== null], [true, 0, "lounew", 1, true]);
  });

  await section("Second review, E: a list of the company's that cannot be read is passed over without holding any store, and kept for the owner's report", async () => {
  await walkedOut([], 2);
  later();
  await real([["ZADD", "nl:call:remindq", 1, "someone-elses-call"]]);
  const mia = await closing("miaidx");
  failing((c) => c[0] === "TYPE" && c[1] === "nl:call:remindq", () => "not-a-kind", 1_000);
  const reports: { done: boolean; unread: number }[] = [];
  later();
  for (let i = 0; i < PAGE_TRIES + 2; i += 1) reports.push(await quietly(() => run().catch(() => ({ done: false, unread: -1 }))));
  const walkHash = (await real([["HGETALL", "nl:closed:walk"]]))[0] as string[];
  is("after PAGE_TRIES runs the list is passed over: the store finished, the list kept in the walk's hash and said", [(await stateOfRef(mia)).erased !== undefined, walkHash.includes("unread:nl:call:remindq"), reports.find((r) => r.done)?.unread], [true, true, 1]);
  rules = [];
  await walkedOut([], 2);
  later();
  await closing("nedidx");
  await walkedOut([], 1);
  is("once a later walk reads it, it is no longer said", ((await real([["HGETALL", "nl:closed:walk"]]))[0] as string[]).includes("unread:nl:call:remindq"), false);
  });

  await section("Second review, 6: every retry has a ceiling by count, and what it can cost is bounded", async () => {
  await walkedOut([], 2);
  later();
  const ola = await closing("olastop");
  const olaStore = (await storeForEmail(ola))!;
  await real([["HSET", "nl:closed:walk", `tries:${ola}`, PREPARE_TRIES + PARKED_TRIES - 1]]);
  failing((c) => c[0] === "GET" && c[1] === `nl:team:${olaStore.sid}`, timeout, 1_000);
  const last = await quietly(run);
  const after = await quietly(run);
  is("after its last weekly try it is stopped: kept in line, never due by itself, its record kept, said on every run", [last.failed, last.stopped, Number(await dueScore(ola)), (await storeForEmail(ola))?.handle, after.stopped], [1, 1, STOPPED_AT, "olastop", 1]);
  await real([["ZREM", DUE_KEY, ola], ["HDEL", "nl:closed:walk", `tries:${ola}`]]);
  rules = [];
  // A store left LEFT_WALKS times sits every walk out: never walked or counted again by itself, said as stuck.
  const sid = "a".repeat(32);
  const pia = { ref: `#${sid}`, email: "", sid, statsId: null, name: "", handle: "", handles: [], marks: [sid], endedAt: 0, at: 0 };
  await real([["HSET", "nl:closed:batch", pia.ref, JSON.stringify(pia)], ["HSET", "nl:closed:walk", `left:${pia.ref}`, LEFT_WALKS], ["SET", `nl:api:keys:${sid}`, "{}"]]);
  later();
  const quiet = await quietly(run);
  is("a stuck store alone starts no walk, and is said", [quiet.started, quiet.stuck], [false, 1]);
  later();
  await closing("qinew");
  await walkedOut([], 1);
  is("in a walk others started it sits out: its key kept, its count not raised", [(await real([["EXISTS", `nl:api:keys:${sid}`]]))[0], (await real([["HGET", "nl:closed:walk", `left:${pia.ref}`]]))[0]], [1, String(LEFT_WALKS)]);
  await real([["HDEL", "nl:closed:batch", pia.ref], ["HDEL", "nl:closed:walk", `left:${pia.ref}`, `out:${pia.ref}`], ["DEL", `nl:api:keys:${sid}`]]);
  const worst = retryCommandsAtMost(PREPARE_COMMANDS);
  console.log(`  a failing closed store's retries at the most: ${worst} commands, $${(worst * COMMAND).toFixed(4)}`);
  is("what a failing closed store's retries can cost is a finite count of commands, under three cents", [Number.isSafeInteger(worst), worst * COMMAND < 0.03], [true, true]);
  });

  await section("Third review, I: a list passed over keeps what it owes the finished store, and is pruned when it reads", async () => {
  await walkedOut([], 2);
  later();
  const ria = await closing("riaowed");
  const sam = await closing("samowed");
  const samSid = (await storeForEmail(sam))!.sid;
  await real([["ZADD", "nl:pause:due", 4102444800, ria, 4102444800, `${samSid}|x`, 1, "someone-elses"]]);
  const odd = failing((c) => c[0] === "TYPE" && c[1] === "nl:pause:due", () => "not-a-kind", 1_000);
  later();
  for (let i = 0; i < PAGE_TRIES + 2; i += 1) await quietly(() => run().catch(() => null));
  const owed = (await real([["HKEYS", PRUNE_KEY]]))[0] as string[];
  is("the list passed over: both stores finished, what it owes each kept, the list said", [(await stateOfRef(ria)).erased !== undefined, (await stateOfRef(sam)).erased !== undefined, owed.includes(`nl:pause:due|${ria}`), owed.includes(`nl:pause:due|${sam}`), (await quietly(run)).unread], [true, true, true, true, 1]);
  // Ria opens a store again under her key before the list reads: her place in it is the new store's.
  await claimHandle(ria, "rianew", "ria new studio", "");
  odd.times = odd.used;
  later();
  await quietly(run);
  is("when it reads: the closed store's member pruned, the key a living store holds kept, nothing owed any more", [(await real([["ZSCORE", "nl:pause:due", `${samSid}|x`]]))[0], (await real([["ZSCORE", "nl:pause:due", ria]]))[0] !== null, (await real([["ZSCORE", "nl:pause:due", "someone-elses"]]))[0] !== null, ((await real([["HKEYS", PRUNE_KEY]]))[0] as string[]).length, (await quietly(run)).unread], [null, true, true, 0, 0]);
  });

  await section("Third review, I: a store is never finished when what a list owes it could not be kept", async () => {
  await walkedOut([], 2);
  later();
  const tia = await closing("tiaowed");
  await real([["ZADD", "nl:pause:due", 4102444800, tia]]);
  failing((c) => c[0] === "TYPE" && c[1] === "nl:pause:due", () => "not-a-kind", 1_000);
  const keep = failing((c) => c[0] === "HSET" && c[1] === PRUNE_KEY, timeout, 1_000);
  later();
  for (let i = 0; i < PAGE_TRIES + 3; i += 1) await quietly(() => run().catch(() => null));
  is("what it is owed cannot be written: the page is read again, the store never finished", [keep.used > 0, (await stateOfRef(tia)).erased ?? null], [true, null]);
  rules = [];
  later();
  for (let i = 0; i < 6; i += 1) await quietly(() => run().catch(() => null));
  await walkedOut([], 2);
  is("once it reads, the store is finished and its member is gone", [(await stateOfRef(tia)).erased !== undefined, (await real([["ZSCORE", "nl:pause:due", tia]]))[0]], [true, null]);
  });

  await section("Third review, 2: the owner's report line counts what is kept, numbers only", async () => {
  await real([["HSET", "nl:closed:walk", "tries:#" + "b".repeat(32), PREPARE_TRIES + PARKED_TRIES, "left:#" + "c".repeat(32), LEFT_WALKS, "unread:nl:x:list", UNREAD_TRIES]]);
  const now = await closedDataNow();
  is("counted", now && [now.stopped, now.stuck, now.unreadKept], [1, 1, 1]);
  const line = closedDataLine(now);
  is("in the owner's words, with no store and no person", [line.includes("1 sem novas tentativas"), line.includes("example.com"), line.includes("#")], [true, false, false]);
  is("unknown is said as unknown", closedDataLine(null).includes("desconhecido"), true);
  await real([["HDEL", "nl:closed:walk", "tries:#" + "b".repeat(32), "left:#" + "c".repeat(32), "unread:nl:x:list"]]);
  });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
