/**
 * A closing's email credit is set only on Redis's exact "OK" (CX-123 rule 24; audit R24 round 8, item 1).
 *
 * startClosingCredit (lib/closing-credit.ts) sent the SET of a closing's email credit and did not read the reply.
 * closeOne (lib/plan-closing.ts) then wrote holdFrom, which means "the credit is set", so the credit was never set
 * again. When the SET had not landed, the key stayed absent: every takeCredit before a buyer's email ran DECRBY on
 * nothing, went negative and was refused, every buyer was marked "could not be told", and the store closed with no
 * buyer told how to download what they bought, that memberships are held, or what is given back.
 *
 * Now the SET's one reply must be exactly "OK". Any other shape (a missing reply, a number, text other than "OK",
 * null, an object, a second reply, a reply that is not a list) throws UnknownReplyError. closeOne lets it through,
 * so holdFrom is not written, the daily job holds the store ("failed"), and the next day sets the credit again.
 *
 * The healthy path is unchanged: the credit is set to the cap, holdFrom is written, and each email takes from it.
 *
 * Synthetic data only: the in-memory Redis (tests/redis-stub.ts), with replies swapped per command, and stand-ins
 * for Stripe and the email sender that answer nothing (no real service is reached).
 */
import { createHash } from "node:crypto";
import { creditKey, startClosingCredit, takeCredit } from "@/lib/closing-credit";
import { EMAILS_PER_BUYER_PER_ENDING, buyerNoticeCap } from "@/lib/closing-buyers-rules";
import { type Hands, closeEnded, closeOne } from "@/lib/plan-closing";
import { ENDED_INDEX } from "@/lib/plan-standing";
import { FINAL_INDEX } from "@/lib/closing-holds";
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

const creditSet = (commands: (string | number)[][]) => commands[0]?.[0] === "SET" && String(commands[0]?.[1]).startsWith("nl:closing:credit:");

/** Replies a SET must never be read as done from. */
const BAD_REPLIES: [string, unknown][] = [
  ["an empty reply", []],
  ["a reply of undefined", [undefined]],
  ["a reply of null", [null]],
  ["a reply of 1", [1]],
  ["a reply of \"1\"", ["1"]],
  ["a reply of \"ok\"", ["ok"]],
  ["a reply of true", [true]],
  ["a reply that is an object", [{ result: "OK" }]],
  ["a reply that is a list", [["OK"]]],
  ["a second, unasked-for reply", ["OK", "OK"]],
  ["a reply that is not a list", { result: "OK" }],
];

/** "UnknownReplyError" or "rejected" when the promise rejects, otherwise what it resolved to. */
async function outcome<T>(run: () => Promise<T>): Promise<T | "UnknownReplyError" | "rejected"> {
  try {
    return await run();
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : "rejected";
  }
}

async function credit(folder: string): Promise<unknown> {
  const [left] = await redis.pipeline([["GET", creditKey(folder)]]);
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
  await setStripeAccount(email, `acct_1Ack${String(made).padStart(12, "0")}`, true);
  await setSubscription(email, { active: false });
  const store = (await storeForEmail(email))!;
  const folder = await storeFolder(storeRef(store));
  return { email, folder, endedAt: Date.parse(store.planEndedAt), cap: buyerNoticeCap(store.tier, true) };
}

async function main(): Promise<void> {
  redis.clear();

  part("startClosingCredit: the credit is set only on SET's exact \"OK\"");
  for (const [label, reply] of BAD_REPLIES) {
    for (const run of [false, true]) {
      const folder = `ack-shape-${run ? "landed" : "lost"}`;
      await redis.pipeline([["DEL", creditKey(folder)]]);
      rule = { when: creditSet, reply, run };
      is(`startClosingCredit, ${label} (${run ? "the write landed" : "the write did not land"}): refused as unknown`, await outcome(() => startClosingCredit(folder, 10)), "UnknownReplyError");
      rule = null;
    }
  }
  rule = { when: creditSet, reply: "throw", run: false };
  is("startClosingCredit, a Redis that cannot be asked: refused, as before", await outcome(() => startClosingCredit("ack-down", 10)), "rejected");
  rule = null;

  part("startClosingCredit: the healthy path is unchanged");
  is("startClosingCredit, \"OK\": resolves", await outcome(() => startClosingCredit("ack-real", 4)), undefined);
  is("startClosingCredit, \"OK\": the credit is the emails asked for", await credit("ack-real"), "4");
  is("startClosingCredit, \"OK\": each email takes from it", [await takeCredit("ack-real", 2), await takeCredit("ack-real", 2), await takeCredit("ack-real", 1)], [true, true, false]);
  is("startClosingCredit, 0 emails: resolves", await outcome(() => startClosingCredit("ack-zero", 0)), undefined);
  is("startClosingCredit, 0 emails: the credit is 0, never absent", await credit("ack-zero"), "0");
  is("startClosingCredit, a fraction or a negative: floored at 0, as before", [await outcome(() => startClosingCredit("ack-neg", -3)), await credit("ack-neg")], [undefined, "0"]);
  is("startClosingCredit, no folder: nothing is written, as before", [await outcome(() => startClosingCredit("", 5)), await credit("")], [undefined, null]);

  part("closeOne: holdFrom is never written on a credit that was not set");
  {
    const { email, folder, endedAt, cap } = await endedStore("ackone");
    const at = endedAt + 60_000;
    Date.now = () => at;
    rule = { when: creditSet, reply: [], run: false };
    is("closeOne, SET answered with nothing: the day fails as unknown", await outcome(() => closeOne(email, at, hands, Number.POSITIVE_INFINITY)), "UnknownReplyError");
    rule = null;
    is("closeOne, SET answered with nothing: holdFrom is not written", (await stateOf(email)).holdFrom, undefined);
    is("closeOne, SET answered with nothing: the credit is not there", await credit(folder), null);

    const next = at + DAY;
    Date.now = () => next;
    await outcome(() => closeOne(email, next, hands, Number.POSITIVE_INFINITY));
    is("closeOne, the next day: the credit is set to the cap", await credit(folder), String(cap * EMAILS_PER_BUYER_PER_ENDING));
    is("closeOne, the next day: holdFrom is written then", (await stateOf(email)).holdFrom, next);
    is("closeOne, the next day: a buyer's email takes from the credit", await takeCredit(folder, EMAILS_PER_BUYER_PER_ENDING), true);
    Date.now = realNow;
  }

  part("closeEnded: the daily job holds the store and tries again");
  {
    const { email, folder, endedAt, cap } = await endedStore("ackdaily");
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
      rule = { when: creditSet, reply: ["1"], run: true };
      const row = (await closeEnded(Number.POSITIVE_INFINITY, at, hands)).find((r) => r.key === email);
      rule = null;
      is("closeEnded, SET answered \"1\" (the write landed): the store is held as failed", row && { state: row.state, note: row.note }, { state: "held", note: "failed" });
      is("closeEnded, SET answered \"1\": holdFrom is not written", (await stateOf(email)).holdFrom, undefined);

      const next = at + DAY;
      Date.now = () => next;
      await closeEnded(Number.POSITIVE_INFINITY, next, hands);
      is("closeEnded, the next day: the credit is set to the cap", await credit(folder), String(cap * EMAILS_PER_BUYER_PER_ENDING));
      is("closeEnded, the next day: holdFrom is written then", (await stateOf(email)).holdFrom, next);
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
