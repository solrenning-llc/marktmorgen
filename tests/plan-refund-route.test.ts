/**
 * The plan refund route and the words around it (305 [SY1] unit 2b2:
 * app/api/billing/refund/route.ts, lib/plan-refund-words.ts, the email in
 * lib/plan-refund-flow.ts), against the stand-in Stripe and Resend of
 * tests/plan-refund-stripe-world.ts. The signed-in creator is set by the
 * test (tests/plan-refund-route-world.ts). Nothing real is reached.
 *
 * What fails here:
 *   - a refund made without the review page's one-time pass, with a pass
 *     used before, by someone who is not the store's owner, or for another
 *     amount than the page showed;
 *   - no confirmation email, two of them, or one whose amount or words do
 *     not match what was done;
 *   - a refusal without a reason in plain words and the way to support.
 */
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { POST } from "@/app/api/billing/refund/route";
import { ENDING_KEY, issueReview } from "@/lib/plan-refund-flow";
import { CLOSING_DAYS } from "@/lib/plan-closing-rules";
import { REFUND_DAYS } from "@/lib/plan";
import { REFUND_DONE, SUPPORT_ADDRESS, planRefundLetter, refundEffects, refusalWords } from "@/lib/plan-refund-words";
import { who } from "./plan-refund-route-world";
import { paidShop, world } from "./plan-refund-stripe-world";

