/**
 * What a store kept, by currency (18 October 2026; ClickFunnels audit F51,
 * F52, priority 4): orders, renewals, refunds and disputes reconciled per
 * currency, never converted or added across currencies; the money with no
 * channel shown; an incomplete reading never shown as a total; no claim that
 * a channel caused a sale. Run against a stand-in for Stripe.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { keptIn, keptByCurrency, windowStarts, DISPUTE_TAKES, type Readings } from "@/lib/retained-revenue";
import { readSales, readStats, studioStats } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { KeptByCurrency } from "@/components/kept-by-currency";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

part("The rule, on what it is handed");
const day = "2026-10-13";
const full = (): Readings => ({
  sales: {
    complete: true,
    entries: [
      { day, cents: 5000, currency: "usd", source: "instagram" },
      { day, cents: 3000, currency: "usd", source: "" },
      { day, cents: 2000, currency: "eur", source: "tiktok" },
      { day: "2026-01-01", cents: 9999, currency: "usd", source: "instagram" },
    ],
  },
  renewals: { complete: true, entries: [{ day, cents: 1500, currency: "usd", source: "unrecorded" }, { day, cents: 700, currency: "eur", source: "" }] },
  refunds: { complete: true, entries: [{ day, cents: 1000, currency: "usd", source: "instagram" }] },
  disputes: { complete: true, entries: [{ day, cents: 3000, currency: "usd", source: "" }, { day, cents: 2000, currency: "eur", source: "tiktok" }] },
});
const w = keptIn(full(), "2026-10-07", "usd");
const usd = w.lines.find((l) => l.currency === "usd")!;
const eur = w.lines.find((l) => l.currency === "eur")!;
is("the store's own currency comes first", w.lines.map((l) => l.currency), ["usd", "eur"]);
is("orders, renewals, refunds and disputes reconcile in dollars", [usd.salesCents, usd.renewalCents, usd.refundCents, usd.disputeCents, usd.keptCents], [8000, 1500, 1000, 3000, 5500]);
is("and in euros on their own line, never converted", [eur.salesCents, eur.renewalCents, eur.disputeCents, eur.keptCents], [2000, 700, 2000, 700]);
is("a sale before the window is left out", usd.sales, 2);
is("kept by channel, store currency only, biggest first", w.byChannel, [{ source: "instagram", keptCents: 4000 }, { source: "unrecorded", keptCents: 1500 }]);
is("money with no channel is visible: direct net zero, unrecorded renewals", w.unattributed, { direct: 0, unrecorded: 1500 });
for (const reading of ["refunds", "disputes", "renewals", "sales"] as const) {
  const r = full();
  if (reading === "sales") r.sales.complete = false;
  else r[reading]!.complete = false;
  const kept = keptIn(r, "2026-10-07", "usd");
  is(`an incomplete ${reading} reading shows no kept figure and names itself`, [kept.lines.every((l) => l.keptCents === null), kept.lines[0].missing, kept.byChannel], [true, [reading], null]);
}
const unread = full();
unread.disputes = null;
is("disputes that could not be read are missing, not zero", keptIn(unread, "2026-10-07", "usd").lines[0].missing, ["disputes"]);
const noStripe = full();
noStripe.renewals = null;
is("a store with no Stripe account has no renewals to read, and is not held back by them", keptIn(noStripe, "2026-10-07", "usd").lines[0].missing, []);
is("a store paid nothing still shows its currency", keptIn({ sales: { entries: [], complete: true }, renewals: null, refunds: { entries: [], complete: true }, disputes: { entries: [], complete: true } }, "2026-10-07", "gbp").lines.map((l) => [l.currency, l.keptCents]), [["gbp", 0]]);
is("windows start 6, 29 and 89 days back", windowStarts("2026-10-13"), { d7: "2026-10-07", d30: "2026-09-14", d90: "2026-07-16" });
is("a refund bigger than the window's sales gives a negative kept figure, not a hidden one", keptIn({ ...full(), sales: { entries: [], complete: true } }, "2026-10-07", "usd").lines[0].keptCents, 1500 - 1000 - 3000);
is("the dispute states are the affiliate book's", [...DISPUTE_TAKES].sort(), ["lost", "needs_response", "prevented", "under_review"]);
is("every window at once", Object.keys(keptByCurrency(full(), day, "usd")), ["d7", "d30", "d90"]);

process.env.STRIPE_SECRET_KEY = "sk_test_retained_stand_in";
const NOW = Date.parse("2026-10-13T12:00:00Z");
const S = NOW / 1000;
let disputeMode: "ok" | "failed" | "partial" = "ok";
let disputeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[], hasMore = false) => new Response(JSON.stringify({ data, has_more: hasMore }), { status: 200 });
  const session = (id: string, cents: number, currency: string, channel: string, pi: string) => ({
    id, status: "complete", payment_status: "paid", amount_total: cents, currency, created: S, payment_intent: pi,
    customer_details: { email: `${id}@example.com` }, metadata: { store: "kept", product: "p1", ...(channel ? { channel } : {}) },
  });
  if (url.pathname.endsWith("/checkout/sessions")) return list([
    session("cs_test_kept0001", 5000, "usd", "instagram", "pi_kept1"),
    session("cs_test_kept0002", 4000, "usd", "", "pi_kept2"),
    session("cs_test_kept0003", 2500, "eur", "tiktok", "pi_kept3"),
  ]);
  if (url.pathname.endsWith("/refunds")) return list([{ id: "re_kept1", status: "succeeded", amount: 1000, currency: "usd", created: S, payment_intent: "pi_kept1" }]);
  if (url.pathname.endsWith("/invoices")) return list([{ id: "in_kept1", status: "paid", billing_reason: "subscription_cycle", amount_paid: 1200, currency: "usd", created: S, subscription_details: { metadata: { store: "kept", channel: "youtube" } } }]);
  if (url.pathname.endsWith("/disputes")) {
    disputeCalls++;
    if (disputeMode === "failed") throw Error("dispute service unavailable");
    return list([
      { id: `dp_${disputeCalls}a`, status: "lost", amount: 4000, currency: "usd", created: S, payment_intent: "pi_kept2" },
      { id: `dp_${disputeCalls}b`, status: "won", amount: 5000, currency: "usd", created: S, payment_intent: "pi_kept1" },
      { id: `dp_${disputeCalls}c`, status: "warning_needs_response", amount: 5000, currency: "usd", created: S, payment_intent: "pi_kept1" },
      { id: `dp_${disputeCalls}d`, status: "needs_response", amount: 2500, currency: "eur", created: S, payment_intent: { id: "pi_kept3" } },
    ], disputeMode === "partial");
  }
  return list([]);
}) as typeof fetch;

async function main() {
  redis.clear();
  const owner = "kept-owner@example.com";
  await claimHandle(owner, "kept", "Kept", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestKept001", true);
  const store = (await storeForEmail(owner))!;

  part("Read from Stripe, reconciled per currency");
  const sales = (await readSales(store, NOW))!;
  const d7 = sales.keptIn!.d7;
  const usd = d7.lines.find((l) => l.currency === "usd")!;
  const eur = d7.lines.find((l) => l.currency === "eur")!;
  is("dollars: paid, renewals, refunded, disputed (lost only; won and an inquiry take nothing)", [usd.salesCents, usd.renewalCents, usd.refundCents, usd.disputeCents, usd.keptCents], [9000, 1200, 1000, 4000, 5200]);
  is("euros on their own line with their own dispute, never added to dollars", [eur.salesCents, eur.disputeCents, eur.keptCents], [2500, 2500, 0]);
  is("disputes by the channel of the sale disputed", sales.disputesIn!.d7, [{ source: "", disputes: 1, cents: 4000 }]);
  is("a complete dispute reading says so", sales.disputesComplete, true);
  is("money with no channel recorded is shown, not folded away", d7.unattributed, { direct: 0, unrecorded: 0 });
  is("kept by channel", d7.byChannel, [{ source: "instagram", keptCents: 4000 }, { source: "youtube", keptCents: 1200 }]);
  const stats = (await readStats(store, NOW))!;
  const panel = studioStats(store, stats, sales, "ok", []);
  is("the panel's data carries the figures, nothing about a buyer", [panel.kept?.d7.lines.length, panel.disputesComplete, /@/.test(JSON.stringify(panel.kept))], [2, true, false]);

  part("What the page says");
  const html = renderToStaticMarkup(createElement(KeptByCurrency, { data: panel, range: "d7" }));
  is("one line per currency, in its own money", html.includes(">$52<") && html.includes(">€0<") && html.includes(">eur<") && html.includes("−€25"), true);
  is("says nothing is converted", html.includes("Nothing is converted and currencies are never added together"), true);
  is("says a channel is not a cause", html.includes("does not show that the channel caused the sale"), true);
  is("says what disputed means", html.includes("before Stripe&#x27;s dispute fee"), true);
  is("makes no lift or profit claim", /\b(lift|profit|caused by)\b/i.test(html.replace("not a measure of lift", "")), false);

  part("A dispute outage is unknown, not zero");
  disputeMode = "failed";
  const failed = (await readSales(store, NOW))!;
  is("no kept figure and the reason", [failed.keptIn!.d7.lines[0].keptCents, failed.keptIn!.d7.lines[0].missing, failed.disputesIn, failed.disputesComplete], [null, ["disputes"], null, false]);
  const failedPanel = studioStats(store, stats, failed, "ok", []);
  const failedHtml = renderToStaticMarkup(createElement(KeptByCurrency, { data: failedPanel, range: "d7" }));
  is("the page says which reading is missing", failedHtml.includes("disputes could not all be read"), true);
  is("other figures still show", failed.totals.d7.cents, 9000);
  disputeMode = "partial";
  disputeCalls = 0;
  const partial = (await readSales(store, NOW))!;
  is("the page limit stops a complete claim after three pages", [partial.disputesComplete, disputeCalls, partial.keptIn!.d7.lines[0].keptCents], [false, 3, null]);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
