/**
 * The amount a buyer and a creator are told after paying, read exactly from
 * what Stripe charged (CX-123 rule 24; rule 27; audit R48 follow-ups).
 * Synthetic stores, mocked Stripe and email. Checked:
 *
 *   - a paid call's confirmation says its amounts in the currency Stripe
 *     charged, three lowercase letters as Stripe gives them; anything else
 *     leaves the amounts out of the phone alert and both emails, never the
 *     store's own currency in its place. The creator is still told a code
 *     was used and that the rest is collected in person, with no amount;
 *   - the paid call read from Stripe keeps only a currency of that shape;
 *   - a membership checkout with no total_details whose price before
 *     discounts is above what was charged is never "the price every month";
 *     one whose price before discounts does not read is not confirmed yet;
 *   - the thanks page says a first-charge discount the way the email does,
 *     never "for $10 a month";
 *   - controls: an exact currency, a membership with nothing off and a
 *     plain call read as before.
 */
import { readFileSync } from "node:fs";
import { creatorDueLine } from "@/lib/call-deposit";
import { zonedToUtc, type CallSetup } from "@/lib/call-setup";
import * as calls from "@/lib/calls";
import { confirmBooking, paidCall, type CallListing } from "@/lib/calls";
import * as purchaseEmail from "@/lib/purchase-email";
import { confirmationFor } from "@/lib/purchase-email";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readListing, type Listing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const emails: { to: string; text: string }[] = [];
let sale: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const sent = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    emails.push({ to: String(Array.isArray(sent.to) ? sent.to[0] : sent.to), text: sent.text ?? "" });
    return answer({ id: "e" });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "GET" && /^\/checkout\/sessions\/cs_test_/.test(path)) return answer(sale);
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];

function weekdayAt(days: number, minute: number): number {
  for (let d = days; d < days + 8; d += 1) {
    const day = new Date(Date.now() + d * 86_400_000);
    const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(day);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    return zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), minute, NY) as number;
  }
  throw new Error("no weekday");
}

