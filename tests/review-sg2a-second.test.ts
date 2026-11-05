/**
 * Independent review of PR #2560 at 2c1c084a3 (delta 0deaef36e..2c1c084a3).
 * Each section is a scenario the delta says cannot happen; each fails at that head.
 */
import { createHash } from "node:crypto";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, storeForEmail } from "@/lib/store";
import { finishClosed } from "@/lib/plan-closing";
import { WALK_GAP_MS, eraseClosed, markDue, stopRenewals } from "@/lib/closed-store-data";

type Command = (string | number)[];
const real = redis.pipeline;
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
function failing(when: Rule["when"], answer: Rule["answer"], times = 1): Rule {
  const rule = { when, answer, times, used: 0 };
  rules.push(rule);
  return rule;
}

const DAY = 86_400_000;
let clock = Date.UTC(2026, 10, 5);
const later = () => (clock += WALK_GAP_MS + DAY);
const run = () => eraseClosed(Date.now() + 30_000, finishClosed, clock);
const inBatch = async (ref: string) => (await real([["HEXISTS", "nl:closed:batch", ref]]))[0];
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
/** `days` gaps, each run until its walk is done; answers how many walks were started. */
async function days(n: number): Promise<number> {
  let walks = 0;
  for (let i = 0; i < n; i += 1) {
    later();
    let report = await quietly(() => run().catch(() => ({ done: false, started: false })));
    if (report.started) walks += 1;
    for (let j = 0; j < 5 && !report.done; j += 1) report = await quietly(() => run().catch(() => ({ done: false, started: false })));
  }
  return walks;
}
const closingState = async (ref: string) => JSON.parse(String((await real([["GET", `nl:plan:closing:${createHash("sha256").update(ref).digest("hex").slice(0, 40)}`]]))[0] ?? "{}")) as { erased?: number };

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

  await section("D: its owner opens a new store under the same key while its walk runs", async () => {
    later();
    const ana = await closing("anaold");
    // The walk's first page: by then its first step deleted the record; the owner opens a store again (EC1 expects it).
    failing((c) => c[0] === "SCAN", async (c) => {
      await claimHandle(ana, "ananew", "ana new studio", "");
      return (await real([c]))[0];
    });
    const walks = await days(6);
    const now = await storeForEmail(ana);
    console.log(`  after 6 gaps: walks started ${walks}, old store in batch ${await inBatch(ana)}, its closing says erased ${(await closingState(ana)).erased !== undefined}, the store under the key ${now?.handle ?? "none"}`);
    is("the new store is untouched", now?.handle, "ananew");
    is("the closed store is finished (its records are gone), not left in the batch to be walked every day for ever", [await inBatch(ana), (await closingState(ana)).erased !== undefined], [0, true]);
    is("and the whole database is not walked every day for it", walks <= 1, true);
    await real([["HDEL", "nl:closed:batch", ana], ["HSET", "nl:closed:walk", "left", 0]]);
  });

  await section("E: one company list that cannot be read holds every store, for ever", async () => {
    later();
    await real([["ZADD", "nl:call:remindq", 1, "someone-elses-call"]]);
    const bea = await closing("beaidx");
    const cyd = await closing("cydidx");
    failing((c) => c[0] === "TYPE" && c[1] === "nl:call:remindq", () => "not-a-kind", 1_000_000);
    await days(6);
    const finished = [(await closingState(bea)).erased !== undefined, (await closingState(cyd)).erased !== undefined];
    console.log(`  after 6 gaps: finished ${finished.join(", ")}; still in batch ${await inBatch(bea)}, ${await inBatch(cyd)}`);
    // What the code says (PAGE_TRIES): "one key never holds every store for ever".
    is("a key that cannot be read does not hold every store of the walk for ever", finished.includes(true), true);
    rules = [];
    await real([["HDEL", "nl:closed:batch", bea, cyd], ["HSET", "nl:closed:walk", "left", 0]]);
  });

  await section("F: a renewal of a status the list does not name is taken for none", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_review_sg2a_only_a_stand_in";
    later();
    const seller = { ...(await storeForEmail(await closing("gusstatus")))!, stripeAccountId: "acct_reviewsg2a02" };
    const before = globalThis.fetch;
    // A membership in a status Stripe may add (Stripe's search answers by the status it is asked for).
    const rows = [{ id: "sub_new", status: "on_hold" }];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const status = /status:'([a-z_]+)'/.exec(url.searchParams.get("query") ?? "")?.[1];
      const data = status ? rows.filter((r) => r.status === status) : rows;
      return Response.json({ object: "search_result", data, has_more: false, next_page: null });
    }) as typeof fetch;
    try {
      const result = await stopRenewals(seller, Date.now() + 60_000);
      console.log(`  done ${result.done}, found ${result.subs.length}`);
      is("an unknown status is never \"nothing left to stop\"", result.done, false);
    } finally {
      globalThis.fetch = before;
    }
  });

  await section("G: its record's delete failed in the first step, so the store lives through its walk; what it writes then outlives 'erased'", async () => {
    later();
    const eve = await closing("evelive");
    const eveStore = (await storeForEmail(eve))!;
    is("the store has a stats id", typeof eveStore.statsId, "string");
    // The first step's DEL of the record times out (nothing after it runs); the batch was written before it.
    failing((c) => c[0] === "DEL" && String(c[1]).startsWith("nl:store:owner:"), () => {
      throw new Error("Redis request timed out");
    });
    // After the walk read every page, before its finish: a visitor joins the still-live store's list.
    const leads = `nl:store:leads:${eveStore.statsId}`;
    // A visitor can only join a store that is still on the air (its record there); the fix keeps it off the air before its walk.
    let liveDuringWalk = false;
    failing((c) => c[0] === "HSET" && c[1] === "nl:closed:walk" && c.includes("finish"), async (c) => {
      liveDuringWalk = (await storeForEmail(eve)) !== null;
      if (liveDuringWalk) await real([["HSET", leads, "visitor@example.com", JSON.stringify({ e: "visitor@example.com", t: "tok" })]]);
      return (await real([c]))[0];
    });
    await days(1);
    const erased = (await closingState(eve)).erased !== undefined;
    const kept = (await real([["EXISTS", leads]]))[0];
    console.log(`  record ${(await storeForEmail(eve))?.handle ?? "gone"}, closing says erased ${erased}, a visitor's address kept ${kept === 1}`);
    is("never 'erased' while a person's record written for it is kept", erased && kept === 1, false);
    is("and the store is off the air for its whole walk", liveDuringWalk, false);
  });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
