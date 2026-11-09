/**
 * Two readings of a store's Stripe checkouts that stop at a page ceiling, and
 * what they say when they stop (CX-123 rule 24; VR 2):
 *
 * 1. The numbers (lib/stats.ts, readPaidSales): only completed checkouts are
 *    asked for (status=complete, as lib/checkout-sweep.ts and lib/calls.ts
 *    ask), so a store's open and expired checkouts no longer use up the pages
 *    before its paid sales are reached. A store with more completed checkouts
 *    than the pages hold is still said to be partial.
 * 2. The bookings (lib/calls.ts, paidCalls, which stops after its pages): the
 *    readers that show them say when the list may be missing some — the API
 *    (`complete`), the calendar feed (a note in the file) and the buyer's
 *    orders page and link (lib/buyer-orders.ts, callsForRead). Nothing is
 *    refused for it.
 *
 * Synthetic stores and a stand-in for Stripe only.
 */
import { readPaidSales } from "@/lib/stats";
import * as calendar from "@/lib/calendar-sync";
import * as buyerOrders from "@/lib/buyer-orders";
import { ordersWords } from "@/lib/buyer-words/orders";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { KIND } from "@/lib/catalog";
import { makeKey } from "@/lib/api-keys";
import { GET as bookingsRead } from "@/app/api/v1/bookings/route";
import { GET as feedRoute } from "@/app/api/store/calendar/[token]/route";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";

// Read through the modules, so the test runs (and fails on its checks) before they have these.
const { bookedCalendar, newFeedToken } = calendar;
const PARTIAL_FEED_NOTE = String((calendar as Record<string, unknown>).PARTIAL_FEED_NOTE ?? "(none yet)");
const callsForRead = async (store: Store, email: string): Promise<{ calls: unknown[]; partial: boolean | null }> => {
  const read = (buyerOrders as Record<string, unknown>).callsForRead as ((s: Store, e: string) => Promise<{ calls: unknown[]; partial: boolean }>) | undefined;
  return read ? read(store, email) : { calls: await buyerOrders.callsFor(store, email), partial: null };
};
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_sales_reads_complete_only";

const NOW = Math.floor(Date.now() / 1000);
type Session = Record<string, unknown> & { id: string; created: number; status: string };

/** The sessions Stripe holds in "listed" mode; in "busy" mode every page is full and says there are more. */
let sessions: Session[] = [];
let busy = false;
/** Every checkout-list request, as asked. */
let asked: URL[] = [];

