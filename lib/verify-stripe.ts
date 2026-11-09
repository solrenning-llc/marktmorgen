/**
 * Session packages and membership tiers, run against Stripe itself, every
 * day, by a scheduled job (app/api/cron/stripe-check).
 *
 * In Stripe's test mode, on the demo store's test account (lib/demo-account.ts):
 * no real money, and nothing on any creator's account. Every request is
 * built by the very functions the features use (callCheckoutBody,
 * sessionCouponBody, packageCheckoutBody, tierPriceBody, previewBody,
 * switchBody), so a change that breaks what the site sends breaks here.
 *
 *   tiers     a member moves up, down, and from monthly to yearly: the amount
 *             the member page would show equals what Stripe charges; a
 *             declined card changes nothing and is voided; the tier the doors
 *             read follows the switch
 *   packages  a package's paid checkout and a session's free checkout are
 *             accepted, the free one at $0, and the session's coupon is good
 *             for one use only
 *
 *   documents a checkout that offers the tax number box and draws up an
 *             invoice is accepted, with both switched on as Stripe reads them
 *             (lib/tax.ts)
 *   shipping  a cart with two physical products and a digital one is
 *             accepted with the address asked only in the countries both
 *             ship to and the two shipping amounts added on one line
 *             (lib/cart-shipping.ts, applyCartShipping; added 2 November 2026)
 *
 * Completing the free checkout takes a browser, which a scheduled job has
 * not: that was done by hand on September 30, 2026, and Stripe read it as
 * paid, with nothing charged and the coupon then refused a second time.
 * Everything made here is taken away again at the end of each run.
 */
import { onDemoAccount } from "@/lib/demo-store";
import { callCheckoutBody, NO_COST_VERSION } from "@/lib/calls";
import { packageCheckoutBody, sessionCouponBody } from "@/lib/call-packages";
import { previewBody, switchBody, tierPriceBody } from "@/lib/tier-switch";
import { currentMeta, dueNow, productOfSub } from "@/lib/tier-rules";
import { applyCartShipping, cartItemOf, cartShipping } from "@/lib/cart-shipping";
import type { Listing, Product, Store } from "@/lib/store";

export type Check = { check: string; ok: boolean; detail: string };

type Answer = { status: number; data: Record<string, unknown> };
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" ? v : NaN);
const err = (a: Answer) => str((a.data.error as { message?: unknown } | undefined)?.message);
/**
 * A subscription read back proves a switch only when the reply is that very subscription (rule 30): its own id, equal
 * to the one asked for. Another subscription's reply, or one with no id, fails the check; it never passes it. A body
 * that is not an object (JSON `null`) fails it the same way, without throwing.
 */
const isOwnReply = (a: Answer, id: string): boolean =>
  a.status === 200 && a.data !== null && typeof a.data === "object" && Object.hasOwn(a.data, "id") && a.data.id === id;
const notOwn = (a: Answer, id: string) => (isOwnReply(a, id) ? "" : `Stripe's reply was not ${id}; `);

function tier(id: string, title: string, cents: number, interval: "month" | "year"): Listing {
  return { id, title, priceCents: cents, recurring: { interval, trialDays: 0, payments: 0 } } as unknown as Listing;
}

/** A store as the builders read it: in dollars, without tax or discount codes. */
export function checkStore(): Store {
  return { handle: "stripe-check", name: "Stripe check", currency: "usd", hasDiscounts: false, tax: { enabled: false, included: false } } as unknown as Store;
}

