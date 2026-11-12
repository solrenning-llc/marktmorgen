/**
 * A closing's call budget is taken as set only on Redis's exact replies (CX-123 rule 24; Claude 2's Finding 1 on #3299).
 *
 * startCallBudget (lib/closing-holds.ts) sent DEL + HSET of a closing's budget of calls to the creator's Stripe
 * account and did not read the replies. closeOne (lib/plan-closing.ts) then wrote holdFrom, which means "the budget
 * is set", so the budget was never set again for that ending. When the HSET had not landed, every takeCalls ran
 * HINCRBY on an absent field, went negative, gave the calls back and answered false: holdOne answered "over", and
 * every member of the closing store was left past the budget, its charges never held after the plan ended (EC1).
 *
 * Now the budget is set by one script, once per ending (Codex S on #3309, tests/closing-call-budget-once.test.ts), and
 * its reply must be exactly 1 (set now) or 0 (set for this ending already). Any other shape (-1 for a key that is not a
 * hash, null, undefined, 2, text, a missing reply, an extra reply, a reply that is not a list) throws UnknownReplyError. closeOne lets it through, so holdFrom is not written, the daily job holds the
 * store ("failed"), and the next day sets the budget again.
 *
 * The healthy path is unchanged: the budget is set to the cap's calls, holdFrom is written, and each call takes from it.
 *
 * Synthetic data only: the in-memory Redis (tests/redis-stub.ts), with replies swapped per pipeline, and stand-ins
 * for Stripe and the email sender that answer nothing (no real service is reached).
 */
import { createHash } from "node:crypto";
import { STRIPE_CALLS_PER_MEMBER, buyerNoticeCap } from "@/lib/closing-buyers-rules";
import { FINAL_INDEX, startCallBudget, takeCalls, workKey } from "@/lib/closing-holds";
import { type Hands, closeEnded, closeOne } from "@/lib/plan-closing";
import { ENDED_INDEX } from "@/lib/plan-standing";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, setStripeAccount, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** What a matching pipeline answers instead: with `run`, the commands run first (the write landed, its reply was lost). */
type Rule = { when: (commands: (string | number)[][]) => boolean; reply: unknown; run: boolean };
let rule: Rule | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (rule && rule.when(commands)) {
    if (rule.reply === "throw") throw new Error("the database did not answer");
    if (rule.run) await pipeline(commands);
    return rule.reply as unknown[];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

// Stripe and the email sender: nothing is reached, every call is refused.
globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 })) as typeof fetch;

/** The pipeline startCallBudget sends: the once-per-ending script on the closing's work hash. */
const budgetSet = (commands: (string | number)[][]) =>
  commands.length === 1 && commands[0]?.[0] === "EVAL" && String(commands[0]?.[1]).startsWith("-- marktmorgen:closing-call-budget:v1\n") && String(commands[0]?.[3]).startsWith("nl:closing:work:");

/** Replies the script must never be read as done from. */
const BAD_REPLIES: [string, unknown][] = [
  ["the script answered null", [null]],
  ["the script answered undefined", [undefined]],
  ["the script answered -1 (not a hash)", [-1]],
  ["the script answered 2", [2]],
  ["the script answered \"OK\"", ["OK"]],
  ["the script answered \"1\"", ["1"]],
  ["the script answered true", [true]],
  ["the script answered an object", [{ result: 1 }]],
  ["no reply at all", []],
  ["an extra, unasked-for reply", [1, 1]],
  ["a reply that is not a list", { result: [1] }],
];
const ENDING = Date.UTC(2026, 10, 1, 12);

/** "UnknownReplyError" or "rejected" when the promise rejects, otherwise what it resolved to. */
async function outcome<T>(run: () => Promise<T>): Promise<T | "UnknownReplyError" | "rejected"> {
  try {
    return await run();
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : "rejected";
  }
}

async function calls(folder: string): Promise<unknown> {
  const [left] = await redis.pipeline([["HGET", workKey(folder), "calls"]]);
  return left;
}

