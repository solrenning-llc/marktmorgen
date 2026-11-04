/**
 * GET /api/v1/sales: the store's paid checkouts, newest first, read from the
 * creator's own Stripe account as the studio's list of sales reads them
 * (lib/store-checkout.ts, listSales): only settled checkouts of this store
 * (its handle or one it used before) that took a payment or started a
 * membership, and only while the store can sell, as the studio shows them.
 * 630 [HN6](19), unit 1.
 *
 * Each sale is written out field by field, in the shape of the sale.completed
 * webhook's data (lib/webhooks.ts), so a tool reads both the same way: the
 * products checked at checkout in `order_bumps` (the first also as
 * `order_bump`), a bundle's products in `bundle_items`. A one-click extra
 * taken after the checkout (an upsell) is its own payment, not a checkout, so
 * it is not on this list; sale.completed with kind "upsell" tells a tool of
 * each one. What a buyer typed at checkout is not sent here. Beside the
 * webhook's fields, a one-time payment says how much of it was refunded and
 * whether it was disputed, read off its charge (expanded on the same
 * request); a membership's or payment plan's first invoice is not read for
 * that, so both are null there.
 *
 * The cursor is Stripe's own: the id of the last checkout of the page Stripe
 * gave, so a page whose checkouts are all another store's comes back empty
 * with a `next` to go on from. One request to Stripe per call, which may wait
 * on Stripe for its whole ceiling: a call is API_SALES_UNITS of the store's
 * API requests (lib/store-allowance-rules.ts; its cost is API_SALES_READ in
 * tests/plan-cost-registry.ts).
 */
import { isSettled } from "@/lib/instant-pay";
import { onAccount } from "@/lib/stripe-account";
import { saleHandles, type Store } from "@/lib/store";
import { readListings } from "@/lib/catalog";
import { sourceOf } from "@/lib/webhooks";
import { type BundleSlot, bumpsFromMeta, bundleFromMeta } from "@/lib/bundle-rules";
import { MAX_TITLE_LENGTH } from "@/lib/catalog-rules";

/** Checkouts asked of Stripe per call: its own most. */
export const SALES_PAGE = 100;
/**
 * The most different products whose titles one call reads from the store
 * (the products sold first, then those checked at checkout, then a bundle's):
 * past it a title is null, so a page's database read stays bounded.
 */
export const SALES_TITLE_IDS = 200;
const CURSOR = /^cs_[A-Za-z0-9_]{1,250}$/;
/** The longest checkout id, the cursor included: "cs_" and 250 more. */
export const SALES_ID_LENGTH = 253;
/** A product's or an option's id, as the catalog writes them. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const SALES_SAFE_ID_LENGTH = 64;

/**
 * The most characters (UTF-16 units) of each text a sale echoes, cut on the
 * server so a page's answer stays bounded whatever the creator's Stripe
 * account holds: a title as the checkout writes it (480), the utm tags and
 * the site as the checkout writes them (40 and 300), the buyer's name, and
 * an address no longer than an address can be (longer is null, never cut).
 */
export const SALE_TEXT_LIMITS = { title: 480, utm: 40, site: 300, name: 150, email: 254 } as const;

/** Every field of a sale, in the order the answer writes them: what ?fields= may choose. */
export const SALE_FIELDS = [
  "checkout_session", "kind", "product", "option", "bundle_items", "order_bump", "order_bumps", "amount_cents", "discount_cents",
  "currency", "buyer", "opened_at", "paid_at", "refunded_cents", "disputed", "trial", "source",
] as const;

export type SalesPage = { data: Record<string, unknown>[]; next: string | null };

type Row = { id?: unknown; status?: unknown; payment_status?: unknown; mode?: unknown; created?: unknown; payment_intent?: unknown; invoice?: unknown; amount_total?: unknown; currency?: unknown; customer_email?: unknown; customer_details?: unknown; total_details?: unknown; metadata?: Record<string, string> | null };

const cents = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);
/** Seconds as an ISO time; null when not a time a Date can hold (past 8.64e15 ms it would throw), never a RangeError. */
const iso = (seconds: unknown) => (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 && seconds * 1000 <= 8.64e15 ? new Date(seconds * 1000).toISOString() : null);
/**
 * A text cut to `max`: control characters dropped first, a surrogate left
 * alone by the cut (or by the account) dropped after, so every unit left is
 * at most three bytes of the JSON answer. Empty is null.
 */