function listSessions(url: URL): Response {
  asked.push(url);
  const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 10));
  const status = url.searchParams.get("status");
  const after = url.searchParams.get("starting_after");
  if (busy) {
    const from = after ? Number(after.replace("cs_busy_", "")) + 1 : 0;
    const data = Array.from({ length: limit }, (_, i) => ({ id: `cs_busy_${from + i}`, object: "checkout.session", status: "complete", payment_status: "paid", created: NOW - 60 - from - i, metadata: {}, amount_total: 500, currency: "usd" }));
    return Response.json({ object: "list", data, has_more: true });
  }
  const since = Number(url.searchParams.get("created[gte]") ?? 0);
  const order = (a: Session, b: Session) => b.created - a.created || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const all = [...sessions].sort(order);
  let rows = all.filter((row) => row.created >= since && (!status || row.status === status));
  if (after) {
    const anchor = all.find((row) => row.id === after);
    if (!anchor) return Response.json({ error: { type: "invalid_request_error" } }, { status: 400 });
    rows = rows.filter((row) => order(anchor, row) < 0);
  }
  return Response.json({ object: "list", data: rows.slice(0, limit), has_more: rows.length > limit });
}

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.pathname === "/v1/checkout/sessions") return listSessions(url);
  return Response.json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function stripeStore(handle: string): Promise<{ owner: string; store: () => Promise<Store> }> {
  const owner = `${handle}@example.com`;
  await claimHandle(owner, handle, `Store ${handle}`, "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${handle.replace(/-/g, "")}0000`, subscriptionId: `sub_${handle.replace(/-/g, "")}0000`, active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  await setStripeAccount(owner, `acct_1${handle.replace(/-/g, "")}00`, true);
  return { owner, store: async () => (await storeForEmail(owner))! };
}

async function main(): Promise<void> {
  part("The numbers ask Stripe only for completed checkouts, so open and expired ones do not use up the pages");
  const sales = await stripeStore("sales-reads");
  const store = await sales.store();
  const unpaid = (i: number): Session => ({ id: `cs_open_${String(i).padStart(3, "0")}`, object: "checkout.session", status: i % 2 ? "open" : "expired", payment_status: "unpaid", created: NOW - 100 - i, metadata: { store: "sales-reads", product: "guide" }, amount_total: 1200, currency: "usd" });
  const paid: Session = { id: "cs_paid_1", object: "checkout.session", status: "complete", payment_status: "paid", created: NOW - 5000, metadata: { store: "sales-reads", product: "guide" }, amount_total: 1200, currency: "usd" };
  sessions = [...Array.from({ length: 250 }, (_, i) => unpaid(i)), paid];
  busy = false;
  asked = [];
  const read = await readPaidSales(store, 0, 2);
  is("every list request asks for completed checkouts only", asked.length > 0 && asked.every((u) => u.searchParams.get("status") === "complete"), true);
  is("the paid sale behind 250 unpaid checkouts is read, and the reading is whole", [read.sales.map((s) => s.paymentIntent || s.cents), read.partial], [[1200], false]);
  is("one page was enough", asked.length, 1);

  part("A store with more completed checkouts than the pages hold is still said to be partial");
  busy = true;
  asked = [];
  const capped = await readPaidSales(store, 0, 2);
  is("partial, after its two pages", [capped.partial, asked.length], [true, 2]);
  is("readSales keeps its own status filter in lib/stats.ts", readFileSync("lib/stats.ts", "utf8").includes('walk("/checkout/sessions?limit=100&status=complete"'), true);

  part("The API's bookings say when the list may be missing some");
  const api = await stripeStore("bookings-partial");
  const made = await makeKey((await api.store()).sid, "Synthetic reader");
  if (!made.ok) throw new Error("no synthetic key");
  const get = () => bookingsRead(new Request("https://marktmorgen.com/api/v1/bookings", { headers: { Authorization: `Bearer ${made.key}` } }));
  busy = true;
  const partialBody = await (await get()).json();
  is("a reading that stopped at its pages: complete false, the rows it read still given", [partialBody.complete, Array.isArray(partialBody.data)], [false, true]);
  busy = false;
  sessions = [];
  const wholeBody = await (await get()).json();
  is("a whole reading: complete true", [wholeBody.complete, wholeBody.data], [true, []]);
  const fieldsBody = await (await bookingsRead(new Request("https://marktmorgen.com/api/v1/bookings?fields=id", { headers: { Authorization: `Bearer ${made.key}` } }))).json();
  is("?fields= keeps the flag", fieldsBody.complete, true);
  const docs = readFileSync("app/developers/page.tsx", "utf8").split('<LegalSection title="Bookings">')[1]?.split("</LegalSection>")[0] ?? "";
  is("the developer page's Bookings block shows and explains the flag", [docs.includes('"complete": true'), /When <code className="font-mono">complete<\/code> is <code className="font-mono">false<\/code>/.test(docs)], [true, true]);

  part("The calendar feed says so in the file when the bookings could not all be read");
  const feedStore = await stripeStore("feed-partial");
  const noted = (bookedCalendar as (...args: unknown[]) => string)(await feedStore.store(), [], Date.now(), [], new Map(), true);
  is("bookedCalendar with partial: the note as the calendar's description and as an all-day note that blocks no time", [noted.includes("X-WR-CALDESC:"), noted.includes("TRANSP:TRANSPARENT"), noted.replace(/\r\n /g, "").includes(PARTIAL_FEED_NOTE.replace(/,/g, "\\,"))], [true, true, true]);
  const whole = bookedCalendar(await feedStore.store(), [], Date.now(), [], new Map());
  is("without: no note", [whole.includes("X-WR-CALDESC:"), whole.includes("TRANSP:TRANSPARENT")], [false, false]);
  const url = (await newFeedToken(await feedStore.store())).subscribeUrl ?? "";
  const token = url.slice(url.lastIndexOf("/") + 1);
  busy = true;
  const answer = await feedRoute(new Request(url), { params: Promise.resolve({ token }) });
  const ics = await answer.text();
  is("the real route, Stripe with more than its pages: the file is answered, with the note", [answer.status, ics.includes("X-WR-CALDESC:")], [200, true]);

  part("The buyer's orders: a booking list that may be missing some is said, and the link is still sent");
  const buyer = await stripeStore("orders-partial");
  const base = await buyer.store();
  const selling = { ...base, catalog: { ...base.catalog, items: [...base.catalog.items, { ...(base.catalog.items[0] ?? {}), id: "call1", kind: KIND.call | KIND.paid }] } } as Store;
  busy = true;
  const partialCalls = await callsForRead(selling, "bo.buyer@example.com");
  is("callsForRead: partial, with what it could read", [partialCalls.partial, partialCalls.calls], [true, []]);
  busy = false;
  sessions = [];
  const wholeCalls = await callsForRead(selling, "bo.buyer@example.com");
  is("a whole reading is not partial", wholeCalls.partial, false);
  for (const code of LANGUAGE_CODES) {
    const words = ordersWords(code) as Record<string, unknown>;
    const some = typeof words.ordersIntroSome === "function" ? String(words.ordersIntroSome("Harbor Kitchen")) : "";
    is(`${code}: has the sentence for bookings not all listed, and the email's opening that claims no count`, [typeof words.callsUnlisted === "string" && words.callsUnlisted.length > 20, some.includes("Harbor Kitchen"), /\d/.test(some)], [true, true, false]);
  }
  const page = readFileSync("app/[handle]/orders/page.tsx", "utf8");
  is("the orders page reads callsForRead and shows the sentence", [page.includes("callsForRead(store, email, meter)"), page.includes("{words.callsUnlisted}")], [true, true]);
  const orders = readFileSync("lib/buyer-orders.ts", "utf8");
  is("the link is sent when the bookings were not all read, and its email says so", [orders.includes("calls.partial"), orders.includes("words.callsUnlisted")], [true, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