export async function verifyTiers(): Promise<Check[]> {
  const out: Check[] = [];
  const s = checkStore();
  const note = (check: string, ok: boolean, detail: string) => out.push({ check, ok, detail });
  const A = tier("verify-basic", "Verify Basic", 1500, "month");
  const B = tier("verify-plus", "Verify Plus", 3500, "month");
  const C = tier("verify-yearly", "Verify Yearly", 15000, "year");
  const made: string[] = [];
  const customers: string[] = [];
  try {
    const prices: Record<string, string> = {};
    for (const t of [A, B, C]) {
      const p = await onDemoAccount("POST", "/prices", tierPriceBody(s, t));
      if (p.status !== 200) return [...out, { check: `price for ${t.title}`, ok: false, detail: err(p) }];
      prices[t.id] = str(p.data.id);
    }
    note("tier prices accepted, each naming its product", true, Object.values(prices).join(", "));

    const subscribe = async (email: string) => {
      const customer = await onDemoAccount(
        "POST",
        "/customers",
        new URLSearchParams({ email, payment_method: "pm_card_visa", "invoice_settings[default_payment_method]": "pm_card_visa" }),
      );
      if (customer.status === 200) customers.push(str(customer.data.id));
      const sub = await onDemoAccount(
        "POST",
        "/subscriptions",
        new URLSearchParams({ customer: str(customer.data.id), "items[0][price]": prices[A.id], "metadata[store]": s.handle, "metadata[product]": A.id }),
      );
      if (sub.status === 200) made.push(str(sub.data.id));
      const items = (sub.data.items as { data?: { id?: string }[] } | undefined)?.data ?? [];
      return { customer: str(customer.data.id), sub: str(sub.data.id), item: str(items[0]?.id), status: str(sub.data.status), error: err(customer) || err(sub) };
    };

    const move = async (label: string, m: { customer: string; sub: string; item: string }, to: Listing) => {
      const at = Math.floor(Date.now() / 1000);
      const preview = await onDemoAccount("POST", "/invoices/create_preview", previewBody(m.customer, m.sub, m.item, prices[to.id], at));
      if (preview.status !== 200) return note(`${label}: preview`, false, err(preview));
      const shown = dueNow(preview.data as Parameters<typeof dueNow>[0], at);
      const updated = await onDemoAccount("POST", `/subscriptions/${m.sub}`, switchBody(m.item, prices[to.id], at));
      if (updated.status !== 200) return note(`${label}: switch`, false, err(updated));
      const inv = (updated.data.latest_invoice ?? {}) as Record<string, unknown>;
      // What the member's card paid for a charge (after any credit they held);
      // the invoice's total for a credit, which is what goes on their balance.
      const charged = num(inv.total) > 0 ? num(inv.amount_paid) : num(inv.total);
      note(
        `${label}: the amount the member page shows is what Stripe charges`,
        shown === charged && !updated.data.pending_update,
        `shown ${shown}; Stripe's invoice ${num(inv.total)} (${str(inv.status)}), card paid ${num(inv.amount_paid)}; the whole next invoice in the preview was ${num(preview.data.total)}`,
      );
      const after = await onDemoAccount("GET", `/subscriptions/${m.sub}`);
      const now = productOfSub(after.data);
      const meta = currentMeta({ store: s.handle, product: A.id }, { mode: "subscription", subscription: after.data });
      note(
        `${label}: every door now reads the new tier`,
        isOwnReply(after, m.sub) && now === to.id && meta.product === to.id,
        `${notOwn(after, m.sub)}subscription reads ${now}; a checkout bought as ${A.id} now hands over ${meta.product}`,
      );
    };

    const m = await subscribe("verify+tiers@example.com");
    if (!m.sub) return [...out, { check: "test member subscribes", ok: false, detail: m.error }];
    note("test member subscribes to the basic tier", m.status === "active", `status ${m.status}`);
    await move("up, monthly $15 to $35", m, B);
    await move("down, monthly $35 to $15", m, A);
    await move("monthly $15 to yearly $150", m, C);

    // A card that fails when charged: the switch must change nothing and owe nothing.
    const d = await subscribe("verify+declined@example.com");
    if (!d.sub) return [...out, { check: "second test member subscribes", ok: false, detail: d.error }];
    const failing = await onDemoAccount("POST", "/payment_methods/pm_card_chargeCustomerFail/attach", new URLSearchParams({ customer: d.customer }));
    await onDemoAccount("POST", `/customers/${d.customer}`, new URLSearchParams({ "invoice_settings[default_payment_method]": str(failing.data.id) }));
    const at = Math.floor(Date.now() / 1000);
    const refused = await onDemoAccount("POST", `/subscriptions/${d.sub}`, switchBody(d.item, prices[B.id], at));
    const pending = Boolean(refused.data.pending_update);
    const inv = (refused.data.latest_invoice ?? {}) as Record<string, unknown>;
    let voided = "";
    if (pending && str(inv.id)) voided = str((await onDemoAccount("POST", `/invoices/${str(inv.id)}/void`, new URLSearchParams())).data.status);
    const still = await onDemoAccount("GET", `/subscriptions/${d.sub}`);
    note(
      "a declined card changes nothing, and its invoice is voided",
      pending && voided === "void" && isOwnReply(still, d.sub) && productOfSub(still.data) === A.id,
      `${notOwn(still, d.sub)}answer ${refused.status}${err(refused) ? ` (${err(refused)})` : ""}, pending update ${pending}, invoice ${voided || str(inv.status)}, still on ${productOfSub(still.data)}`,
    );
  } finally {
    for (const id of made) await onDemoAccount("DELETE", `/subscriptions/${id}`).catch(() => null);
    for (const id of customers) await onDemoAccount("DELETE", `/customers/${id}`).catch(() => null);
  }
  return out;
}

