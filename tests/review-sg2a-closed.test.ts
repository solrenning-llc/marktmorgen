/**
 * Independent review of SG2 findings 2, 3 and 18 (branch claude4/sg2-closed-store).
 * Each section is a scenario the PR says cannot happen; each fails at its head.
 */
import { createHash } from "node:crypto";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, storeForEmail, storeRef } from "@/lib/store";
import { finishClosed } from "@/lib/plan-closing";
import { DUE_KEY, WALK_GAP_MS, eraseClosed, markDue, stopRenewals } from "@/lib/closed-store-data";

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

const DAY = 86_400_000;
let clock = Date.UTC(2026, 10, 5);
const later = () => (clock += WALK_GAP_MS + DAY);
const run = () => eraseClosed(Date.now() + 30_000, finishClosed, clock);
const dueScore = async (ref: string) => (await real([["ZSCORE", DUE_KEY, ref]]))[0];
const exists = async (key: string) => (await real([["EXISTS", key]]))[0];
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
/** Every run until the walk is done, failures said quietly. */
async function toTheEnd(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    later();
    let report = await quietly(() => run().catch(() => ({ done: false })));
    for (let j = 0; j < 5 && !report.done; j += 1) report = await quietly(() => run().catch(() => ({ done: false })));
  }
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

  await section("A: the store record's delete fails after the batch was written", async () => {
    later();
    const ana = await closing("anaclosing");
    // closeStoreRecord's pipeline: its handle's quarantine runs, then the record's DEL times out (nothing after it runs).
    const lost = failing((c) => c[0] === "DEL" && String(c[1]).startsWith("nl:store:owner:"));
    await toTheEnd();
    const record = await storeForEmail(ana);
    const inLine = (await dueScore(ana)) !== null;
    const erased = (await closingState(ana)).erased ?? null;
    is("the failing DEL was hit", lost.used, 1);
    // What the PR promises: a store whose first step failed is tried again (or parked), never finished with its record kept.
    is("its record is deleted in the end, or it is still in line; never 'erased' with its record kept for ever", record === null || (inLine && erased === null), true);
    console.log(`  state at the end: record ${record?.handle ?? "deleted"}, in line ${inLine}, closing record says erased ${erased !== null}`);
  });

  await section("B: what a store is made of answered in an unknown shape is taken for nothing", async () => {
    later();
    const bo = await closing("boclosing");
    const boStore = (await storeForEmail(bo))!;
    is("the store has a list", typeof boStore.listId, "string");
    const flowId = "flowreviewsg2a01";
    await real([["SET", `nl:mail:flows:${boStore.listId}`, JSON.stringify([{ id: flowId, name: "welcome", steps: [] }])], ["SET", `nl:mail:flowstats:${flowId}`, "{\"sent\":3}"]]);
    // The sequences' GET answers in a shape that is not a string: readFlows says "none".
    const odd = failing((c) => c[0] === "GET" && String(c[1]).startsWith("nl:mail:flows:"), () => ({ not: "a string" }));
    await toTheEnd();
    is("the odd answer was given", odd.used, 1);
    const left = await exists(`nl:mail:flowstats:${flowId}`);
    const inLine = (await dueScore(bo)) !== null;
    is("its sequence's stats are deleted, or the store is still in line; never finished with them kept for ever", left === 0 || inLine, true);
    console.log(`  state at the end: stats key kept ${left === 1}, record ${(await storeForEmail(bo))?.handle ?? "deleted"}, in line ${inLine}`);
  });

  await section("C: renewals already ended count against the page cap, so the closing never ends", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_review_sg2a_only_a_stand_in";
    later();
    const seller = { ...(await storeForEmail(await closing("cyclosing")))!, stripeAccountId: "acct_reviewsg2a01" };
    const before = globalThis.fetch;
    let searches = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      searches += 1;
      const n = Number((url.searchParams.get("page") ?? "p0").slice(1)) || 0;
      // 52 pages of memberships its members cancelled over the years, none live.
      const data = Array.from({ length: 100 }, (_, i) => ({ id: `sub_${n}_${i}`, status: "canceled" }));
      return Response.json({ object: "search_result", data, has_more: n < 51, next_page: n < 51 ? `p${n + 1}` : null });
    }) as typeof fetch;
    try {
      const results: boolean[] = [];
      for (let day = 0; day < 3; day += 1) results.push((await stopRenewals(seller, Date.now() + 60_000)).done);
      is("nothing is live to stop: on some day its renewals are said all stopped", results.includes(true), true);
      console.log(`  done on each of 3 days: ${results.join(", ")}; Stripe searches: ${searches}`);
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
