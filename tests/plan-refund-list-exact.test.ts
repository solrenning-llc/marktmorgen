/**
 * Rule 24 and rule 30 in the plan refund flow (lib/plan-refund-flow.ts, partsOutcome and findPlanRefund; Claude 3
 * F2-F4 and Codex G on #3190): a refund list, a row or a refund's status that does not read is unknown, never
 * "no refund was made", and a charge's list counts only that charge's refunds.
 *
 * What fails here:
 *   - a refund of ours whose status is missing, null or one Stripe does not give was simply not counted, so the
 *     charge read "none" (the daily job then takes the stop back and tells the creator nothing was refunded);
 *   - a list with no `data`, `data` that is not a list, a row that is not an object, or a row of ours with no id
 *     read as a whole empty list ("none"); so did a reply named another object (`"object": "invoice"`) or not
 *     named at all, with an empty `data` (Codex G, 6726655568);
 *   - the reply for one charge listing another charge's refund of ours counted it for both, so US$69.00 given back
 *     on one of two charges read "found", settled, US$138.00.
 * Healthy controls: an exact refund is still found; each of two charges refunded is found for both; another store's
 * refund or a failed one of ours is not counted; no refund at all, and an exact empty list, are still "none".
 * Nothing real is reached (tests/plan-refund-stripe-world.ts).
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ENDING_KEY, SETTLE_SECONDS, findPlanRefund, finishPlanRefunds, partsOutcome } from "@/lib/plan-refund-flow";
import { redisPipeline } from "@/lib/redis";
import { NOW, paidShop, world } from "./plan-refund-stripe-world";

type Row = Record<string, unknown>;
/** When set, a GET of the refunds list answers this body instead of the stand-in's. */
let reshape: ((url: URL) => unknown) | null = null;
const inner = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (reshape && (init?.method ?? "GET") === "GET" && url.pathname === "/v1/refunds") {
    const body = reshape(url);
    if (body !== undefined) return new Response(JSON.stringify(body), { status: 200 });
  }
  return inner(input, init);
}) as typeof fetch;

