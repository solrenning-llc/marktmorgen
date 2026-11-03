/**
 * 630 [HN6](28): payments that did not go through, read from the creator's
 * own Stripe account, counted by Stripe's reason with what usually helps;
 * an answer that cannot be read whole is unknown, never "no declines".
 */
import { readFileSync } from "node:fs";
import { DECLINE_WORDS, declineGroup, declineSummary, reasonOf } from "@/lib/declines-rules";
import { DECLINE_PAGES, declinesSince, readDeclines } from "@/lib/declines";
import { done, is, part } from "./check";

const ACCOUNT = "acct_Declines01";
process.env.STRIPE_SECRET_KEY = "sk_test_declines_stand_in";
let pages: unknown[] = [];
const asked: URL[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || url.pathname !== "/v1/charges" || init?.method !== "GET" || new Headers(init.headers).get("Stripe-Account") !== ACCOUNT) throw new Error(`unexpected ${url}`);
  asked.push(url);
  return Response.json(pages.shift() ?? { error: "none" });
}) as typeof fetch;

const charge = (id: string, extra: Record<string, unknown>) => ({ id, object: "charge", amount: 4900, currency: "usd", created: 1_790_000_000, status: "failed", ...extra });

async function main(): Promise<void> {
  part("Stripe's reasons, grouped");
  is("the outcome's reason first, else the failure code", [reasonOf({ outcome: { reason: "insufficient_funds" }, failure_code: "card_declined" }), reasonOf({ failure_code: "expired_card" }), reasonOf({}), reasonOf({ failure_code: "<b>" })], ["insufficient_funds", "expired_card", "", ""]);
  is("each reason in its group", ["insufficient_funds", "expired_card", "incorrect_cvc", "authentication_required", "do_not_honor", "stolen_card", "processing_error", "currency_not_supported", "something_new"].map(declineGroup), ["funds", "expired", "typo", "confirm", "bank", "fraud", "network", "unsupported", "other"]);
  is("every group has a title and what helps", Object.values(DECLINE_WORDS).every((w) => w.title.length > 5 && w.help.length > 20), true);
  is("fraud is never met with asking for the same card again", DECLINE_WORDS.fraud.help.includes("Do not ask for the same card again"), true);
  const summary = declineSummary([
    { reason: "insufficient_funds", cents: 4900, currency: "usd", created: 1 },
    { reason: "insufficient_funds", cents: 1000, currency: "eur", created: 2 },
    { reason: "card_velocity_exceeded", cents: 100, currency: "usd", created: 3 },
    { reason: "expired_card", cents: 2000, currency: "usd", created: 4 },
    { reason: "", cents: 500, currency: "usd", created: 5 },
  ]);
  is("most first, amounts per currency never added across, Stripe's words kept", summary, [
    { group: "funds", count: 3, amounts: [{ currency: "eur", cents: 1000 }, { currency: "usd", cents: 5000 }], reasons: ["card_velocity_exceeded", "insufficient_funds"] },
    { group: "expired", count: 1, amounts: [{ currency: "usd", cents: 2000 }], reasons: ["expired_card"] },
    { group: "other", count: 1, amounts: [{ currency: "usd", cents: 500 }], reasons: [] },
  ]);

  part("Read from the creator's Stripe account");
  is("no account, nothing read", [await readDeclines({ stripeAccountId: null }, 0), asked.length], [null, 0]);
  const since = declinesSince(30, Date.UTC(2026, 10, 3) / 1000 * 1000);
  pages = [{ object: "list", has_more: false, data: [charge("ch_1", { outcome: { reason: "insufficient_funds" } }), charge("ch_2", { status: "succeeded" }), charge("ch_3", { failure_code: "expired_card" })] }];
  const read = await readDeclines({ stripeAccountId: ACCOUNT }, since);
  is("only the failed ones, with their reason, amount and currency", read, { rows: [{ reason: "insufficient_funds", cents: 4900, currency: "usd", created: 1_790_000_000 }, { reason: "expired_card", cents: 4900, currency: "usd", created: 1_790_000_000 }], partial: false });
  is("from 30 days back, a hundred at a time", [asked[0].searchParams.get("created[gte]"), asked[0].searchParams.get("limit")], [String(Date.UTC(2026, 10, 3) / 1000 - 30 * 86_400), "100"]);
  pages = Array.from({ length: DECLINE_PAGES }, (_, i) => ({ object: "list", has_more: true, data: [charge(`ch_p${i}`, {})] }));
  const many = await readDeclines({ stripeAccountId: ACCOUNT }, since);
  is(`at most ${DECLINE_PAGES} pages, then partial`, [many?.rows.length, many?.partial, asked.slice(-2)[1].searchParams.get("starting_after")], [DECLINE_PAGES, true, `ch_p${DECLINE_PAGES - 2}`]);
  for (const bad of [{ data: null, has_more: false }, { data: [], has_more: "no" }, { data: [charge("ch_x", {}), charge("ch_x", {})], has_more: false }, { data: [null], has_more: false }]) {
    pages = [bad];
    is(`unreadable, so unknown, never zero: ${JSON.stringify(bad).slice(0, 40)}`, await readDeclines({ stripeAccountId: ACCOUNT }, since), null);
  }

  part("The page");
  const page = readFileSync("app/studio/declines/page.tsx", "utf8");
  is("for those who may read the store's numbers", page.includes('"stats")'), true);
  is("says it counts every declined payment on the Stripe account", page.includes("It counts every declined payment on that account, including any that were not for this store."), true);
  is("an unreadable Stripe shows nothing rather than a wrong number", page.includes("so nothing is shown rather than a number that may be wrong"), true);
  is("a real table: caption, column and row headers", page.includes("<caption") && page.includes('scope="col"') && page.includes('scope="row"'), true);
  is("reached from the page of disputed purchases", readFileSync("app/studio/disputes/page.tsx", "utf8").includes('studioPath(store, "", "declines")'), true);

  done();
}

void main();
