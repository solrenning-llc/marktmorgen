/**
 * Every length and price of a call said where the store says a call's
 * length or price (637 [GL5], unit 2c; added 3 November 2026), on synthetic
 * records only: the card's line and price, the booking button, the page's
 * facts, the Store assistant's facts, the product page's structured data
 * (read in its source) and the reminder of a call left at its checkout.
 * A call with one length is said exactly as before.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { readSetup, type CallSetup } from "@/lib/call-setup";
import { lengthList, listedLengths } from "@/lib/call-lengths";
import { ProductFacts, pricePill } from "@/components/store-product";
import { pageFacts } from "@/lib/page-facts";
import { priceWords } from "@/lib/answers";
import { bookLink, remindAbandoned } from "@/lib/checkout-recovery";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setRecovery, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import type { Listing } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const emails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; text: string };
    emails.push({ to: [body.to].flat()[0], text: body.text });
    return new Response(JSON.stringify({ id: `e${emails.length}` }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

const NY = "America/New_York";
const WEEK: [number, number][][] = [[[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]]];
const weekly = { kind: "weekly", minutes: 30, tz: NY, weekly: WEEK, noticeHours: 12, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] };
const LENGTHS = [{ minutes: 30, cents: 4500 }, { minutes: 60, cents: 8000 }, { minutes: 90, cents: 11000 }];

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_call_lengths_said";
  process.env.RESEND_API_KEY = "re_test_call_lengths_said";
  const OWNER = "lena@example.com";
  await claimHandle(OWNER, "lena", "Lena Coaching", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLena00001", true);
  await setSubscription(OWNER, { customerId: "cus_lena00001", subscriptionId: "sub_lena00001", active: true, tier: "creator", period: paidPeriod() });
  await setRecovery(OWNER, { enabled: true, address: "1 Main St, Austin, TX 78701", asks: true });
  const made = await addProduct(OWNER, "Coaching", "", "45", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  await setProductCall(OWNER, id, readSetup({ ...weekly, lengths: LENGTHS }) as CallSetup);
  const store = (await storeForEmail(OWNER)) as Store;
  const product = (await readListing(store, id)) as Listing;
  const one = { ...product, call: readSetup(weekly) as CallSetup } as Listing;

  part("Listed as the booking page offers them");
  is("the call's lengths, in the store's language", [listedLengths(product.call!, 4500).length, lengthList(LENGTHS, "en-US"), lengthList(LENGTHS.slice(0, 2), "de-DE"), lengthList(LENGTHS.slice(0, 2), "pt-PT")], [3, "30, 60, or 90", "30 oder 60", "30 ou 60"]);
  is("none when the price was changed since, with a deposit, or for one length", [listedLengths(product.call!, 5000), listedLengths({ ...product.call!, deposit: 2000 }, 4500), listedLengths(one.call!, 4500)], [[], [], []]);

  part("On the store page");
  is("the price, from the lowest", [pricePill(store, product), pricePill(store, one)], ["from $45", "$45"]);
  const facts = renderToStaticMarkup(createElement(ProductFacts, { store, product }));
  const factsOne = renderToStaticMarkup(createElement(ProductFacts, { store, product: one }));
  is("the card says every length; one length is said as before", [facts.includes("Call, 30, 60, or 90 minutes, online"), factsOne.includes("30-minute call, online")], [true, true]);
  const card = readFileSync("components/store-product.tsx", "utf8");
  is("the booking button says the price as the card does", card.includes("w.priced(product.call.kind === \"live\" ? w.pickSession : w.pickTime, pricePill(store, product))"), true);
  const page = (call: CallSetup) => pageFacts({ language: "en", locale: "en-US", product: { call }, bundleItems: null, sold: null, reviews: null });
  is("one length for every booking is a fact; several are not one", [page(one.call!).length?.value, page(product.call!).length], ["30", undefined]);

  part("To the Store assistant and to search engines");
  is("each length with its own price", priceWords(product, "usd"), "The buyer picks how long the call is, each length at its own price: 30 minutes for $45; 60 minutes for $80; 90 minutes for $110. Paid once.");
  is("one length as before", priceWords(one, "usd"), "$45, paid once.");
  const productPage = readFileSync("app/[handle]/p/[product]/page.tsx", "utf8");
  is("the structured data is an offer from the lowest length's price to the highest", [productPage.includes("lowPrice: moneyField(Math.min(...lengths.map((l) => l.cents)), store.currency)"), productPage.includes("offerCount: lengths.length")], [true, true]);

  part("The reminder of a call left at its checkout");
  const now = Math.floor(Date.now() / 1000);
  const start = Date.now() + 3 * 86_400_000;
  const left = (session: string, email: string, minutes?: string) => ({
    id: session, object: "checkout.session", status: "expired", payment_status: "unpaid", created: now - 2000, expires_at: now - 100,
    consent: { promotions: "opt_in" }, customer_details: { email },
    metadata: { store: "lena", product: id, kind: "call", start: String(start), end: String(start + 3_600_000), tz: NY, ...(minutes ? { minutes } : {}) },
  });
  is("sent", await remindAbandoned(store, left("cs_test_lenleft000001", "ana@example.com", "60") as never), "sent");
  const mail = emails.at(-1)!.text;
  is("names the length chosen, at its price today, and leads to its times", [mail.includes("Coaching · 60 minutes"), mail.includes("The price: $80."), mail.includes(`${bookLink(store, id)}?length=60`)], [true, true, true]);
  await remindAbandoned(store, left("cs_test_lenleft000002", "bo@example.com", "45") as never);
  const gone = emails.at(-1)!.text;
  is("a length no longer on the list leads to the call's lengths, from the lowest price", [gone.includes("The price: from $45."), gone.includes("?length=")], [true, false]);
}

void main().then(() => done(), (error) => {
  console.error(error);
  process.exit(1);
});
