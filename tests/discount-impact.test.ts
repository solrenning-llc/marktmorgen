/**
 * Discounts beside full price (lib/discount-impact.ts; added 12 October
 * 2026). Checked:
 *
 *   - each checkout is grouped by the discount it had, from the store's own
 *     note of it and what Stripe took off;
 *   - sales, revenue, what was given off, refunds and buyers who bought
 *     again, for the last 90 days only, in the store's currency, without
 *     one-click extras or tips;
 *   - nothing to show when no sale had a discount;
 *   - worked out while the sales are read, with nothing more asked of Stripe;
 *   - members by how they joined: full price first, then each discount.
 */
import { discountElsewhere, discountImpact, discountKindOf, elsewhereWords, entryOf, type DiscountSale } from "@/lib/discount-impact";
import { type Sub, entriesFrom } from "@/lib/membership-numbers";
import { keptNumbersCopy, openKeptNumbers } from "@/lib/api-numbers";
import { readSales, studioStats, type Stats } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_discount_impact_only";

const DAY = 86_400_000;
const NOW = Date.now();
const asked: string[] = [];
let sessions: Record<string, unknown>[] = [];
let refunds: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  asked.push(path);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (path === "/checkout/sessions") return json({ object: "list", data: sessions, has_more: false });
  if (path === "/refunds") return json({ object: "list", data: refunds, has_more: false });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const checkout = (email: string, daysAgo: number, paid: number, off: number, meta: Record<string, string> = {}, pi = "") => ({
  created: NOW - daysAgo * DAY,
  cents: paid,
  currency: "usd",
  upsell: false,
  paymentIntent: pi,
  row: { customer_details: { email }, total_details: { amount_discount: off }, metadata: { store: "harbor", product: "guide", ...meta } },
});

