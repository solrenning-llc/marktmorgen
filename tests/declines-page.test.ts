/**
 * 630 [HN6](28): the studio's page of payments that did not go through,
 * rendered with React from the real page, loader and rules, with Stripe
 * answered by a stand-in. A read cut short never says "none in 30 days"; an
 * amount Stripe did not give is never shown as $0.00; the page reads the
 * whole Stripe account, so only its owner opens it (Codex H 6647425307,
 * Claude 5 6704708398 and 6731681894).
 */
import { renderToStaticMarkup } from "react-dom/server";
import StudioDeclinesPage from "@/app/studio/declines/page";
import { DECLINE_PAGES } from "@/lib/declines";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/team-roles";
import { STORE, world } from "./declines-page-world";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_declines_page_stand_in";
let pages: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || url.pathname !== "/v1/charges" || init?.method !== "GET" || new Headers(init.headers).get("Stripe-Account") !== STORE.stripeAccountId) throw new Error(`unexpected ${url}`);
  return Response.json(pages.shift() ?? { error: "none" });
}) as typeof fetch;

const NOW = Math.floor(Date.now() / 1000);
const OLDEST = NOW - 6 * 86_400;
const charge = (id: string, extra: Record<string, unknown>) => ({ id, object: "charge", amount: 4900, currency: "usd", created: NOW - 3_600, status: "failed", ...extra });
const fullPages = (failed: boolean) => Array.from({ length: DECLINE_PAGES }, (_, i) => ({ object: "list", has_more: true, data: [charge(`ch_${i}a`, { status: failed && i === 0 ? "failed" : "succeeded", failure_code: "expired_card" }), charge(`ch_${i}b`, { status: "succeeded", created: i === DECLINE_PAGES - 1 ? OLDEST : NOW - 7_200 })] }));
const oldestDay = new Date(OLDEST * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

async function render(): Promise<string> {
  try {
    return renderToStaticMarkup(await StudioDeclinesPage({ searchParams: Promise.resolve({ store: STORE.sid }) })).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  } catch (error) {
    return String((error as Error).message);
  }
}

async function main(): Promise<void> {
  part("Who opens it: the whole Stripe account is read, so only its owner (Claude 5 MEDIUM)");
  for (const role of ["editor", "admin", "support"] as const) {
    world.role = role;
    pages = [{ object: "list", has_more: false, data: [charge("ch_other_store", { metadata: { store: "another-store" } })] }];
    is(`${role}: sent back with team=forbidden, nothing of the account shown`, await render(), `redirect:/studio?store=${STORE.sid}&team=forbidden`);
  }
  is("the permission asked is the owner's own (the Stripe connection), which no team role has", [world.asked.length === 3 && world.asked.every((p) => p === "payments"), can("editor", "payments"), can("admin", "payments"), can("support", "payments"), can("owner", "payments")], [true, false, false, false, true]);
  world.role = "owner";

  part("A complete read with no decline says none (control)");
  pages = [{ object: "list", has_more: false, data: [charge("ch_ok", { status: "succeeded" })] }];
  const complete = await render();
  is("says no payment was declined in the last 30 days, and nothing of a partial read", [complete.includes("No payment was declined in the last 30 days."), complete.includes("were not read")], [true, false]);

  part("A read cut short with no decline never says none in 30 days (Codex H MEDIUM 2)");
  pages = fullPages(false);
  const partialEmpty = await render();
  is("never \"No payment was declined in the last 30 days\"", partialEmpty.includes("No payment was declined in the last 30 days"), false);
  is("says what was read, how far back, and that older payments were not read", [partialEmpty.includes(`No declined payment among the newest ${DECLINE_PAGES * 2} payments, which go back to ${oldestDay}.`), partialEmpty.includes("Older payments from the last 30 days were not read, so there may be declines among them.")], [true, true]);

  part("A read cut short with declines never counts them as the last 30 days (Claude 5 LEVE 1)");
  pages = fullPages(true);
  const partialSome = await render();
  is("never \"in the last 30 days\" for a partial count", partialSome.includes("declined payment in the last 30 days"), false);
  is("the count is of the payments read, back to the oldest read", [partialSome.includes(`1 declined payment among the newest ${DECLINE_PAGES * 2} payments, which go back to ${oldestDay}.`), partialSome.includes("Older payments from the last 30 days were not read, so there may be more.")], [true, true]);

  part("An amount Stripe did not give is never $0.00 (Codex H MEDIUM 1)");
  pages = [{ object: "list", has_more: false, data: [charge("ch_noamount", { amount: null, failure_code: "expired_card" }), charge("ch_eur", { currency: "eur", failure_code: "expired_card" })] }];
  const unknown = await render();
  is("the readable amount in its own currency, the other said to be unknown, no $0.00 and no USD guess", [unknown.includes(formatMoney(4900, "eur")), unknown.includes("1 without a readable amount"), unknown.includes(formatMoney(0, "usd")), unknown.includes(formatMoney(4900, "usd"))], [true, true, false, false]);
  is("both declines counted", unknown.includes("2 declined payments in the last 30 days."), true);

  part("The table scrolls by keyboard too (Claude 5 LEVE 3, WCAG 2.1.1)");
  pages = [{ object: "list", has_more: false, data: [charge("ch_t", { failure_code: "expired_card" })] }];
  const html = renderToStaticMarkup(await StudioDeclinesPage({ searchParams: Promise.resolve({ store: STORE.sid }) }));
  const box = html.match(/<div[^>]*overflow-x-auto[^>]*>/)?.[0] ?? "";
  const label = box.match(/aria-labelledby="([^"]+)"/)?.[1] ?? "";
  is("the scrolling box takes focus and is named by a heading on the page", [/tabindex="0"/.test(box), /role="region"/.test(box), label !== "" && html.includes(`id="${label}"`)], [true, true, true]);

  done();
}

void main();
