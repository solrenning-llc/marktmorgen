/**
 * Rule 24 in the plan refund flow (lib/plan-refund-flow.ts): a refund of ours whose amount or currency Stripe sent
 * in a shape that does not read is unknown, never a refund of US$0 and never "no refund was made".
 *
 * What fails here:
 *   - partsOutcome() reading our refund with an amount missing, a text, zero, fractional or negative as 0, so a
 *     charge given back reads "none" (the daily job then takes the stop back and tells the creator nothing was
 *     refunded) or "partial";
 *   - findPlanRefund() handing over our refund with an amount or currency that does not read, so the plan is ended
 *     and the confirmation letter says "We refunded $0.00" (or names US dollars it did not read).
 * Healthy controls: an exact refund is found with its cents and currency; a refund of another store
 * is not ours to count whatever its amount; one of ours that failed gave no money back whatever its amount reads,
 * so it is no refund (R1 on #3190); no refund at all is still "none".
 * Nothing real is reached (tests/plan-refund-stripe-world.ts).
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ENDING_KEY, GIVE_UP_DAYS, SETTLE_SECONDS, findPlanRefund, finishPlanRefunds, partsOutcome } from "@/lib/plan-refund-flow";
import { redisPipeline } from "@/lib/redis";
import { DAY, NOW, paidShop, world } from "./plan-refund-stripe-world";

type Row = Record<string, unknown>;
let k = 0;
/** One refund on the platform, as Stripe lists it, with `over` laid on top (an `undefined` field is left out). */
function refund(charge: string, sid: string, over: Row = {}): Row {
  k += 1;
  const row: Row = { id: `re_exact${k}x`, object: "refund", charge, payment_intent: `pi_${charge.slice(3)}`, amount: 6_900, currency: "usd", status: "succeeded", created: NOW, metadata: { plan_refund: sid } };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete row[key];
    else row[key] = value;
  }
  world.refunds.push(row);
  return row;
}
async function shop() {
  const s = await paidShop();
  const sid = (await s.store()).sid;
  const charge = String(world.charges[world.charges.length - 1].id);
  return { ...s, sid, charge };
}

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";

  part("Controls: what reads is read as before");
  const ok = await shop();
  refund(ok.charge, ok.sid);
  const okFound = await partsOutcome(ok.sid, [{ c: ok.charge, a: 6_900 }]);
  is("an exact refund of ours on the charge: found, settled, its whole amount", [okFound.kind, okFound.kind === "found" && okFound.settled, okFound.kind === "found" && okFound.refund.amount], ["found", true, 6_900]);
  const okListed = await findPlanRefund(ok.sid, NOW - 60, NOW + 60);
  is("the same refund found among the platform's refunds", [okListed.kind, okListed.kind === "found" && okListed.refund.amount, okListed.kind === "found" && okListed.refund.currency], ["found", 6_900, "usd"]);
  const none = await shop();
  is("no refund of ours on the charge: none", (await partsOutcome(none.sid, [{ c: none.charge, a: 6_900 }])).kind, "none");
  const other = await shop();
  refund(other.charge, "another-store", { amount: undefined });
  is("another store's refund on the charge, its amount unreadable: not ours to count, none", (await partsOutcome(other.sid, [{ c: other.charge, a: 6_900 }])).kind, "none");
  const failed = await shop();
  refund(failed.charge, failed.sid, { status: "failed", amount: undefined });
  // Its status read first: a refund that failed gave no money back, whatever its amount reads (R1 on #3190).
  is("our refund that failed, its amount unreadable: no money given, so none, never held as unknown", (await partsOutcome(failed.sid, [{ c: failed.charge, a: 6_900 }])).kind, "none");

  part("Our refund on a charge, its amount unreadable: unknown, never none or partial");
  for (const [label, amount] of [["missing", undefined], ["null", null], ["a text", "6900"], ["zero", 0], ["fractional", 6_900.5], ["negative", -6_900], ["not finite", Number.POSITIVE_INFINITY]] as const) {
    const s = await shop();
    refund(s.charge, s.sid, { amount });
    is(`amount ${label}: unknown`, (await partsOutcome(s.sid, [{ c: s.charge, a: 6_900 }])).kind, "unknown");
  }
  const pend = await shop();
  refund(pend.charge, pend.sid, { status: "pending", amount: undefined });
  is("a pending refund of ours, its amount unreadable: unknown", (await partsOutcome(pend.sid, [{ c: pend.charge, a: 6_900 }])).kind, "unknown");
  const two = await shop();
  refund(two.charge, two.sid, { amount: 3_000 });
  refund(two.charge, two.sid, { amount: "3900" });
  is("two refunds of ours, one amount unreadable: unknown, not partial", (await partsOutcome(two.sid, [{ c: two.charge, a: 6_900 }])).kind, "unknown");
  const cur = await shop();
  refund(cur.charge, cur.sid, { currency: undefined });
  is("our refund on a charge, its currency missing: unknown, never US dollars", (await partsOutcome(cur.sid, [{ c: cur.charge, a: 6_900 }])).kind, "unknown");

  part("Our refund among the platform's, its amount or currency unreadable: unknown, never $0");
  for (const [label, over] of [["amount missing", { amount: undefined }], ["amount a text", { amount: "6900" }], ["amount zero", { amount: 0 }], ["currency missing", { currency: undefined }], ["currency not a code", { currency: 840 }]] as const) {
    const s = await shop();
    refund(s.charge, s.sid, over);
    is(`${label}: unknown`, (await findPlanRefund(s.sid, NOW - 60, NOW + 60)).kind, "unknown");
  }

  part("The daily job: never a $0 letter, never \"nothing was refunded\" for money that went back");
  process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";
  const listed = await shop();
  refund(listed.charge, listed.sid, { amount: undefined });
  await redisPipeline([["HSET", ENDING_KEY, listed.sid, JSON.stringify({ s: listed.subId, at: NOW, t: NOW, m: 1 })]]);
  const charged = await shop();
  refund(charged.charge, charged.sid, { amount: undefined });
  await redisPipeline([["HSET", ENDING_KEY, charged.sid, JSON.stringify({ s: charged.subId, at: NOW, t: NOW, m: 1, p: [{ c: charged.charge, a: 6_900 }] })]]);
  world.subs.get(listed.subId)!.cancel_at_period_end = true;
  world.subs.get(charged.subId)!.cancel_at_period_end = true;
  world.emails = [];
  await finishPlanRefunds(Date.now() + 10_000, NOW + SETTLE_SECONDS + 60);
  is("no letter says a refund of $0", world.emails.filter((e) => /\$0\.00|\$0\b/.test(e.text)).length, 0);
  is("no letter says the refund was not made", world.emails.filter((e) => /We could not confirm the refund|was not made|Nothing was refunded/.test(e.text)).length, 0);
  is("found among the platform's refunds, amount unreadable: the plan not ended, the note and the stop kept", [listed.sub().status, listed.sub().cancel_at_period_end, (await listed.note()) !== null], ["active", true, true]);
  is("found on its charge, amount unreadable: the stop not taken back, the note kept", [charged.sub().status, charged.sub().cancel_at_period_end, (await charged.note()) !== null], ["active", true, true]);

  part(`Still unknown after ${GIVE_UP_DAYS} days: kept and logged, never "Nothing was refunded" (rule 24, finding F1)`);
  world.emails = [];
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  try {
    await finishPlanRefunds(Date.now() + 10_000, NOW + GIVE_UP_DAYS * DAY + 1);
  } finally {
    console.error = realError;
  }
  is("no letter at all: nothing unread is told as fact", world.emails.length, 0);
  is("on the platform's list: the note and the stop kept, the plan untouched", [listed.sub().status, listed.sub().cancel_at_period_end, (await listed.note()) !== null], ["active", true, true]);
  is("on its charge: the note and the stop kept, the plan untouched", [charged.sub().status, charged.sub().cancel_at_period_end, (await charged.note()) !== null], ["active", true, true]);
  is("each still-held case is said in the log, by store", [listed.sid, charged.sid].map((sid) => logged.some((line) => line.includes(sid) && line.includes("still held"))), [true, true]);
  delete process.env.RESEND_API_KEY;
  done();
}

void main();
