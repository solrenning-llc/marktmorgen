/**
 * Whether a store is in its closing day, read only in its exact shape
 * (CX-123 rule 24; found in the review of #3279).
 *
 * lib/closing-plan-guard.ts (closingSince) read a final-line score that was
 * missing or not a number as null, "not closing", and its address mark
 * (shutOf) the same; lib/closing-holds.ts (inClosingDay) read a missing reply
 * as false. So an unknown reply let the way back from a checkout
 * (app/api/billing/return), the daily sync (lib/billing-sync.ts) and the
 * closing job (lib/plan-closing.ts) take a plan paid for a store already in
 * its closing day as one to write down: paid for, and never given.
 *
 * Now: null is "not in the line" (or "not marked"); a positive score, as
 * Redis writes it, is the day the plan ended; anything else (a missing or an
 * extra reply, text that is not a number, zero or below, a list, an object)
 * throws UnknownReplyError. Its callers already refuse on a throw: the way
 * back says billing=unconfirmed and writes no plan, the checkout says
 * billing=closing and asks Stripe nothing, the sync and the job keep the
 * subscription for their next run. Synthetic data only; nothing real is
 * reached.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { signedIn } from "./closing-route-studio";
import { GET as back } from "@/app/api/billing/return/route";
import { POST as checkout } from "@/app/api/billing/checkout/route";
import { claimHandle, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { FINAL_INDEX, inClosingDay } from "@/lib/closing-holds";
import { UNDO_KEY, closingSince, markShut, refusePlanIfClosing, shutOf } from "@/lib/closing-plan-guard";
import { redisPipeline } from "@/lib/redis";

const DAY = 86_400_000;
type Commands = (string | number)[][];
const pipe = redis.pipeline.bind(redis);
const restore = () => { redis.pipeline = pipe as typeof redis.pipeline; };
/** The pipeline as it is, but each command `pick` names answers `reply`. */
const answers = (pick: (command: (string | number)[]) => boolean, reply: unknown) => {
  redis.pipeline = (async (commands: Commands) => {
    const replies = await pipe(commands);
    return replies.map((r, i) => (pick(commands[i]) ? reply : r));
  }) as typeof redis.pipeline;
};
/** The pipeline as it is, but a call holding a command `pick` names answers with `count` replies (cut short, or one too many). */
const counted = (pick: (command: (string | number)[]) => boolean, count: number) => {
  redis.pipeline = (async (commands: Commands) => {
    const replies = await pipe(commands);
    if (!commands.some(pick)) return replies;
    return count < replies.length ? replies.slice(0, count) : [...replies, ...Array.from({ length: count - replies.length }, () => "1")];
  }) as typeof redis.pipeline;
};
const zscore = (command: (string | number)[]) => command[0] === "ZSCORE" && command[1] === FINAL_INDEX;
const shutKey = (handle: string) => `nl:closing:shut:${createHash("sha256").update(handle.toLowerCase()).digest("hex").slice(0, 32)}`;
const getOf = (key: string) => (command: (string | number)[]) => command[0] === "GET" && command[1] === key;
/** "unknown" for UnknownReplyError, else what the read answered. */
const outcome = (run: Promise<unknown>) => run.then((v) => v, (error: unknown) => (error instanceof Error && error.name === "UnknownReplyError" ? "unknown" : `threw ${String(error)}`));

/** Replies to the final line's ZSCORE that are not in its exact shape: none is "not closing". */
const UNKNOWN_SCORES: [string, unknown][] = [
  ["a missing reply (undefined)", undefined],
  ["empty text", ""],
  ["text that is not a number", "soon"],
  ["NaN's text", "NaN"],
  ["Infinity's text", "Infinity"],
  ["a number with spaces", " 1730000000000"],
  ["zero", "0"],
  ["a score below zero", "-1730000000000"],
  ["the number NaN", Number.NaN],
  ["the number 0", 0],
  ["true", true],
  ["a list", ["1730000000000"]],
  ["an object", { score: 1_730_000_000_000 }],
];
/** Replies to the address mark's GET that are not in its exact shape: none is "not marked". */
const UNKNOWN_MARKS: [string, unknown][] = [
  ["a missing reply (undefined)", undefined],
  ["a number, not its text", 1_730_000_000_000],
  ["text that is not a mark", "soon"],
  ["no end after the bar", "1730000000000|"],
  ["no bar", "1730000000000"],
  ["no start", "|1730000000000"],
  ["a start of zero", "0|0"],
  ["a start below zero", "-5|0"],
  ["an end that is not a number", "1730000000000|later"],
  ["an object", { since: 1_730_000_000_000 }],
];

