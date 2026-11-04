/**
 * The plan refund's review page (305 [SY1] unit 2b2, app/studio/refund),
 * rendered with the real reading, pass and words against the stand-in Stripe
 * of tests/plan-refund-stripe-world.ts; only the session and the studio's
 * header are stand-ins (tests/test-config.mjs). Nothing real is reached.
 *
 * What fails here: a confirm button for anyone but the owner, for a refusal,
 * or while an earlier refund is still being settled; an amount other than the
 * one the pass carries; a page that does not name the store; words saying the
 * creator's own Stripe account is untouched (closing stops its renewals).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import StudioRefundPage from "@/app/studio/refund/page";
import { ENDING_KEY, GIVE_UP_DAYS, reviewKeyOf } from "@/lib/plan-refund-flow";
import { REFUND_CHECK_DAYS, REFUND_DONE } from "@/lib/plan-refund-words";
import { answerId, HELP_SECTIONS } from "@/lib/help-content";
import { redisPipeline } from "@/lib/redis";
import { who } from "./plan-refund-route-world";
import { NOW, paidShop } from "./plan-refund-stripe-world";

const page = async (query: Record<string, string> = {}) => renderToStaticMarkup(await StudioRefundPage({ searchParams: Promise.resolve(query) }));
const pass = async (sid: string) => (await redisPipeline([["GET", reviewKeyOf(sid)]]))[0];

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";

  part("The owner, a refund owed");
  const a = await paidShop();
  who.store = await a.store();
  who.role = "owner";
  const html = await page();
  is("names the store", html.includes(`Refund your payment for ${who.store.name}`), true);
  is("the amount, on the button and in the review", [html.includes("Refund $69 and end the plan for"), html.includes('data-refund-amount="6900"')], [true, true]);
  // The listed part may be a renewal (the first already given back, or in a dispute): the sentence names the list,
  // never "your first payment" (independent review, 31/10/2026).
  is("the amount's sentence names the payments listed, not which one they are", [html.includes("the plan payment listed below, in full"), html.includes("your first payment, in full")], [true, false]);
  is("the pass carries the amount shown", String(await pass(who.store.sid)).endsWith(":6900"), true);
  is("what closing does to the store's data and to its renewals is said", [html.includes("its files are removed"), html.includes("stopped at Stripe"), html.includes("deleted")], [true, true, true]);
  is("never that the creator's own Stripe account is untouched", /not touched/.test(html), false);
  is("a way back of the same weight", html.includes("Go back without changing anything"), true);
  is("a skip link to the content", html.includes('href="#content"'), true);
  is("the Help answer it links exists", HELP_SECTIONS.some((s) => s.items.some((item) => answerId(item.q) === "what-happens-when-my-plan-ends")) && html.includes("/help#what-happens-when-my-plan-ends"), true);

  part("Not the owner");
  who.role = "admin";
  await redisPipeline([["DEL", reviewKeyOf(who.store.sid)]]);
  const admin = await page();
  is("told only the owner can, with no button and no pass", [admin.includes(REFUND_DONE.owner.title.replace(/'/g, "&#x27;")), admin.includes("and end the plan"), await pass(who.store.sid)], [true, false, null]);
  who.role = "owner";

  part("Not owed");
  const late = await paidShop({ at: NOW - 400 * 86_400 });
  who.store = await late.store();
  const refused = await page();
  is("the reason, and no button", [refused.includes("data-refund-refused"), refused.includes("and end the plan")], [true, false]);

  part("An earlier refund still being settled");
  const b = await paidShop();
  who.store = await b.store();
  await redisPipeline([["HSET", ENDING_KEY, who.store.sid, JSON.stringify({ s: b.subId, at: NOW, t: NOW, m: 1 })]]);
  const settling = await page();
  is("told it is being handled, with no button and no new pass", [settling.includes(REFUND_DONE.busy.title), settling.includes("and end the plan"), await pass(who.store.sid)], [true, false, null]);

  part("The answers");
  is("a refund that may have been made is never 'Nothing was refunded'", ["unsure", "error-stop", "busy", "review", "changed", "ending"].every((k) => !REFUND_DONE[k].title.startsWith("Nothing was refunded")), true);
  is("a pending refund is not called refunded", REFUND_DONE.ending.title, "Your refund is on its way");
  is("the days said are the daily job's", REFUND_CHECK_DAYS, GIVE_UP_DAYS);
  done();
}

void main();