function sessionProduct(): Product {
  return { id: "verify-call", title: "Verification call", summary: "", priceCents: 12000, fields: [] } as unknown as Product;
}

export async function verifyPackages(origin: string): Promise<Check[]> {
  const s = checkStore();
  const out: Check[] = [];
  const opened: string[] = [];
  const pkgListing = { id: "verify-call", title: "Verification call" } as unknown as Listing;
  try {
    const bought = await onDemoAccount("POST", "/checkout/sessions", packageCheckoutBody(s, pkgListing, { sessions: 5, priceCents: 50000, days: 90 }, origin));
    if (bought.status === 200) opened.push(str(bought.data.id));
    out.push({
      check: "the package's own checkout is accepted, at its price",
      ok: bought.status === 200 && num(bought.data.amount_total) === 50000,
      detail: bought.status === 200 ? `total ${num(bought.data.amount_total)}` : err(bought),
    });

    const coupon = await onDemoAccount("POST", "/coupons", sessionCouponBody("cs_test_verification"));
    if (coupon.status !== 200) return [...out, { check: "the session's coupon is made", ok: false, detail: err(coupon) }];
    out.push({
      check: "the session's coupon takes all of it, once",
      ok: num(coupon.data.percent_off) === 100 && num(coupon.data.max_redemptions) === 1 && str(coupon.data.duration) === "once",
      detail: `${num(coupon.data.percent_off)}% off, ${num(coupon.data.max_redemptions)} use, ${str(coupon.data.duration)}`,
    });
    const start = Date.now() + 3 * 86_400_000;
    const free = await onDemoAccount(
      "POST",
      "/checkout/sessions",
      callCheckoutBody({
        store: s,
        product: sessionProduct(),
        start,
        end: start + 3_600_000,
        buyerTz: "America/New_York",
        origin,
        via: null,
        fromPackage: { id: "cs_test_verification", coupon: str(coupon.data.id), email: "verify+package@example.com", back: `${origin}/@${s.handle}` },
      }),
      NO_COST_VERSION,
    );
    if (free.status === 200) opened.push(str(free.data.id));
    out.push({
      check: "a session from a package: a checkout with nothing to pay is accepted",
      ok: free.status === 200 && num(free.data.amount_total) === 0,
      detail: free.status === 200 ? `total ${num(free.data.amount_total)}` : err(free),
    });
    await onDemoAccount("DELETE", `/coupons/${encodeURIComponent(str(coupon.data.id))}`).catch(() => null);
  } finally {
    for (const id of opened) await onDemoAccount("POST", `/checkout/sessions/${encodeURIComponent(id)}/expire`, new URLSearchParams()).catch(() => null);
  }
  return out;
}

/**
 * The tax number box and the invoice (lib/tax.ts), as a store with both
 * switched on sends them. Stripe Tax itself stays off here: it needs a
 * registration the test account does not have, and neither field depends on
 * it.
 */