async function main(): Promise<void> {
  redis.clear();

  part("Which discount a sale had");
  const row = (meta: Record<string, string>, off = 0) => ({ metadata: meta, total_details: { amount_discount: off } });
  is(
    "from the store's own note, else what Stripe took off",
    [discountKindOf(row({})), discountKindOf(row({}, 500)), discountKindOf(row({ code: "SPRING" }, 500)), discountKindOf(row({ sale: "20" }, 400)), discountKindOf(row({ fair: "IN:40" }, 800)), discountKindOf(row({ intro: "3" }, 1500)), discountKindOf(row({ winback: "yes" }, 1000))],
    ["full", "code", "code", "sale", "fair", "intro", "comeback"],
  );

  part("Full price beside each discount");
  const sales: DiscountSale[] = [
    checkout("ana@example.com", 5, 2000, 0, {}, "pi_full_ana"),
    checkout("ben@example.com", 10, 2000, 0, {}, "pi_full_ben"),
    checkout("cy@example.com", 20, 1500, 500, { code: "SPRING" }, "pi_code_cy"),
    checkout("dee@example.com", 25, 1500, 500, { code: "SPRING" }, "pi_code_dee"),
    checkout("dee@example.com", 25, 1500, 500, { code: "SPRING" }, "pi_code_dee2"),
    // Dee came back later, at full price.
    checkout("dee@example.com", 3, 2000, 0, {}, "pi_full_dee"),
    // A one-click extra, a tip, another currency and a sale from before the 90 days are left out.
    { ...checkout("cy@example.com", 20, 900, 0), upsell: true },
    checkout("eve@example.com", 4, 500, 0, { kind: "tip" }),
    { ...checkout("fay@example.com", 4, 2000, 0), currency: "eur" },
    checkout("gus@example.com", 120, 1500, 500, { code: "OLD" }),
  ];
  const rows = discountImpact(sales, new Set(["pi_code_cy"]), "usd", NOW);
  is("each group's sales, revenue, what was given off, refunded, and buyers who bought again", rows, [
    { kind: "full", sales: 3, cents: 6000, off: 0, refunded: 0, buyers: 3, again: 0 },
    { kind: "code", sales: 3, cents: 4500, off: 1500, refunded: 1, buyers: 2, again: 1 },
  ]);
  is("nothing to set beside full price, nothing shown", discountImpact([checkout("ana@example.com", 5, 2000, 0)], new Set(), "usd", NOW), null);

  part("Sales in another currency: totals per currency, never converted (22 [E5] unit 2)");
  const abroad: DiscountSale[] = [
    ...sales,
    { ...checkout("hal@example.com", 6, 1800, 200, { code: "SPRING" }), currency: "eur" },
    { ...checkout("ivy@example.com", 7, 1600, 0), currency: "gbp" },
    { ...checkout("jo@example.com", 8, 1200, 300, { sale: "20" }), currency: "gbp" },
    // Left out abroad too: a one-click extra, a tip, a sale from before the 90 days, and a currency that is no code.
    { ...checkout("kit@example.com", 6, 900, 0), currency: "eur", upsell: true },
    { ...checkout("lee@example.com", 6, 500, 0, { kind: "tip" }), currency: "eur" },
    { ...checkout("max@example.com", 120, 1500, 500, { code: "OLD" }), currency: "eur" },
    { ...checkout("ned@example.com", 6, 1500, 0), currency: "" },
    { ...checkout("ola@example.com", 6, 1500, 0), currency: "EUR " },
  ];
  is("the store's own table is unchanged by sales elsewhere", discountImpact(abroad, new Set(["pi_code_cy"]), "usd", NOW), rows);
  is("each other currency on its own, in code order, its own amounts only", discountElsewhere(abroad, "usd", NOW), [
    { currency: "eur", sales: 2, cents: 3800, discounted: 1, off: 200 },
    { currency: "gbp", sales: 2, cents: 2800, discounted: 1, off: 300 },
  ]);
  is("nothing elsewhere, nothing listed", discountElsewhere(sales.filter((s) => s.currency === "usd"), "usd", NOW), []);
  is(
    "said in each currency's own money, never added to the table's",
    elsewhereWords(discountElsewhere(abroad, "usd", NOW)),
    "Sales paid in another currency are not added to the table, because amounts in two currencies do not add up: €38 from 2 sales, 1 with a discount taking €2 off; £28 from 2 sales, 1 with a discount taking £3 off.",
  );
  is("one sale, no discount", elsewhereWords([{ currency: "jpy", sales: 1, cents: 3000, discounted: 0, off: 0 }]), "Sales paid in another currency are not added to the table, because amounts in two currencies do not add up: ¥3,000 from 1 sale.");
  is("no sentence when there is nothing elsewhere", elsewhereWords([]), null);

  // The numbers kept for the API (lib/api-numbers.ts) take the per-currency totals in their checked shape, and a copy kept before they existed still opens.
  const keptStore = { sid: "discount-elsewhere", statsId: "e".repeat(32), handle: "discount-elsewhere", name: "Elsewhere", currency: "usd", links: [] } as unknown as Parameters<typeof keptNumbersCopy>[0];
  const kept = (discounts: unknown) => {
    const empty = { visitors: 0, views: 0, checkouts: 0, sources: [], mediums: [], campaigns: [], checkoutsByProduct: {}, viewsByProduct: {}, linkClicks: {}, countries: [], devices: [], checkoutsBySource: [], freeBySource: [], reach: {}, heard: {}, searchMisses: [] };
    const none = { visitors: 0, views: 0, checkouts: 0 };
    const data = studioStats(keptStore, { days: [], windows: { d7: empty, d30: empty, d90: empty }, previous: { d7: none, d30: none, d90: none }, life: null } as unknown as Stats, null, "none", []);
    (data as { discounts?: unknown }).discounts = discounts;
    const raw = keptNumbersCopy(keptStore, "plain", data, NOW);
    return raw ? openKeptNumbers(keptStore, "plain", raw, NOW) !== null : null;
  };
  const tableRows = discountImpact(sales, new Set(), "usd", NOW);
  is("kept numbers: with totals elsewhere, without them (kept before), and a malformed one refused", [
    kept({ rows: tableRows, refundsRead: true, elsewhere: discountElsewhere(abroad, "usd", NOW) }),
    kept({ rows: tableRows, refundsRead: true }),
    kept({ rows: tableRows, refundsRead: true, elsewhere: [{ currency: "eur", sales: 1, cents: "3800", discounted: 0, off: 0 }] }),
    kept({ rows: tableRows, refundsRead: true, elsewhere: [{ currency: "eur", sales: 1, cents: 3800, off: 0 }] }),
  ], [true, true, false, false]);

  part("Worked out while the sales are read");
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  const store = (await storeForEmail("owner@example.com"))!;
  const session = (id: string, email: string, daysAgo: number, paid: number, off: number, meta: Record<string, string> = {}) => ({
    id,
    status: "complete",
    payment_status: "paid",
    amount_total: paid,
    currency: "usd",
    created: Math.floor((NOW - daysAgo * DAY) / 1000),
    payment_intent: `pi_${id.slice(8)}`,
    customer_details: { email },
    total_details: { amount_discount: off, amount_tax: 0 },
    metadata: { store: "harbor", product: "guide", ...meta },
  });
  sessions = [
    session("cs_test_full00000001", "ana@example.com", 2, 2000, 0),
    session("cs_test_sale00000001", "ben@example.com", 6, 1600, 400, { sale: "20" }),
  ];
  refunds = [{ id: "re_1", status: "succeeded", amount: 1600, currency: "usd", created: Math.floor((NOW - DAY) / 1000), payment_intent: "pi_sale00000001" }];
  const read = await readSales(store, NOW);
  is("in the sales the studio reads", read?.discounts, {
    rows: [
      { kind: "full", sales: 1, cents: 2000, off: 0, refunded: 0, buyers: 1, again: 0 },
      { kind: "sale", sales: 1, cents: 1600, off: 400, refunded: 1, buyers: 1, again: 0 },
    ],
    refundsRead: true,
    elsewhere: [],
  });
  is("with nothing more asked of Stripe than the sales, renewals, refunds and disputes the numbers read anyway", [...new Set(asked)].sort(), ["/checkout/sessions", "/disputes", "/invoices", "/payment_intents", "/refunds"]);

  part("Members by how they joined");
  is("from what the checkout wrote on the membership", [entryOf({}), entryOf({ intro: "3" }), entryOf({ winback: "yes" }), entryOf({ discount: "code" }), entryOf({ discount: "sale" }), entryOf({ discount: "x" })], ["full", "intro", "comeback", "code", "sale", "full"]);
  const now = Math.floor(NOW / 1000);
  const sub = (start: number, ended: number, entry: Sub["entry"]): Sub => ({
    id: "sub_x", status: ended ? "canceled" : "active", product: "club", amount: 2000, currency: "usd", interval: "month", count: 1,
    start: now - start * 86_400, ended: ended ? now - ended * 86_400 : 0, trialEnd: 0, channel: "direct", entry, canceledAt: 0, cancelCause: "", feedback: "", comment: "",
  });
  const entries = entriesFrom([sub(200, 0, "full"), sub(150, 0, "full"), sub(200, 160, "intro"), sub(180, 0, "intro"), sub(20, 0, "code")], now);
  is("full price first, then each discount, with who stayed three months in", entries.map((e) => [e.entry, e.started, e.running, e.stayed3]), [
    ["full", 2, 2, 1],
    ["code", 1, 1, null],
    ["intro", 2, 1, 0.5],
  ]);
  is("none at all with no discount", entriesFrom([sub(200, 0, "full")], now), []);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
