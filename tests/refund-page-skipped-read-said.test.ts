/**
 * Claude 5's LEVE C on #2849 (6704329663), #5285 row #2849: once the studio
 * refund page's daily reads (SHOWN_PER_DAY) were used up, it passed no reading
 * to planWithdrawWindow, which took it for "Stripe could not be read": a plan
 * paid 200 days before was offered "Withdraw from contract here" with "We could
 * not check the date of your payment just now". The offer stays (never hidden
 * on a guess, and the route still answers "closed" past the 14 days), but the
 * sentence now says the payment was not read on this visit, never that Stripe
 * did not answer.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import StudioRefundPage from "@/app/studio/refund/page";
import { PLAN_WITHDRAW_WORDS as W } from "@/lib/plan-withdrawal-words";
import { who } from "./plan-refund-route-world";
import { NOW, paidShop } from "./plan-refund-stripe-world";

const page = async () => renderToStaticMarkup(await StudioRefundPage({ searchParams: Promise.resolve({}) }));
const esc = (text: string) => text.replace(/'/g, "&#x27;");
const STRIPE_SAID = "We could not check the date of your payment just now";

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  who.role = "owner";

  part("Control: a plan paid 200 days before, read, is not offered the withdrawal");
  const old = await paidShop({ at: NOW - 200 * 86_400 });
  who.store = await old.store();
  const first = await page();
  is("not offered", first.includes("Withdraw from contract here"), false);

  part("The page's reads used up: the offer stays, said as not read on this visit, never as Stripe's answer");
  let last = first;
  for (let i = 0; i < 25; i++) last = await page();
  is("still offered (the route decides on the statement)", last.includes("Withdraw from contract here"), true);
  is("never says Stripe could not be read", last.includes(STRIPE_SAID), false);
  is("says the payment was not read on this visit", last.includes(esc("We did not check the date of your payment on this visit")), true);

  done();
}

main();