const post = async (review: string) => {
  const response = await POST(new NextRequest("https://local.example/api/billing/refund", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `review=${encodeURIComponent(review)}` }));
  const to = new URL(response.headers.get("location")!);
  return { page: to.pathname, done: to.searchParams.get("done") };
};

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";

  part("Only from the review page, only by the owner");
  const a = await paidShop();
  who.store = await a.store();
  is("no pass: nothing refunded, told on the review page", [await post(""), a.refunds().length], [{ page: "/studio/refund", done: "review" }, 0]);
  is("a made-up pass: nothing refunded", [(await post("abcdefghijklmnopqrstuvwx")).done, a.refunds().length], ["review", 0]);
  who.role = "admin";
  const asAdmin = await issueReview(who.store.sid, 6_900);
  is("an admin of the store: refused before anything", [(await post(asAdmin)).done, a.refunds().length, a.sub().cancel_at_period_end], ["owner", 0, false]);
  who.role = "owner";

  part("Confirmed on the review page");
  const pass = await issueReview(who.store.sid, 6_900);
  world.emails = [];
  is("refunded and ended", (await post(pass)).done, "refunded");
  is("one refund, for the amount shown; the plan ended", [a.refunds().map((r) => r.amount), a.sub().status, (await a.store()).subscriptionActive], [[6_900], "canceled", false]);
  is("one email, to the store's own address", world.emails.map((e) => e.to), [who.store.email]);
  const letter = world.emails[0];
  is("it says the amount and that the plan ended", [letter.text.includes("We refunded $69 for your Marktmorgen plan"), letter.text.includes("Your plan ends today"), letter.subject.endsWith("your plan payment was refunded")], [true, true, true]);
  is("sent under the refund's own key, so a retry never sends it twice", letter.key.includes(`plan-refund-told:${a.refunds()[0].id}`), true);
  is("the same pass again: nothing more", [(await post(pass)).done, a.refunds().length, world.emails.length], ["review", 1, 1]);

  part("Another amount than the page showed");
  const b = await paidShop();
  who.store = await b.store();
  const stale = await issueReview(who.store.sid, 5_000);
  is("the policy gives another amount now: nothing refunded, the new one shown", [(await post(stale)).done, b.refunds().length], ["changed", 0]);
  is("and the stop set for it taken back", [b.sub().status, b.sub().cancel_at_period_end], ["active", false]);
  const newer = await issueReview(who.store.sid, 6_900);
  await issueReview(who.store.sid, 6_900);
  is("an older copy of the page, once a newer one was opened: refused", [(await post(newer)).done, b.refunds().length], ["review", 0]);

  part("Not owed");
  const late = await paidShop({ at: Math.floor(Date.UTC(2026, 11, 2) / 1000) - 400 * 86_400 });
  who.store = await late.store();
  is("outside the window: told why on the review page, nothing changed", [(await post(await issueReview(who.store.sid, 6_900))).done, late.refunds().length, late.sub().cancel_at_period_end], ["none", 0, false]);

  part("Pressed twice, or answered part way");
  const c = await paidShop();
  who.store = await c.store();
  const twice = await issueReview(who.store.sid, 6_900);
  world.slow = 30;
  const both = (await Promise.all([post(twice), post(twice)])).map((r) => r.done).sort();
  world.slow = 0;
  is("two presses at once: one refund, and the second told it is being handled, never 'nothing'", [both, c.refunds().length], [["busy", "refunded"], 1]);

  const d = await paidShop();
  who.store = await d.store();
  world.refundsDown = true;
  is("the refund write fails after we set the stop: 'could not confirm', the stop kept", [(await post(await issueReview(who.store.sid, 6_900))).done, d.sub().cancel_at_period_end], ["error-stop", true]);
  world.refundsDown = false;

  const e = await paidShop({ stopSet: true });
  who.store = await e.store();
  world.refundsDown = true;
  is("the refund write fails, the creator had set the stop: 'could not confirm', not 'nothing'", [(await post(await issueReview(who.store.sid, 6_900))).done, Boolean(await e.note())], ["unsure", true]);
  world.refundsDown = false;

  const f = await paidShop();
  who.store = await f.store();
  world.stopDown = true;
  is("the stop cannot be set: nothing was done, told so", [(await post(await issueReview(who.store.sid, 6_900))).done, f.refunds().length, await f.note()], ["error", 0, null]);
  world.stopDown = false;

  const g = await paidShop();
  who.store = await g.store();
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((cmd) => cmd[0] === "HSET" && cmd[1] === ENDING_KEY)) throw new Error("a stand-in store failure");
    return pipeline(commands);
  }) as typeof redis.pipeline;
  const thrown = await post(await issueReview(who.store.sid, 6_900));
  redis.pipeline = pipeline;
  is("the store fails before any money moves: told nothing was done, never a raw error", [thrown.page, thrown.done, g.refunds().length], ["/studio/refund", "error", 0]);

  part("The words");
  const reasons = ["no_plan_payment", "not_paid", "nothing_paid", "dispute_open", "dispute_returned", "already_refunded", "guarantee_used", "outside_window", "renewal", "switch_charge", "months_used", "fee_kept"];
  is("every reason is said in plain words, with the way to support", reasons.every((reason) => {
    const w = refusalWords({ refund: { kind: "none", reason } as never });
    return !w.body.startsWith("This payment cannot be refunded") && w.body.includes(SUPPORT_ADDRESS);
  }), true);
  // The same words reach a renewal inside the window whose first payment was not covered (the guarantee used
  // before, for another store), so they never say it was made after the window (independent review, 31/10/2026).
  const partWords = REFUND_DONE.partial;
  is("part of a refund made: said so, with the stop kept and the way to support", [partWords.title, /Part of your refund is on its way/.test(partWords.body), /set to stop at the end of the period you paid for/.test(partWords.body), partWords.body.includes("do not know")], ["Part of your refund went through", true, true, false]);
  is("a renewal or a switch is refused with words true inside the window too (owner, 31/10/2026 15h41)", ["renewal", "switch_charge"].map((reason) => {
    const body = refusalWords({ refund: { kind: "none", reason } as never }).body;
    return [body.includes(`within ${REFUND_DAYS} days of that payment`), body.includes("once per person"), /more than \d+ days after/.test(body)];
  }), [[true, true, false], [true, true, false]]);
  is("the guarantee is once per person", refusalWords({ refund: { kind: "none", reason: "guarantee_used" } as never }).body.includes("once per person"), true);
  is("the window is the policy's", refusalWords({ refund: { kind: "none", reason: "outside_window" } as never }).body.includes(`${REFUND_DAYS} days`), true);
  is("not decidable: support, never a no", ["customer_credit", "stripe_unread", "unreadable"].every((reason) => refusalWords({ refund: { kind: "unknown", reason } as never }).body.includes(SUPPORT_ADDRESS)), true);
  is("what happens to the store uses the closing rules' own days", refundEffects({ assistant: false }).some((line) => line.includes(`${CLOSING_DAYS} days`)), true);
  is("the add-on is mentioned only when the store has it", [refundEffects({ assistant: true }).length - refundEffects({ assistant: false }).length], [1]);
  is("the letter's pending wording", planRefundLetter({ store: "Maya", cents: 6_900, currency: "usd", pending: true, assistant: false }).text.includes("still processing"), true);
  is("what happens says closing stops the renewals sold on the creator's own Stripe, never that it is untouched", [refundEffects({ assistant: false }).some((line) => line.includes("stopped at Stripe")), refundEffects({ assistant: false }).some((line) => /not touched/.test(line))], [true, false]);
  done();
}

void main();