export function cutText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cut = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, max).replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
  return cut || null;
}
const safeId = (value: unknown) => (typeof value === "string" && SAFE_ID.test(value) ? value : null);
const obj = (value: unknown) => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** The cursor a request sent: none, one of Stripe's checkout ids, or not one (malformed, empty or sent twice). */
export function cursorOf(url: string): { ok: true; cursor: string | null } | { ok: false } {
  const sent = new URL(url).searchParams.getAll("cursor");
  if (sent.length === 0) return { ok: true, cursor: null };
  return sent.length === 1 && CURSOR.test(sent[0]) ? { ok: true, cursor: sent[0] } : { ok: false };
}

type Payment = { paidAt: string | null; refundedCents: number | null; disputed: boolean | null };

/**
 * What the expanded payment says, or null when Stripe's answer is not the
 * one asked for (a payment or invoice left as a bare id, a payment without
 * its charge, a charge without a readable moment or amounts): that is
 * unknown, never "nothing charged".
 *
 * When the buyer paid, never when the checkout page opened (the session's
 * own `created`): the charge of a one-time payment, or the payment of the
 * first invoice of a membership or payment plan. A checkout that charged
 * nothing (a free order) has no payment moment, so its paidAt is null.
 */
export function payment(row: { payment_intent?: unknown; invoice?: unknown }): Payment | null {
  if (typeof row.payment_intent === "string" || typeof row.invoice === "string") return null;
  const intent = obj(row.payment_intent);
  if (intent) {
    const charge = obj(intent.latest_charge);
    if (!charge) return null;
    const paidAt = iso(charge.created);
    const refundedCents = cents(charge.amount_refunded);
    if (!paidAt || refundedCents === null || typeof charge.disputed !== "boolean") return null;
    return { paidAt, refundedCents, disputed: charge.disputed };
  }
  // An invoice not paid yet (a trial's) has no moment; one that cannot be read is unknown.
  const at = obj(obj(row.invoice)?.status_transitions)?.paid_at;
  const paidAt = at === null || at === undefined ? null : iso(at);
  if (at !== null && at !== undefined && !paidAt) return null;
  return { paidAt, refundedCents: null, disputed: null };
}

/** What kind of sale a checkout was, as sale.completed says it. */
export function saleKind(row: { mode?: unknown; metadata?: Record<string, string> | null }): string {
  const kind = row.metadata?.kind;
  if (kind === "call") return "call";
  if (kind === "plan") return "payment_plan";
  if (kind === "tip") return "tip";
  return row.mode === "subscription" ? "membership" : "one_time";
}

/**
 * A sale: a settled checkout that took a payment or started a membership.
 * A checkout that only saved a card (setup mode: a buyer changing the card
 * of a membership, lib/card-update.ts) is complete and owes nothing, and is
 * no sale.
 */
function isSale(row: Row): boolean {
  return isSettled(row) && (row.mode === "payment" || row.mode === "subscription") && row.metadata?.kind !== "card";
}

type Read = { row: Row; paid: Payment; amount: number; discount: number | null; openedAt: string };

/** A sale's money and payment, or null when Stripe's answer for it cannot be read. */
function readSale(row: Row): Read | null {
  const amount = cents(row.amount_total);
  const paid = payment(row);
  // When the checkout page was opened: the order of the list, and what a sync reads back to.
  const openedAt = iso(row.created);
  if (amount === null || !paid || !openedAt) return null;
  // No discount details from Stripe is an unknown discount (null); details that cannot be read make the sale unknown.
  if (row.total_details === null || row.total_details === undefined) return { row, paid, amount, discount: null, openedAt };
  const discount = cents(obj(row.total_details)?.amount_discount);
  return discount === null ? null : { row, paid, amount, discount, openedAt };
}

/**
 * The products whose titles a page reads, at most SALES_TITLE_IDS: the
 * products sold first, then those checked at checkout, then a bundle's.
 */
export function titleIds(metas: Record<string, string>[]): string[] {
  const wanted: string[] = [];
  const want = (id: string | null) => {
    if (id && wanted.length < SALES_TITLE_IDS && !wanted.includes(id)) wanted.push(id);
  };
  for (const m of metas) want(safeId(m.product));
  for (const m of metas) for (const bump of bumpsFromMeta(m)) want(bump.id);
  for (const m of metas) {
    for (const id of bundleFromMeta(m, "bundle")) want(id);
    for (const bump of bumpsFromMeta(m)) for (const id of bundleFromMeta(m, `${bump.key}_bundle`)) want(id);
  }
  return wanted;
}

