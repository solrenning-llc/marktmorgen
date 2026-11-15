/**
 * What the buyers of a product also bought (added 10 October 2026), counted
 * from the store's own paid sales and nothing else.
 *
 * Amazon's "frequently bought together" is one of the oldest ways a shop sells
 * more; Gumroad, Stan, Kajabi and Hotmart product pages have nothing like it.
 * Here it is measured, not guessed, and said only as what was measured:
 *
 *   - Read with the store's all-time sales (lib/stats.ts, readAllTimeSales),
 *     from the creator's own Stripe account: the product of each paid
 *     checkout, the ones added to it, and the ones taken in one click after.
 *   - Grouped by buyer, by the address they paid with, so "also bought" means
 *     the same person bought both, in one checkout or in two. Each buyer
 *     counts once for each pair, however often they bought.
 *   - Said only from MIN_TOGETHER buyers up, so nobody's own purchase can be
 *     read off a page, and as "N buyers bought both" — exactly the count.
 *   - Shown only by a store whose creator chose to show what was bought
 *     (StoreLook.sold), kept with those counts (lib/sold-count.ts).
 */
import { BUMP_KEYS } from "@/lib/bundle-rules";

/** Below this many buyers of both, nothing is said. */
export const MIN_TOGETHER = 3;
/** How many other products are kept for each product. */
export const TOGETHER_KEPT = 6;

/** For each product: the other products its buyers bought, with how many buyers bought both, most first. */
export type Together = Record<string, [string, number][]>;

type SaleRow = { product: string; row: Record<string, unknown>; upsell: boolean };

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Who bought: the address they paid with, or the customer, or else the sale alone. */
function buyerOf(sale: SaleRow): string {
  const row = sale.row;
  const details = row.customer_details && typeof row.customer_details === "object" ? (row.customer_details as Record<string, unknown>) : {};
  const email = text(details.email) || text(row.customer_email) || text(row.receipt_email);
  if (email) return `e:${email.trim().toLowerCase()}`;
  const customer = text(row.customer);
  if (customer) return `c:${customer}`;
  return `s:${text(row.id)}`;
}

/** What one sale bought: its product and, for a checkout, the ones added to it. */
function productsOf(sale: SaleRow): string[] {
  const meta = sale.row.metadata && typeof sale.row.metadata === "object" ? (sale.row.metadata as Record<string, unknown>) : {};
  const out = [sale.product, ...(sale.upsell ? [] : BUMP_KEYS.map((key) => text(meta[key])))];
  return out.filter((id) => id !== "");
}

/** The pairs, counted from paid sales. */
export function togetherFrom(sales: SaleRow[]): Together {
  const bought = new Map<string, Set<string>>();
  for (const sale of sales) {
    const who = buyerOf(sale);
    const set = bought.get(who) ?? new Set<string>();
    for (const id of productsOf(sale)) set.add(id);
    bought.set(who, set);
  }
  const counts = new Map<string, Map<string, number>>();
  for (const set of bought.values()) {
    if (set.size < 2 || set.size > 200) continue;
    for (const a of set) {
      const row = counts.get(a) ?? new Map<string, number>();
      for (const b of set) if (b !== a) row.set(b, (row.get(b) ?? 0) + 1);
      counts.set(a, row);
    }
  }
  // A product id is read from the sale's metadata, which the creator's own Stripe account can set to anything, even
  // "__proto__": gathered in a Map and handed on as a plain record of own keys only (tests/proto-keys.test.ts).
  const out = new Map<string, [string, number][]>();
  for (const [a, row] of counts) {
    const kept = [...row.entries()]
      .filter(([, n]) => n >= MIN_TOGETHER)
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .slice(0, TOGETHER_KEPT);
    if (kept.length) out.set(a, kept);
  }
  return Object.fromEntries(out);
}

/** Whatever came back from storage, made safe to use. */
export function parseTogether(raw: unknown): Together {
  if (!raw || typeof raw !== "object") return {};
  const out = new Map<string, [string, number][]>();
  for (const [id, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const kept = list
      .filter((pair): pair is [string, number] => Array.isArray(pair) && typeof pair[0] === "string" && Number.isInteger(pair[1]) && (pair[1] as number) >= MIN_TOGETHER)
      .slice(0, TOGETHER_KEPT);
    if (kept.length) out.set(id, kept);
  }
  return Object.fromEntries(out);
}