export async function verifyTaxDocuments(origin: string): Promise<Check[]> {
  const s = { ...checkStore(), tax: { enabled: false, included: false, ids: true, invoices: true } } as unknown as Store;
  const pkgListing = { id: "verify-call", title: "Verification call" } as unknown as Listing;
  let opened = "";
  try {
    const made = await onDemoAccount("POST", "/checkout/sessions", packageCheckoutBody(s, pkgListing, { sessions: 5, priceCents: 50000, days: 90 }, origin));
    if (made.status === 200) opened = str(made.data.id);
    const ids = (made.data.tax_id_collection as { enabled?: unknown } | null)?.enabled === true;
    const invoice = (made.data.invoice_creation as { enabled?: unknown } | null)?.enabled === true;
    return [
      {
        check: "a checkout with the tax number box and an invoice is accepted, with both on",
        ok: made.status === 200 && ids && invoice && str(made.data.customer_creation) === "always",
        detail: made.status === 200 ? `tax number box ${ids ? "on" : "off"}, invoice ${invoice ? "on" : "off"}, customer ${str(made.data.customer_creation)}` : err(made),
      },
    ];
  } finally {
    if (opened) await onDemoAccount("POST", `/checkout/sessions/${encodeURIComponent(opened)}/expire`, new URLSearchParams()).catch(() => null);
  }
}

/**
 * A cart that ships (513 [PF1], unit 2b): two physical products, one to the
 * United States and Canada and one to the United States and Germany, and a
 * digital one, with the very fields the cart's checkout sends
 * (applyCartShipping). Stripe must take it, ask for an address only in the
 * United States, and show the shipping as the two amounts added together.
 */
export async function verifyCartShipping(origin: string): Promise<Check[]> {
  const s = checkStore();
  const physical = (id: string, countries: string[], cents: number) =>
    ({ id, title: `Verification ${id}`, priceCents: 2000, recurring: null, call: null, options: [], pwyw: null, plan: null, file: null, link: null, course: null, podcast: null, bundle: null, shipping: { cents, region: "custom", countries, note: "" } }) as unknown as Listing;
  const products = [physical("verify-box", ["US", "CA"], 700), physical("verify-poster", ["US", "DE"], 300), { ...physical("verify-guide", [], 0), shipping: null, link: "https://example.com/guide" } as unknown as Listing];
  const shipping = cartShipping(products.map(cartItemOf));
  if (shipping.kind !== "ships") return [{ check: "a cart that ships is accepted with the shared countries and the amounts added", ok: false, detail: `the rule answered ${shipping.kind}` }];
  const body = new URLSearchParams({ mode: "payment", success_url: `${origin}/stripe-check`, cancel_url: `${origin}/stripe-check` });
  products.forEach((product, i) => {
    body.set(`line_items[${i}][quantity]`, "1");
    body.set(`line_items[${i}][price_data][currency]`, s.currency);
    body.set(`line_items[${i}][price_data][unit_amount]`, String(product.priceCents));
    body.set(`line_items[${i}][price_data][product_data][name]`, product.title);
  });
  applyCartShipping(body, s, products, shipping);
  let opened = "";
  try {
    const made = await onDemoAccount("POST", "/checkout/sessions", body);
    if (made.status === 200) opened = str(made.data.id);
    const countries = (made.data.shipping_address_collection as { allowed_countries?: unknown } | null)?.allowed_countries;
    const option = Array.isArray(made.data.shipping_options) ? (made.data.shipping_options[0] as { shipping_amount?: unknown } | undefined) : undefined;
    const amount = num(option?.shipping_amount);
    const where = Array.isArray(countries) ? countries.join(",") : "";
    return [
      {
        check: "a cart that ships is accepted with the shared countries and the amounts added",
        ok: made.status === 200 && where === "US" && amount === 1000,
        detail: made.status === 200 ? `countries ${where || "none"}, shipping ${Number.isNaN(amount) ? "none" : amount}` : err(made),
      },
    ];
  } finally {
    if (opened) await onDemoAccount("POST", `/checkout/sessions/${encodeURIComponent(opened)}/expire`, new URLSearchParams()).catch(() => null);
  }
}