/** One page of the store's sales, or null when Stripe's answer could not be read whole. */
export async function sales(store: Store, cursor: string | null): Promise<SalesPage | null> {
  if (cursor !== null && !CURSOR.test(cursor)) throw new Error("A sales cursor is checked (cursorOf) before it is sent to Stripe");
  const page = await onAccount("GET", store.stripeAccountId as string, `/checkout/sessions?limit=${SALES_PAGE}&expand[]=data.payment_intent.latest_charge&expand[]=data.invoice${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`);
  // An unreadable list is unknown, never proof of no sales.
  if (typeof page !== "object" || page === null || Array.isArray(page) || !Array.isArray(page.data) || typeof page.has_more !== "boolean" ||
      page.data.length > SALES_PAGE || page.data.some((row: unknown) => typeof row !== "object" || row === null || Array.isArray(row))) return null;
  const rows = page.data as Row[];
  // More to come without a cursor to go on from would look like the end: unknown instead.
  const lastId = rows.length ? rows[rows.length - 1].id : null;
  const last = typeof lastId === "string" && CURSOR.test(lastId) ? lastId : null;
  if (page.has_more === true && !last) return null;
  const handles = saleHandles(store);
  const mine = rows.filter((row) => typeof row.id === "string" && isSale(row) && handles.has(row.metadata?.store ?? ""));
  // One sale that cannot be read makes the page unknown: never a guessed zero, a negative amount or "nothing charged".
  const read: Read[] = [];
  for (const row of mine) {
    const sale = CURSOR.test(row.id as string) ? readSale(row) : null;
    if (!sale) return null;
    read.push(sale);
  }

  const meta = (row: Row): Record<string, string> => row.metadata ?? {};
  const wanted = titleIds(mine.map(meta));
  const titles = new Map((wanted.length ? await readListings(store, wanted) : []).map((p) => [p.id, cutText(p.title, MAX_TITLE_LENGTH)]));
  const product = (id: string) => ({ id, title: titles.get(id) ?? null });
  const inside = (m: Record<string, string>, slot: BundleSlot) => {
    const ids = bundleFromMeta(m, slot);
    return ids.length ? ids.map(product) : null;
  };
  const { title: TITLE, utm: UTM, site: SITE, name: NAME, email: EMAIL } = SALE_TEXT_LIMITS;
  return {
    data: read.map(({ row, paid, amount, discount, openedAt }) => {
      const m = meta(row);
      const details = (obj(row.customer_details) ?? {}) as { email?: unknown; name?: unknown };
      // An address is kept only as it is: longer than an address can be, or holding what cutText drops, it is null, never cut.
      const whole = (e: unknown) => (typeof e === "string" && e.length <= EMAIL && cutText(e, EMAIL) === e ? e : null);
      const email = typeof details.email === "string" && details.email ? whole(details.email) : whole(row.customer_email);
      const productId = safeId(m.product);
      const source = sourceOf(m);
      // Every product checked at checkout, in the order of its boxes; the first also under its old name, as sale.completed sends them.
      const checked = bumpsFromMeta(m).map(({ key, id }) => ({ ...product(id), bundle_items: inside(m, `${key}_bundle`) }));
      return {
        checkout_session: row.id,
        kind: saleKind(row),
        product: { id: productId, title: cutText(m.title, TITLE) ?? (productId ? titles.get(productId) ?? null : null) },
        option: safeId(m.option),
        bundle_items: inside(m, "bundle"),
        order_bump: checked[0] ?? null,
        order_bumps: checked,
        amount_cents: amount,
        discount_cents: discount,
        // Unknown is null, never a guessed currency.
        currency: typeof row.currency === "string" && /^[a-z]{3}$/.test(row.currency) ? row.currency : null,
        buyer: { email, name: cutText(details.name, NAME) },
        opened_at: openedAt,
        paid_at: paid.paidAt,
        refunded_cents: paid.refundedCents,
        disputed: paid.disputed,
        trial: Number(m.trial_days) > 0,
        source: {
          utm_source: cutText(source.utm_source, UTM),
          utm_medium: cutText(source.utm_medium, UTM),
          utm_campaign: cutText(source.utm_campaign, UTM),
          utm_content: cutText(source.utm_content, UTM),
          site: cutText(source.site, SITE),
        },
      };
    }),
    next: page.has_more === true ? last : null,
  };
}