const flat = (file: string) => readFileSync(file, "utf8").replace(/\s+/g, " ");

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_amount_followups_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

  const OWNER = "bela@example.com";
  await claimHandle(OWNER, "bela", "Bela Studio", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestBela00001", true);
  await setSubscription(OWNER, { customerId: "cus_bela00001", subscriptionId: "sub_bela00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Haircut", "", "80", null);
  if (!made.ok) throw new Error("no product");
  const setup = { kind: "weekly", minutes: 60, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, seats: 1, sessions: [], place: "Bela Studio\n12 Harbor Street", deposit: 2000 };
  await setProductCall(OWNER, made.product.id, setup as unknown as CallSetup);
  const club = await addProduct(OWNER, "Supper Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no membership");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  const store = (await storeForEmail(OWNER)) as Store;
  is("the store's own currency is usd, so a guess would say $", store.currency, "usd");
  const listing = (await readListing(store, made.product.id)) as CallListing;
  const clubListing = (await readListing(store, club.product.id)) as Listing;
  const at = weekdayAt(3, 600);
  const due = { rest: 4000, code: "SPRING", codeOff: 2000 };
  let n = 0;
  const confirm = async (currency: unknown) => {
    n += 1;
    emails.length = 0;
    // A throw is a failure here too: the booking would be left unconfirmed, its emails unsent.
    const thrown = await confirmBooking({ store, product: listing, session: `cs_test_amountfollow${String(n).padStart(4, "0")}`, start: at, end: at + 3_600_000, buyerEmail: "ana@example.com", buyerTz: NY, amountCents: 2000, currency: currency as string, origin: "https://marktmorgen.com", due, cancel: null }).then(() => false, () => true);
    if (thrown) return { buyer: "", creator: "" };
    return { buyer: emails.find((e) => e.to === "ana@example.com")?.text ?? "", creator: emails.find((e) => e.to !== "ana@example.com")?.text ?? "" };
  };

  part("The currency Stripe charged, read exactly");
  const chargedIn = (calls as unknown as { chargedIn?: (raw: unknown) => string | null }).chargedIn;
  is("there is one reader for it", typeof chargedIn, "function");
  is(
    "three lowercase letters as Stripe gives them; anything else is not known",
    ["eur", "usd", "USD", "", "eu", "euro", 978, null, undefined, { code: "eur" }].map((raw) => (chargedIn ? chargedIn(raw) : "missing")),
    ["eur", "usd", null, null, null, null, null, null, null, null],
  );

  part("A paid call whose currency is not known: no amount is said, and none in the store's currency");
  for (const [label, raw] of [["none", undefined], ["empty", ""], ["upper case", "USD"], ["a number", 840]] as const) {
    const { buyer, creator } = await confirm(raw);
    is(`${label}: both emails still go`, [buyer.length > 0, creator.length > 0], [true, true]);
    is(`${label}: no amount in the buyer's email`, /[$€£]\s?\d|\d\s?(USD|EUR)/.test(buyer), false);
    is(`${label}: no amount in the creator's email`, /[$€£]\s?\d|\d\s?(USD|EUR)/.test(creator), false);
    is(
      `${label}: the creator is still told the code and that the rest is collected in person`,
      creator.includes("In person, at: Bela Studio, 12 Harbor Street\nThey used code SPRING, taken off the whole price. The rest is paid to you in person; its amount is on the order in your Stripe account."),
      true,
    );
  }

  part("Control: a currency that reads");
  const euro = await confirm("eur");
  is("the buyer is told the code and the rest in it", euro.buyer.includes("Code SPRING: €20 off the whole price.\nA deposit to hold your time. The rest, €40, is paid in person to Bela Studio."), true);
  is("the creator too", euro.creator.includes("They used code SPRING: €20 off the whole price. €20 was paid now as a deposit. The rest, €40, is paid to you in person."), true);
  const dollars = await confirm("usd");
  is("and the store's own currency when Stripe charged it", dollars.buyer.includes("The rest, $40, is paid in person to Bela Studio."), true);

  part("The creator's line with no currency");
  is(
    "the same facts, no amount",
    [
      creatorDueLine(due, { paidCents: 2000, currency: null as unknown as string }),
      creatorDueLine({ rest: 6000, code: null, codeOff: 0 }, { paidCents: 2000, currency: null as unknown as string }),
      creatorDueLine({ rest: 0, code: "SPRING", codeOff: 7000 }, { paidCents: 1000, currency: null as unknown as string }),
      creatorDueLine(null, { paidCents: 2000, currency: null as unknown as string }),
    ],
    [
      "They used code SPRING, taken off the whole price. The rest is paid to you in person; its amount is on the order in your Stripe account.",
      "The rest is paid to you in person; its amount is on the order in your Stripe account.",
      "They used code SPRING, taken off the whole price.",
      "",
    ],
  );

  part("The paid call read from Stripe keeps only a currency of that shape");
  const row = (currency: unknown) => ({
    id: "cs_test_amountfollowrow1",
    status: "complete",
    payment_status: "paid",
    amount_total: 2000,
    currency,
    metadata: { kind: "call", store: "bela", product: listing.id, start: String(at), end: String(at + 3_600_000), tz: NY },
  });
  const readCurrency = async (currency: unknown) => {
    sale = row(currency);
    return (await paidCall(store, "cs_test_amountfollowrow1"))?.currency;
  };
  is("eur stays eur; USD, a number and none are empty", [await readCurrency("eur"), await readCurrency("USD"), await readCurrency(840), await readCurrency(undefined)], ["eur", "", "", ""]);

  part("Every way a paid call is confirmed reads it the same way");
  const callsText = flat("lib/calls.ts");
  is("the phone alert says an amount only in the currency read", callsText.includes("const paid = paidIn && Number.isSafeInteger(input.amountCents) && Number(input.amountCents) > 0 ? formatMoney(Number(input.amountCents), paidIn) : \"\";"), true);
  is("nothing falls back to the store's currency for what was paid", [/input\.currency \|\| store\.currency/.test(callsText), /currency: typeof row\.currency === "string" && row\.currency \? row\.currency\.toLowerCase\(\)/.test(callsText)], [false, false]);
  const thanks = flat("app/[handle]/thanks/page.tsx");
  is("the thanks page hands on the checkout's own currency, not the store's fallback", thanks.includes("amountCents: order.amount, currency: order.record.currency,"), true);
  is("and shows the rest in person only in the currency read", thanks.includes("const dueIn = order.state === \"paid\" ? chargedIn(order.record.currency) : null;") && !/order\.currency \|\| store\.currency/.test(thanks), true);

  part("A membership with no total_details: what came off is read from the price before discounts");
  const now = Math.floor(Date.now() / 1000);
  const base = { object: "checkout.session", status: "complete", payment_status: "paid", currency: "usd", created: now, customer_details: { email: "buyer@example.com" }, mode: "subscription" };
  const paidLine = (session: unknown) => (confirmationFor(store, session as never, now, [], [clubListing])?.text ?? "").split("\n").find((l) => l.startsWith("Paid:")) ?? "";
  const bare = { ...base, id: "cs_test_amountfollowbare1", amount_subtotal: 2000, amount_total: 1000, total_details: null, discounts: null, metadata: { store: "bela", product: club.product.id } };
  is("$20 before discounts, $10 charged: never \"$10 a month\"", /\$10 a month/.test(paidLine(bare)), false);
  is(
    "today's amount, the regular price, and that the discount may go on",
    paidLine(bare),
    "Paid: $10 today, with your discount. Each charge after this one: $20 a month, less your discount for as long as it lasts.",
  );
  is("the same with total_details left out", paidLine({ ...bare, total_details: undefined, discounts: undefined }), paidLine(bare));
  for (const [label, subtotal] of [["no price before discounts", undefined], ["one as text", "2000"], ["a fractional one", 1999.5], ["a negative one", -1]] as const) {
    is(`${label}, and no total_details: not confirmed yet`, confirmationFor(store, { ...bare, amount_subtotal: subtotal } as never, now, [], [clubListing]), null);
  }
  is("control: nothing came off", paidLine({ ...bare, amount_total: 2000 }), "Paid: $20 a month");
  is("control: tax on top is not a discount", paidLine({ ...bare, amount_total: 2160 }), "Paid: $21.60 a month");

  part("The thanks page says it as the email does");
  const firstChargeSaid = (purchaseEmail as unknown as { firstChargeSaid?: (s: Store, session: unknown, product: Listing) => string | null }).firstChargeSaid;
  is("there is one reader for it", typeof firstChargeSaid, "function");
  const said = (session: unknown) => (firstChargeSaid ? firstChargeSaid(store, session, clubListing) : "missing");
  const half = { ...base, id: "cs_test_amountfollowhalf1", amount_subtotal: 2000, amount_total: 1000, total_details: { amount_discount: 1000, amount_shipping: 0, amount_tax: 0 } };
  is("the store sale: today's amount, then the regular price", said({ ...half, metadata: { store: "bela", product: club.product.id, sale: "50" } }), "$10 today, with your discount. Each charge after this one: $20 a month.");
  is("no total_details, $10 of $20: the same as the email", said(bare), "$10 today, with your discount. Each charge after this one: $20 a month, less your discount for as long as it lasts.");
  is("what came off does not read: \"unread\", so no price is said", said({ ...half, total_details: { amount_discount: "1000" } }), "unread");
  is("nothing came off: null, the price is said as before", said({ ...half, amount_total: 2000, total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 } }), null);
  is("an introductory price: null, said as before", said({ ...half, metadata: { store: "bela", product: club.product.id, intro: "3", intro_cents: "500", regular_cents: "2000" } }), null);
  is(
    "the page drops \"for $10 a month\" for it and shows the sentence in its own box",
    [thanks.includes("const firstChargeLine ="), thanks.includes("data-first-charge"), thanks.includes("firstChargeLine !== null ? \"\" : t.forPrice(")],
    [true, true, true],
  );

  done();
}

void main();
