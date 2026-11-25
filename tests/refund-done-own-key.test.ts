/**
 * Claude 5's LEVE D on #2849 (6704329663), #5285 row #2849: the studio refund
 * page read `REFUND_DONE[query.done]` without checking the key is the table's
 * own, so `?done=constructor` (or `toString`, `__proto__`) found an inherited
 * function: a notice with an empty title was drawn as `data-refund-done=
 * "constructor"`, the "an earlier refund is still being settled" notice was
 * suppressed by it, and the tab's title read "undefined — Marktmorgen". Held:
 * only the table's own keys are read, on the page and in its title, as the
 * withdrawal notices already were (withdrawNoticeOf).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import StudioRefundPage, { generateMetadata } from "@/app/studio/refund/page";
import { REFUND_DONE } from "@/lib/plan-refund-words";
import { who } from "./plan-refund-route-world";
import { paidShop } from "./plan-refund-stripe-world";

const page = async (query: Record<string, string>) => renderToStaticMarkup(await StudioRefundPage({ searchParams: Promise.resolve(query) }));
const title = async (query: Record<string, string>) => String((await generateMetadata({ searchParams: Promise.resolve(query) })).title);

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  const shop = await paidShop();
  who.store = await shop.store();
  who.role = "owner";

  part("A key the table does not own is no notice, on the page and in the tab's title");
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const html = await page({ done: key });
    is(`${key}: no notice drawn for it`, html.includes(`data-refund-done="${key}"`), false);
    is(`${key}: the tab's title is the page's own`, await title({ done: key }), "Refund your payment — Marktmorgen");
  }

  part("Control: a key the table owns is still said");
  const own = Object.keys(REFUND_DONE).find((k) => k !== "owner" && k !== "busy")!;
  is(`${own}: its notice is drawn`, (await page({ done: own })).includes(`data-refund-done="${own}"`), true);
  is(`${own}: its title is the tab's`, await title({ done: own }), `${REFUND_DONE[own].title} — Marktmorgen`);

  done();
}

main();