let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.stripe.com") stripeCalls += 1;
  return new Response(JSON.stringify({ error: { message: "not in this stand-in" } }), { status: 404, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const billingOf = (response: Response) => new URL(response.headers.get("Location") ?? "https://x.test/").searchParams.get("billing");

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  const email = "exact-day@example.test";
  await claimHandle(email, "exactday", "Exact Day Shop", "");
  await setSubscription(email, { customerId: "cus_exactday0001", subscriptionId: "sub_exactdayold01", active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  await setSubscription(email, { active: false });
  const shop = (await storeForEmail(email))!;
  const ref = storeRef(shop);
  const now = Date.now();
  const ended = now - 30 * DAY;

  part("Controls: the line and the mark as they are kept");
  is("not in the line: not closing", [await outcome(inClosingDay(ref)), await outcome(closingSince(shop))], [false, null]);
  await redisPipeline([["ZADD", FINAL_INDEX, ended, ref]]);
  is("in the line, not marked: closing since the plan's end", [await outcome(inClosingDay(ref)), await outcome(closingSince(shop))], [true, { since: ended, ended }]);
  await markShut(shop, now, ended);
  is("in the line and marked: closing since the mark", await outcome(closingSince(shop)), { since: now, ended });
  is("the mark read back", await outcome(shutOf("exactday")), { since: now, ended });
  answers(zscore, String(ended));
  is("a score as its text reads", await outcome(closingSince(shop)), { since: now, ended });
  answers(zscore, ended);
  is("a score as a number reads", await outcome(closingSince(shop)), { since: now, ended });
  answers(zscore, "1.5e+12");
  is("a score in Redis's exponent form reads", [await outcome(inClosingDay(ref)), (await outcome(closingSince(shop)) as { ended: number }).ended], [true, 1.5e12]);
  answers(zscore, null);
  is("null is not in the line", [await outcome(inClosingDay(ref)), await outcome(closingSince(shop))], [false, null]);
  restore();
  answers(getOf(shutKey("exactday")), `${now}|0`);
  is("a mark with no plan end read", await outcome(shutOf("exactday")), { since: now, ended: 0 });
  answers(getOf(shutKey("exactday")), null);
  is("no mark: not marked", await outcome(shutOf("exactday")), null);
  restore();

  for (const [name, reply] of UNKNOWN_SCORES) {
    part(`The final line's score is ${name}`);
    answers(zscore, reply);
    // Was false/null for a missing reply, and null for every non-number: a plan adopted on a closing day.
    is("inClosingDay: unknown, never not closing", await outcome(inClosingDay(ref)), "unknown");
    is("closingSince: unknown, never not closing", await outcome(closingSince(shop)), "unknown");
    restore();
  }
  for (const [name, count] of [["cut short (no reply)", 0], ["one reply too many", 2]] as const) {
    part(`The final line's pipeline is ${name}`);
    counted(zscore, count);
    is("inClosingDay: unknown", await outcome(inClosingDay(ref)), "unknown");
    is("closingSince: unknown", await outcome(closingSince(shop)), "unknown");
    restore();
  }
  for (const [name, reply] of UNKNOWN_MARKS) {
    part(`The address mark is ${name}`);
    answers(getOf(shutKey("exactday")), reply);
    // Was null ("not marked"): a store already removed then took a late plan as its own.
    is("shutOf: unknown, never not marked", await outcome(shutOf("exactday")), "unknown");
    is("closingSince: unknown, never the plan's end in its place", await outcome(closingSince(shop)), "unknown");
    restore();
  }

  part("A plan that comes to light on an unknown reply is never let through");
  answers(zscore, undefined);
  const late = await outcome(refusePlanIfClosing({ store: shop, handle: "exactday", subscriptionId: "sub_exactdaylate1", customerId: "cus_exactday0001" }));
  is("for a store: unknown, never \"no\" (the caller writes no plan)", late, "unknown");
  restore();
  answers(getOf(shutKey("gonestore")), "soon");
  is("for a store already removed: unknown, never \"no\"", await outcome(refusePlanIfClosing({ store: null, handle: "gonestore", subscriptionId: "sub_exactdaygone1", customerId: "" })), "unknown");
  restore();
  is("nothing was put in line on it, and Stripe was not asked", [(await redisPipeline([["HLEN", UNDO_KEY]]))[0], stripeCalls], [0, 0]);

  part("The routes, on an unknown reply");
  signedIn.email = email;
  const before = (await storeForEmail(email))!;
  answers(zscore, undefined);
  const returned = await back(new NextRequest("https://marktmorgen.test/api/billing/return?session_id=cs_test_exactdaylate01"));
  // Was billing=unfinished: the way back asked Stripe for the session to adopt it.
  is("the way back says it could not confirm, and asks Stripe nothing", [billingOf(returned), stripeCalls], ["unconfirmed", 0]);
  const after = (await storeForEmail(email))!;
  is("no plan written down", [after.subscriptionId, after.subscriptionActive], [before.subscriptionId, before.subscriptionActive]);
  // Was a checkout asked of Stripe: the missing reply read as not closing.
  is("a new plan checkout is refused, and Stripe is not asked", [billingOf(await checkout(new NextRequest("https://marktmorgen.test/api/billing/checkout", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://marktmorgen.test" }, body: new URLSearchParams({ tier: "creator", cycle: "month" }) }))), stripeCalls], ["closing", 0]);
  restore();

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
