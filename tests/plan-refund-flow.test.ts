/**
 * A plan refund from start to finish (305 [SY1] unit 2b1,
 * lib/plan-refund-flow.ts) against a stand-in Stripe that keeps idempotency
 * keys, as Stripe does. Nothing real is reached.
 *
 * What fails here:
 *   - the order: the plan not set to stop before the money goes back, or not
 *     ended after it;
 *   - a refund without the plan ended, its open invoice left payable or its
 *     draft left to be charged, or the store still written down as paid;
 *   - a refused or failed refund that costs the creator their plan (the stop
 *     left behind), or a stop the creator set themselves taken back;
 *   - a second refund from a second click, two requests at once or a retry;
 *   - a refund whose answer was lost, or a plan whose ending failed, never
 *     finished by the daily job; a note never dropped;
 *   - the daily job finishing a store a request is finishing now.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ENDING_KEY, GIVE_UP_DAYS, SETTLE_SECONDS, finishPlanRefunds, flowKeyOf, refundAndEndPlan } from "@/lib/plan-refund-flow";
import { redisPipeline } from "@/lib/redis";
import { DAY, NOW, n, paidShop, setAssistantPlan, world } from "./plan-refund-stripe-world";

/** How many charges a kept note names. */
const notedCharges = (raw: unknown) => (typeof raw === "string" ? ((JSON.parse(raw) as { p?: unknown[] }).p?.length ?? 0) : 0);
const order = (subId: string) => world.calls.filter((c) => c.includes(subId) || c === "POST /refunds").map((c) => c.replace(`/${subId}`, "/:sub"));

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";

  part("Refunded and ended, in the safe order");
  const a = await paidShop();
  world.calls = [];
  const first = await refundAndEndPlan(await a.store(), NOW);
  is("the first payment comes back and the plan is ended", first, { ok: true, cents: 6_900, currency: "usd", refundId: "re_made1x", status: "succeeded", ended: true, earlier: false });
  const steps = order(a.subId);
  const stop = steps.indexOf("POST /subscriptions/:sub"), refund = steps.indexOf("POST /refunds"), end = steps.indexOf("DELETE /subscriptions/:sub");
  is("set to stop, then refunded, then ended", stop >= 0 && stop < refund && refund < end, true);
  is("ended at Stripe", a.sub().status, "canceled");
  is("its open invoice voided, its draft deleted", a.invoices(), [`in_flow${n}open:void`]);
  const after = await a.store();
  is("the store has no plan any more (the closing rules start)", [after.subscriptionActive, after.planEndedAt !== ""], [false, true]);
  is("no note left", await a.note(), null);
  is("no lock left", (await redisPipeline([["GET", flowKeyOf(after.sid)]]))[0], null);

  part("Never twice");
  const again = await refundAndEndPlan(await a.store(), NOW);
  is("a second click: the earlier refund is reported, nothing new", [again.ok && again.earlier, again.ok && again.refundId, a.refunds().length], [true, "re_made1x", 1]);
  const b = await paidShop();
  world.slow = 5;
  const both = await Promise.all([refundAndEndPlan(await b.store(), NOW), refundAndEndPlan(await b.store(), NOW)]);
  world.slow = 0;
  is("two at once: one made, the other told to wait", both.map((r) => (r.ok ? "made" : r.reason)).sort(), ["busy", "made"]);
  is("one refund at Stripe", b.refunds().length, 1);

  part("Not owed: the plan goes on as it was");
  const late = await paidShop({ at: NOW - 40 * DAY });
  const refused = await refundAndEndPlan(await late.store(), NOW);
  is("outside the 30 days: refused, nothing changed", [refused, late.refunds().length], [{ ok: false, reason: "not_owed", stopLeft: false }, 0]);
  is("the stop set for it is taken back", [late.sub().status, late.sub().cancel_at_period_end], ["active", false]);
  is("still paid, invoices untouched, no note", [(await late.store()).subscriptionActive, late.invoices(), await late.note()], [true, [`in_flow${n}open:open`, `in_flow${n}draft:draft`], null]);
  const own = await paidShop({ at: NOW - 40 * DAY, stopSet: true });
  await refundAndEndPlan(await own.store(), NOW);
  is("a stop the creator had set is left as it was", own.sub().cancel_at_period_end, true);

  part("Failures on the way");
  const s = await paidShop();
  world.stopDown = true;
  is("the stop cannot be set: nothing refunded", [await refundAndEndPlan(await s.store(), NOW), s.refunds().length], [{ ok: false, reason: "stop_failed", stopLeft: false }, 0]);
  world.stopDown = false;
  is("and no note left", await s.note(), null);

  const d = await paidShop();
  world.refundsDown = true;
  const down = await refundAndEndPlan(await d.store(), NOW);
  world.refundsDown = false;
  is("Stripe failing at the refund: failed, and the stop KEPT while a refund may still turn up (no renewal meanwhile)", [down, d.sub().cancel_at_period_end, d.refunds().length], [{ ok: false, reason: "failed", stopLeft: true }, true, 0]);
  is("the note stays for the daily job", JSON.parse(String(await d.note())).m, 1);
  is("the daily job before SETTLE_SECONDS: left, stop still set", [(await finishPlanRefunds(Date.now() + 10_000, NOW + 60)).left >= 1, d.sub().cancel_at_period_end], [true, true]);
  process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";
  world.emails = [];
  is("after it, none found: the stop taken back, the note dropped, the plan untouched", [await (async () => { await finishPlanRefunds(Date.now() + 10_000, NOW + SETTLE_SECONDS + 1); return d.note(); })(), d.sub().status, d.sub().cancel_at_period_end], [null, "active", false]);

  is("and the creator is told by email that nothing was refunded and the plan goes on", world.emails.map((e) => [e.subject.endsWith("your refund was not made"), e.text.includes("Nothing was refunded and your plan goes on as before.")]), [[true, true]]);
  delete process.env.RESEND_API_KEY;
  const t = await paidShop();
  world.loseAnswer = true;
  world.listDown = true;
  const timeout = await refundAndEndPlan(await t.store(), NOW);
  world.loseAnswer = false;
  world.listDown = false;
  is("made at Stripe but the answer lost: found on its own charge (noted before the write), the plan ended", [timeout.ok, t.sub().status, t.refunds().length, await t.note()], [true, "canceled", 1, null]);

  // The answer lost AND the charge's refunds unreadable right after: the stop stays until the daily job sees it.
  const t2 = await paidShop();
  world.loseAnswer = true;
  const realFetch = globalThis.fetch;
  let posted = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (init?.method === "POST" && url.endsWith("/v1/refunds")) posted = true;
    if (posted && url.includes("/v1/refunds?")) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
    return realFetch(input, init);
  }) as typeof fetch;
  const blind = await refundAndEndPlan(await t2.store(), NOW);
  globalThis.fetch = realFetch;
  world.loseAnswer = false;
  is("made, the answer lost and nothing readable after: the stop stays, the note too", [blind.ok, t2.sub().status, t2.sub().cancel_at_period_end, (await t2.note()) !== null], [false, "active", true, true]);
  await finishPlanRefunds(Date.now() + 10_000, NOW + 3_600);
  is("the daily job finds it on the charge and ends the plan; nothing renewed in between", [t2.sub().status, await t2.note()], ["canceled", null]);

  const p = await paidShop();
  world.refundStatus = "pending";
  const pending = await refundAndEndPlan(await p.store(), NOW);
  is("a pending refund: said so, the plan not ended on it, the stop and the note kept", [pending.ok && pending.status, pending.ok && pending.ended, p.sub().status, p.sub().cancel_at_period_end, (await p.note()) !== null], ["pending", false, "active", true, true]);
  await finishPlanRefunds(Date.now() + 10_000, NOW + 3_600);
  is("still pending at the daily job: left as it is", [p.sub().status, (await p.note()) !== null], ["active", true]);
  p.refunds()[0].status = "succeeded";
  world.refundStatus = "succeeded";
  await finishPlanRefunds(Date.now() + 10_000, NOW + 7_200);
  is("succeeded: the daily job ends the plan", [p.sub().status, await p.note()], ["canceled", null]);

  const lost = await paidShop();
  world.loseAnswer = true;
  const lostAnswer = await refundAndEndPlan(await lost.store(), NOW);
  world.loseAnswer = false;
  is("the answer lost after Stripe made it: found by its metadata, the plan ended", [lostAnswer.ok && lostAnswer.refundId, lost.sub().status, lost.refunds().length, await lost.note()], [lost.refunds()[0]?.id, "canceled", 1, null]);

  const e = await paidShop();
  world.endDown = true;
  const notEnded = await refundAndEndPlan(await e.store(), NOW);
  world.endDown = false;
  is("refunded but not ended yet: said so, the stop and the note stay", [notEnded.ok && notEnded.ended, e.sub().cancel_at_period_end, (await e.store()).subscriptionActive, (await e.note()) !== null], [false, true, true, true]);
  const run = await finishPlanRefunds(Date.now() + 10_000, NOW + 60);
  is("the daily job ends it, once, and drops the note", [run.ended >= 1, e.sub().status, (await e.store()).subscriptionActive, await e.note(), e.refunds().length], [true, "canceled", false, null, 1]);

  part("Every plan payment inside the guarantee's days (owner, 31/10/2026 15h41)");
  const feb = await paidShop({ at: NOW - 29 * DAY });
  feb.addPayment(NOW - DAY);
  process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";
  world.emails = [];
  const twice = await refundAndEndPlan(await feb.store(), NOW);
  is("pay 1 Feb, renew 1 Mar, ask 2 Mar: both payments back, the plan ended", [twice.ok && twice.cents, feb.allRefunds().map((r) => r.amount), feb.sub().status], [13_800, [6_900, 6_900], "canceled"]);
  is("one email with the whole amount", world.emails.map((e) => e.text.includes("We refunded $138")), [true]);
  // A renewal whose time cannot be read is never left out of the whole (independent review, 31/10/2026).
  const blur = await paidShop({ at: NOW - 20 * DAY });
  blur.addPayment(NOW - 2 * DAY);
  (world.invoices[world.invoices.length - 1] as { status_transitions: { paid_at: unknown } }).status_transitions.paid_at = "soon";
  const blurred = await refundAndEndPlan(await blur.store(), NOW);
  is("a payment inside the window whose time cannot be read: nothing refunded, the plan goes on", [blurred.ok, blur.allRefunds().length, blur.sub().status], [false, 0, "active"]);
  const half = await paidShop({ at: NOW - 20 * DAY });
  half.addPayment(NOW - 2 * DAY);
  world.refundsLeft = 1;
  const cut = await refundAndEndPlan(await half.store(), NOW);
  world.refundsLeft = null;
  is("only the first of two refunds went through: failed, not ended, the stop kept", [cut.ok, half.allRefunds().length, half.sub().status, half.sub().cancel_at_period_end], [false, 1, "active", true]);
  // Told as what it is: part of the money is on its way (never "we do not know whether it went through").
  is("and it is answered as part of a refund", !cut.ok && cut.reason, "partial");
  await finishPlanRefunds(Date.now() + 10_000, NOW + 3_600);
  is("the daily job never ends the plan on part of a refund", [half.sub().status, (await half.note()) !== null], ["active", true]);
  // A second request that stops before it reads what is owed (the amount the page showed has changed, or one
  // charge's refunds cannot be read) must still judge by every charge the first request was refunding: one of the
  // two refunds made is never taken for the whole (independent review of 31/10/2026).
  const stale = await refundAndEndPlan(await half.store(), NOW + 20, 13_800);
  is("asked again with the old amount after part of it: not ended, nothing more refunded", [stale.ok, half.allRefunds().length, half.sub().status, notedCharges(await half.note())], [false, 1, "active", 2]);
  world.chargeListDown = true;
  const unread = await refundAndEndPlan(await half.store(), NOW + 40);
  world.chargeListDown = false;
  is("asked again while a charge's refunds cannot be read: not ended, the note keeps both charges", [unread.ok, half.allRefunds().length, half.sub().status, notedCharges(await half.note())], [false, 1, "active", 2]);
  const rest = await refundAndEndPlan(await half.store(), NOW + 60);
  is("asked again: the rest given back, once, and the plan ended", [rest.ok && rest.cents, half.allRefunds().map((r) => r.amount), half.sub().status, await half.note()], [6_900, [6_900, 6_900], "canceled", null]);
  delete process.env.RESEND_API_KEY;

  part("The add-on");
  const ad = await paidShop();
  const asst = `sub_asst${n}0001`;
  world.subs.set(asst, { id: asst, customer: `cus_flow${n}0001`, status: "active", cancel_at_period_end: false, metadata: { addon: "assistant", assistant_for: `flow${n}` } });
  await setAssistantPlan((await ad.store()).email, { subscriptionId: asst, active: true, period: null, cancelsAtEnd: false, disputedAt: "" });
  world.postDownFor.add(asst);
  const withAddOn = await refundAndEndPlan(await ad.store(), NOW);
  is("the add-on could not be set to stop: the plan's ending is not done, the note stays for the daily job", [withAddOn.ok && withAddOn.ended, (await ad.note()) !== null], [false, true]);
  world.postDownFor.delete(asst);
  await finishPlanRefunds(Date.now() + 10_000, NOW + 60);
  is("the daily job sets the add-on to stop at the end of its paid month and drops the note", [world.subs.get(asst)!.cancel_at_period_end, await ad.note(), ad.refunds().length], [true, null, 1]);

  part("The daily job");
  const h = await paidShop();
  world.endDown = true;
  await refundAndEndPlan(await h.store(), NOW);
  world.endDown = false;
  await redisPipeline([["SET", flowKeyOf((await h.store()).sid), "a-request", "EX", 60]]);
  await finishPlanRefunds(Date.now() + 10_000, NOW + 60);
  is("a store a request is finishing now is left alone", [h.sub().status, (await h.note()) !== null], ["active", true]);
  await redisPipeline([["DEL", flowKeyOf((await h.store()).sid)]]);
  world.listDown = true;
  world.chargeListDown = true;
  await finishPlanRefunds(Date.now() + 10_000, NOW + 60);
  is("refunds unreadable: kept for tomorrow", (await h.note()) !== null, true);
  process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";
  world.emails = [];
  await finishPlanRefunds(Date.now() + 10_000, NOW + GIVE_UP_DAYS * DAY + 1);
  world.listDown = false;
  world.chargeListDown = false;
  is(`undecidable for ${GIVE_UP_DAYS} days: dropped, the stop taken back`, [await h.note(), h.sub().cancel_at_period_end], [null, false]);
  is("and the creator is told the refund could not be confirmed, the plan renews as usual, how to ask again", world.emails.map((e) => [e.text.includes("We could not confirm the refund"), e.text.includes("It renews as usual unless you cancel it"), e.text.includes("Refund my payment")]), [[true, true, true]]);
  delete process.env.RESEND_API_KEY;
  await redisPipeline([["HSET", ENDING_KEY, "gone-store-id", JSON.stringify({ s: "sub_gonestore01", at: NOW, m: 1 })]]);
  await finishPlanRefunds(Date.now() + 10_000, NOW + 60);
  is("the note of a store that is gone is dropped", (await redisPipeline([["HGET", ENDING_KEY, "gone-store-id"]]))[0], null);
  is("an exhausted deadline touches nothing", await finishPlanRefunds(Date.now() - 1, NOW), { ended: 0, dropped: 0, left: 0 });
  done();
}

void main();