const stateKey = (key: string) => `nl:plan:closing:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
async function stateOf(key: string): Promise<Record<string, unknown>> {
  const [raw] = await redis.pipeline([["GET", stateKey(key)]]);
  return typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

const DAY = 86_400_000;
const hands: Hands = { measure: async () => 0, list: async () => [], remove: async () => {} };
const realNow = Date.now.bind(Date);

let made = 0;
/** A store on a paid plan that has just ended, connected to its own Stripe account. */
async function endedStore(handle: string): Promise<{ email: string; folder: string; endedAt: number; cap: number }> {
  made += 1;
  const email = `${handle}@example.com`;
  await claimHandle(email, handle, `${handle[0].toUpperCase()}${handle.slice(1)} Shop`, "");
  await setSubscription(email, { customerId: `cus_${handle}0001`, subscriptionId: `sub_${handle}plan01`, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  await setStripeAccount(email, `acct_1Cbk${String(made).padStart(12, "0")}`, true);
  await setSubscription(email, { active: false });
  const store = (await storeForEmail(email))!;
  const folder = await storeFolder(storeRef(store));
  return { email, folder, endedAt: Date.parse(store.planEndedAt), cap: buyerNoticeCap(store.tier, true) };
}

async function main(): Promise<void> {
  redis.clear();

  part("startCallBudget: the budget is set only on the script's exact 1 or 0");
  for (const [label, reply] of BAD_REPLIES) {
    for (const run of [false, true]) {
      const folder = `cb-shape-${run ? "landed" : "lost"}`;
      await redis.pipeline([["DEL", workKey(folder)]]);
      rule = { when: budgetSet, reply, run };
      is(`startCallBudget, ${label} (${run ? "the write landed" : "the write did not land"}): refused as unknown`, await outcome(() => startCallBudget(folder, 10, ENDING)), "UnknownReplyError");
      rule = null;
    }
  }
  rule = { when: budgetSet, reply: "throw", run: false };
  is("startCallBudget, a Redis that cannot be asked: refused, as before", await outcome(() => startCallBudget("cb-down", 10, ENDING)), "rejected");
  rule = null;

  part("startCallBudget: the healthy path is unchanged");
  is("startCallBudget, no earlier budget: resolves", await outcome(() => startCallBudget("cb-real", 4, ENDING)), undefined);
  is("startCallBudget, no earlier budget: the budget is the calls asked for", await calls("cb-real"), "4");
  is("startCallBudget: each call takes from it, all or none", [await takeCalls("cb-real", 2), await takeCalls("cb-real", 3), await takeCalls("cb-real", 2)], [true, false, true]);
  await redis.pipeline([["HSET", workKey("cb-real"), "f:sub_old", "1"]]);
  is("startCallBudget, an earlier ending's work there: resolves", await outcome(() => startCallBudget("cb-real", 6, ENDING + DAY)), undefined);
  is("startCallBudget, an earlier ending's work there: the budget starts again", await calls("cb-real"), "6");
  const [old] = await redis.pipeline([["HGET", workKey("cb-real"), "f:sub_old"]]);
  is("startCallBudget, an earlier ending's work there: cleared, as before", old, null);
  is("startCallBudget, 0 calls: resolves", await outcome(() => startCallBudget("cb-zero", 0, ENDING)), undefined);
  is("startCallBudget, 0 calls: the budget is 0, never absent", await calls("cb-zero"), "0");
  is("startCallBudget, a fraction or a negative: floored at 0, as before", [await outcome(() => startCallBudget("cb-neg", -3.5, ENDING)), await calls("cb-neg")], [undefined, "0"]);
  is("takeCalls, a budget of 0: refused", await takeCalls("cb-zero", 1), false);

  part("closeOne: holdFrom is never written on a budget that was not set");
  {
    const { email, folder, endedAt, cap } = await endedStore("cbone");
    const at = endedAt + 60_000;
    Date.now = () => at;
    rule = { when: budgetSet, reply: [null], run: false };
    is("closeOne, the script answered null: the day fails as unknown", await outcome(() => closeOne(email, at, hands, Number.POSITIVE_INFINITY)), "UnknownReplyError");
    rule = null;
    is("closeOne, the script answered null: holdFrom is not written", (await stateOf(email)).holdFrom, undefined);
    is("closeOne, the script answered null: the budget is not there", await calls(folder), null);

    const next = at + DAY;
    Date.now = () => next;
    await outcome(() => closeOne(email, next, hands, Number.POSITIVE_INFINITY));
    is("closeOne, the next day: holdFrom is written then", (await stateOf(email)).holdFrom, next);
    // The budget is set to the cap's calls; the member walk that follows takes nothing (Stripe lists no member here).
    is("closeOne, the next day: the budget is set to the cap's calls", await calls(folder), String(cap * STRIPE_CALLS_PER_MEMBER));
    is("closeOne, the next day: a member's calls take from the budget", await takeCalls(folder, STRIPE_CALLS_PER_MEMBER), true);
    Date.now = realNow;
  }

  part("closeEnded: the daily job holds the store and tries again");
  {
    const { email, folder, endedAt, cap } = await endedStore("cbdaily");
    const at = endedAt + 60_000;
    Date.now = () => at;
    // This journey only: other stores in the stand-in queue are set aside while it runs.
    const hidden: [string, string, string][] = [];
    for (const index of [ENDED_INDEX, FINAL_INDEX]) {
      const [flat] = await redis.pipeline([["ZRANGEBYSCORE", index, "-inf", "+inf", "WITHSCORES"]]);
      const rows = Array.isArray(flat) ? flat : [];
      for (let i = 0; i + 1 < rows.length; i += 2) if (rows[i] !== email) hidden.push([index, String(rows[i]), String(rows[i + 1])]);
    }
    for (const [index, ref] of hidden) await redis.pipeline([["ZREM", index, ref]]);
    try {
      rule = { when: budgetSet, reply: ["1"], run: true };
      const row = (await closeEnded(Number.POSITIVE_INFINITY, at, hands)).find((r) => r.key === email);
      rule = null;
      is("closeEnded, the script answered \"1\" (the write landed): the store is held as failed", row && { state: row.state, note: row.note }, { state: "held", note: "failed" });
      is("closeEnded, the script answered \"1\": holdFrom is not written", (await stateOf(email)).holdFrom, undefined);

      const next = at + DAY;
      Date.now = () => next;
      await closeEnded(Number.POSITIVE_INFINITY, next, hands);
      is("closeEnded, the next day: holdFrom is written then", (await stateOf(email)).holdFrom, next);
      is("closeEnded, the next day: the budget is set to the cap's calls", await calls(folder), String(cap * STRIPE_CALLS_PER_MEMBER));
    } finally {
      rule = null;
      Date.now = realNow;
      for (const [index, ref, score] of hidden) await redis.pipeline([["ZADD", index, score, ref]]);
    }
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