let k = 0;
/** One refund on the platform, as Stripe lists it, with `over` laid on top (an `undefined` field is left out). */
function refund(charge: string, sid: string, over: Row = {}): Row {
  k += 1;
  const row: Row = { id: `re_listx${k}x`, object: "refund", charge, payment_intent: `pi_${charge.slice(3)}`, amount: 6_900, currency: "usd", status: "succeeded", created: NOW, metadata: { plan_refund: sid } };
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
const one = (charge: string) => [{ c: charge, a: 6_900 }];

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";

  part("Controls: what reads is read as before");
  const ok = await shop();
  refund(ok.charge, ok.sid);
  const okFound = await partsOutcome(ok.sid, one(ok.charge));
  is("an exact refund of ours on the charge: found, settled, its amount", [okFound.kind, okFound.kind === "found" && okFound.settled, okFound.kind === "found" && okFound.refund.amount], ["found", true, 6_900]);
  is("the same refund found among the platform's", (await findPlanRefund(ok.sid, NOW - 60, NOW + 60)).kind, "found");
  const none = await shop();
  is("no refund on the charge: none", (await partsOutcome(none.sid, one(none.charge))).kind, "none");
  const other = await shop();
  refund(other.charge, "another-store");
  is("another store's refund on the charge: none", (await partsOutcome(other.sid, one(other.charge))).kind, "none");
  const failed = await shop();
  refund(failed.charge, failed.sid, { status: "failed" });
  is("a failed refund of ours: none", (await partsOutcome(failed.sid, one(failed.charge))).kind, "none");
  const canceled = await shop();
  refund(canceled.charge, canceled.sid, { status: "canceled" });
  is("a canceled refund of ours: none", (await partsOutcome(canceled.sid, one(canceled.charge))).kind, "none");
  const both = await shop();
  const both2 = both.addPayment(NOW - 3600);
  refund(both.charge, both.sid);
  refund(both2, both.sid);
  const bothFound = await partsOutcome(both.sid, [{ c: both.charge, a: 6_900 }, { c: both2, a: 6_900 }]);
  is("each of two charges refunded: found, US$138.00", [bothFound.kind, bothFound.kind === "found" && bothFound.refund.amount], ["found", 13_800]);

  part("Our refund on a charge, its status unreadable: unknown, never none");
  for (const [label, status] of [["missing", undefined], ["null", null], ["a word Stripe does not give", "processing"]] as const) {
    const s = await shop();
    refund(s.charge, s.sid, { status });
    is(`status ${label}: unknown`, (await partsOutcome(s.sid, one(s.charge))).kind, "unknown");
  }
  for (const [label, status] of [["null", null], ["a word Stripe does not give", "processing"]] as const) {
    const s = await shop();
    refund(s.charge, s.sid, { status });
    is(`among the platform's refunds, status ${label}: unknown`, (await findPlanRefund(s.sid, NOW - 60, NOW + 60)).kind, "unknown");
  }

  part("A list or a row in another shape: unknown, never an empty list");
  const shapes: [string, (url: URL) => unknown][] = [
    ["no data", () => ({ object: "list", has_more: false })],
    ["data that is not a list", () => ({ object: "list", data: {}, has_more: false })],
    ["a row that is not an object", () => ({ object: "list", data: [null], has_more: false })],
    ["another object's name (Codex G, 6726655568)", () => ({ object: "invoice", data: [], has_more: false })],
    ["no object name", () => ({ data: [], has_more: false })],
    ["an object name that is not a word", () => ({ object: 1, data: [], has_more: false })],
  ];
  for (const [label, body] of shapes) {
    const s = await shop();
    reshape = body;
    is(`a charge's refunds with ${label}: unknown`, (await partsOutcome(s.sid, one(s.charge))).kind, "unknown");
    is(`the platform's refunds with ${label}: unknown`, (await findPlanRefund(s.sid, NOW - 60, NOW + 60)).kind, "unknown");
    reshape = null;
  }
  const emptyList = await shop();
  reshape = () => ({ object: "list", data: [], has_more: false });
  is("control: a charge's refunds an exact empty list: none", (await partsOutcome(emptyList.sid, one(emptyList.charge))).kind, "none");
  is("control: the platform's refunds an exact empty list: none", (await findPlanRefund(emptyList.sid, NOW - 60, NOW + 60)).kind, "none");
  reshape = null;
  const noId = await shop();
  refund(noId.charge, noId.sid, { id: undefined });
  is("a refund of ours with no id on the charge: unknown", (await partsOutcome(noId.sid, one(noId.charge))).kind, "unknown");
  const noMeta = await shop();
  refund(noMeta.charge, noMeta.sid, { metadata: "plan_refund" });
  is("a refund on the charge whose metadata does not read: unknown", (await partsOutcome(noMeta.sid, one(noMeta.charge))).kind, "unknown");

  part("A charge's list counts only that charge's refunds (rule 30)");
  const pair = await shop();
  const second = pair.addPayment(NOW - 3600);
  const onSecond = refund(second, pair.sid);
  reshape = (url) => (url.searchParams.get("charge") === pair.charge ? { object: "list", data: [onSecond], has_more: false } : undefined);
  const crossed = await partsOutcome(pair.sid, [{ c: pair.charge, a: 6_900 }, { c: second, a: 6_900 }]);
  is("the first charge's reply lists the second charge's refund: unknown, never found US$138.00", [crossed.kind, crossed.kind === "found" && crossed.refund.amount], ["unknown", false]);
  reshape = null;

  part("The daily job: a refund of ours whose status does not read keeps the note and the stop");
  process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";
  const job = await shop();
  refund(job.charge, job.sid, { status: undefined });
  await redisPipeline([["HSET", ENDING_KEY, job.sid, JSON.stringify({ s: job.subId, at: NOW, t: NOW, m: 1, p: one(job.charge) })]]);
  world.subs.get(job.subId)!.cancel_at_period_end = true;
  world.emails = [];
  await finishPlanRefunds(Date.now() + 10_000, NOW + SETTLE_SECONDS + 60);
  is("no letter says the refund was not made", world.emails.filter((e) => /was not made|Nothing was refunded/.test(e.text)).length, 0);
  is("the stop not taken back, the note kept", [job.sub().cancel_at_period_end, (await job.note()) !== null], [true, true]);

  part("None was made, and our stop already ended the plan: never told it goes on (Claude 1 on #3190)");
  const gone = await shop();
  await redisPipeline([["HSET", ENDING_KEY, gone.sid, JSON.stringify({ s: gone.subId, at: NOW, t: NOW, m: 1, p: one(gone.charge) })]]);
  world.subs.get(gone.subId)!.cancel_at_period_end = true;
  world.subs.get(gone.subId)!.status = "canceled";
  world.emails = [];
  await finishPlanRefunds(Date.now() + 10_000, NOW + SETTLE_SECONDS + 60);
  const goneLetters = world.emails.filter((e) => /was not made/.test(e.text));
  is("one letter that the refund was not made", goneLetters.length, 1);
  is("it never says the plan goes on or renews", goneLetters.some((e) => /goes on as before|renews as usual/.test(e.text)), false);
  is("it says the plan ended and how to start it again", goneLetters.every((e) => /ended at the end of the period you paid for/.test(e.text) && /start a plan again/i.test(e.text)), true);
  is("the note goes", (await gone.note()) === null, true);

  part("Control: none was made and the plan is live: the stop is taken back and the plan goes on");
  const live = await shop();
  await redisPipeline([["HSET", ENDING_KEY, live.sid, JSON.stringify({ s: live.subId, at: NOW, t: NOW, m: 1, p: one(live.charge) })]]);
  world.subs.get(live.subId)!.cancel_at_period_end = true;
  world.emails = [];
  await finishPlanRefunds(Date.now() + 10_000, NOW + SETTLE_SECONDS + 60);
  is("the stop taken back", live.sub().cancel_at_period_end, false);
  is("the letter says the plan goes on", world.emails.filter((e) => /goes on as before/.test(e.text)).length, 1);
  delete process.env.RESEND_API_KEY;
  done();
}

void main();
