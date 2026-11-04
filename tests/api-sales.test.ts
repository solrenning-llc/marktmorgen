/**
 * 630 [HN6](19) unit 1: GET /api/v1/sales, the store's paid checkouts read
 * from the creator's own Stripe account, in the shape of the sale.completed
 * webhook, only this store's settled sales (never a card saved in setup
 * mode), only while it can sell, with Stripe's own cursor, checked before
 * Stripe is asked; refunds and disputes off the expanded charge; a page that
 * cannot be read whole refused; fields chosen; API_SALES_UNITS of the month
 * per call; and the /developers example in the answer's own shape.
 * Synthetic Stripe answers only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GET } from "@/app/api/v1/sales/route";
import { makeKey } from "@/lib/api-keys";
import { SALE_FIELDS, SALE_TEXT_LIMITS, SALES_PAGE, SALES_TITLE_IDS, cutText, saleKind, sales, titleIds } from "@/lib/api-sales";
import { readListings } from "@/lib/catalog";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { API_SALES_UNITS, allowanceFor } from "@/lib/store-allowance-rules";
import { BUMP_KEYS, MAX_BUNDLE_ITEMS, bundleMeta } from "@/lib/bundle-rules";
import { MAX_TITLE_LENGTH } from "@/lib/catalog-rules";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { API_SALE_BYTES, API_SALES_ANSWER_BYTES } from "./plan-cost-registry";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "api-sales@example.com";
const HANDLE = "api-sales-shop";
const ACCOUNT = "acct_ApiSalesTest01";
process.env.STRIPE_SECRET_KEY = "sk_test_api_sales_stand_in";

/** Stripe's answers, in turn: a page, or a refusal with its status. */
let pages: (Record<string, unknown> | { refused: number; body: Record<string, unknown> })[] = [];
const asked: URL[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || url.pathname !== "/v1/checkout/sessions" || init?.method !== "GET" || new Headers(init.headers).get("Stripe-Account") !== ACCOUNT) {
    throw new Error(`unexpected synthetic operation ${url}`);
  }
  asked.push(url);
  const next = pages.shift() ?? { error: "no page" };
  return "refused" in next && typeof next.refused === "number" ? Response.json(next.body, { status: next.refused }) : Response.json(next);
}) as typeof fetch;

const charge = (id: string, created: number, extra: Record<string, unknown> = {}) => ({ id, object: "charge", created, amount_refunded: 0, disputed: false, ...extra });
const session = (id: string, extra: Record<string, unknown> = {}, meta: Record<string, string> = {}) => ({
  id,
  object: "checkout.session",
  status: "complete",
  payment_status: "paid",
  mode: "payment",
  created: 1_790_000_000,
  // Expanded on the list request: the charge came a minute after the page opened.
  payment_intent: { id: `pi_${id}`, object: "payment_intent", created: 1_790_000_060, latest_charge: charge(`ch_${id}`, 1_790_000_060) },
  amount_total: 4900,
  currency: "usd",
  total_details: { amount_discount: 500 },
  customer_details: { email: "dana@example.com", name: "Dana Ortiz" },
  custom_fields: [{ key: "q1", text: { value: "a private answer" } }],
  metadata: { store: HANDLE, product: "p_guide", title: "The Pantry Guide", option: "full", utm_source: "newsletter", ...meta },
  ...extra,
});

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "API Sales Shop", "");
  await ensureStatsId(OWNER);
  let store = (await storeForEmail(OWNER))!;
  const key = await makeKey(store.sid, "Synthetic reader");
  if (!key.ok) throw new Error("no synthetic key");
  const call = async (query = "") => {
    const res = await GET(new Request(`https://marktmorgen.com/api/v1/sales${query}`, { headers: { Authorization: `Bearer ${key.key}` } }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  part("Only while the store can take payments, as the studio");
  await setSubscription(OWNER, { customerId: "cus_ApiSales1", subscriptionId: "sub_ApiSales1", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const closed = await call();
  is("no Stripe account: refused with the reason, Stripe not asked", [closed.status, (closed.body as { error?: string }).error, asked.length], [409, "not_selling", 0]);
  await setStripeAccount(OWNER, ACCOUNT, false);
  const notEnabled = await call();
  is("charges not enabled on it yet: refused the same way", [notEnabled.status, asked.length], [409, 0]);
  await setStripeAccount(OWNER, ACCOUNT, true);
  store = (await storeForEmail(OWNER))!;

  part("A page of sales");
  pages = [{
    object: "list",
    has_more: true,
    data: [
      session("cs_test_one"),
      session("cs_test_sub", { mode: "subscription" }, { trial_days: "7", product: "p_club", title: "" }),
      session("cs_test_open", { status: "open", payment_status: "unpaid" }),
      session("cs_test_other", {}, { store: "someone-else" }),
      session("cs_test_tip", {}, { kind: "tip" }),
    ],
  }];
  const usedAtFirst = await allowanceUsed(store, "api");
  const first = await call();
  const data = (first.body as { data: Record<string, unknown>[] }).data;
  is("answered", first.status, 200);
  is("only this store's settled checkouts, newest first", data.map((s) => s.checkout_session), ["cs_test_one", "cs_test_sub", "cs_test_tip"]);
  is("in the shape of sale.completed, with the charge's refunds and dispute", data[0], {
    checkout_session: "cs_test_one",
    kind: "one_time",
    product: { id: "p_guide", title: "The Pantry Guide" },
    option: "full",
    bundle_items: null,
    order_bump: null,
    order_bumps: [],
    amount_cents: 4900,
    discount_cents: 500,
    currency: "usd",
    buyer: { email: "dana@example.com", name: "Dana Ortiz" },
    opened_at: new Date(1_790_000_000_000).toISOString(),
    paid_at: new Date(1_790_000_060_000).toISOString(),
    refunded_cents: 0,
    disputed: false,
    trial: false,
    source: { utm_source: "newsletter", utm_medium: null, utm_campaign: null, utm_content: null, site: null },
  });
  is("a membership with its trial, a tip as a tip", [data[1].kind, data[1].trial, data[2].kind], ["membership", true, "tip"]);
  is("what the buyer typed at checkout is never sent", JSON.stringify(first.body).includes("a private answer"), false);
  is("the answer is the page and its cursor, nothing else", Object.keys(first.body), ["data", "next"]);
  is("the next cursor is Stripe's own: the last checkout of its page", (first.body as { next: unknown }).next, "cs_test_tip");
  is("one request to Stripe, its own most per page", [asked.length, asked[0].searchParams.get("limit")], [1, String(SALES_PAGE)]);
  is(`the call took ${API_SALES_UNITS} of the month's API requests, the request included`, (await allowanceUsed(store, "api")) - usedAtFirst, API_SALES_UNITS);

  part("Going on with the cursor");
  pages = [{ object: "list", has_more: false, data: [session("cs_test_other2", {}, { store: "someone-else" })] }];
  const second = await call("?cursor=cs_test_tip");
  is("Stripe asked from after the cursor", asked[1].searchParams.get("starting_after"), "cs_test_tip");
  is("a page with none of this store's: empty, and the end", [(second.body as { data: unknown[] }).data, (second.body as { next: unknown }).next], [[], null]);

  part("A cursor this list did not give is refused, never read as the first page");
  const before = asked.length;
  const usedBefore = await allowanceUsed(store, "api");
  for (const query of ["?cursor=not-a-cursor", "?cursor=", "?cursor=null", "?cursor=cs_test_tip&cursor=cs_test_one"]) {
    const r = await call(query);
    is(`${query}: 400 invalid_cursor`, [r.status, (r.body as { error?: string }).error], [400, "invalid_cursor"]);
  }
  is("Stripe not asked, and only the request itself taken from the month", [asked.length - before, (await allowanceUsed(store, "api")) - usedBefore], [0, 4]);
  pages = [{ refused: 404, body: { error: { code: "resource_missing", type: "invalid_request_error", message: "No such checkout.session: 'cs_test_elsewhere'" } } }];
  const foreign = await call("?cursor=cs_test_elsewhere");
  is("a checkout id Stripe does not have on this account (404): 400 invalid_cursor, not a 502 to retry forever", [foreign.status, (foreign.body as { error?: string }).error], [400, "invalid_cursor"]);
  pages = [{ refused: 400, body: { error: { code: "resource_missing", param: "starting_after", type: "invalid_request_error", message: "No such checkout session: 'cs_test_elsewhere2'" } } }];
  const foreign400 = await call("?cursor=cs_test_elsewhere2");
  is("the same said as a 400 on starting_after: 400 invalid_cursor too", [foreign400.status, (foreign400.body as { error?: string }).error], [400, "invalid_cursor"]);
  pages = [{ refused: 400, body: { error: { code: "parameter_invalid_integer", type: "invalid_request_error", message: "Invalid integer" } } }];
  const otherBad = await call("?cursor=cs_test_elsewhere3");
  is("another 400 from Stripe is not the cursor's fault: 502", otherBad.status, 502);

  part("Stripe busy with the creator's account: said with when to try again");
  pages = [{ refused: 429, body: { error: { type: "invalid_request_error", message: "Too many requests" } } }];
  const busy = await GET(new Request("https://marktmorgen.com/api/v1/sales", { headers: { Authorization: `Bearer ${key.key}` } }));
  is("503 unavailable with Retry-After", [busy.status, ((await busy.json()) as { error?: string }).error, busy.headers.get("Retry-After")], [503, "unavailable", "10"]);

  part("An answer that cannot be read whole is unknown, never no sales");
  for (const bad of [{ data: null, has_more: false }, { data: [], has_more: "no" }, { data: [null], has_more: false }, []]) {
    pages = [bad as Record<string, unknown>];
    const r = await call();
    is(`refused: ${JSON.stringify(bad)}`, [r.status, (r.body as { error?: string }).error], [502, "unavailable"]);
  }
  const unreadable: [string, Record<string, unknown>][] = [
    ["no amount", { amount_total: null }],
    ["a negative amount", { amount_total: -4900 }],
    ["a fractional amount", { amount_total: 49.5 }],
    ["a negative discount", { total_details: { amount_discount: -500 } }],
    ["discount details without the discount", { total_details: {} }],
    ["the charge left as a bare id although it was expanded", { payment_intent: { id: "pi_x", object: "payment_intent", latest_charge: "ch_x" } }],
    ["the payment left as a bare id", { payment_intent: "pi_x" }],
    ["the invoice left as a bare id", { mode: "subscription", payment_intent: null, invoice: "in_x" }],
    ["a charge with no refunded amount", { payment_intent: { id: "pi_x", object: "payment_intent", latest_charge: { id: "ch_x", created: 1_790_000_060, disputed: false } } }],
    ["a charge with no dispute flag", { payment_intent: { id: "pi_x", object: "payment_intent", latest_charge: { id: "ch_x", created: 1_790_000_060, amount_refunded: 0 } } }],
  ];
  for (const [what, extra] of unreadable) {
    pages = [{ object: "list", has_more: false, data: [session("cs_test_ok"), session("cs_test_odd", extra)] }];
    const r = await call();
    is(`a sale with ${what}: the page is unknown, never a guessed 0, a negative amount or "nothing charged"`, [r.status, (r.body as { error?: string }).error], [502, "unavailable"]);
  }
  pages = [{ object: "list", has_more: false, data: [session("cs_test_nodetails", { total_details: null })] }];
  is("no discount details at all: the discount is null, never a guessed 0", ((await call()).body as { data: Record<string, unknown>[] }).data[0].discount_cents, null);
  pages = [{ object: "list", has_more: false, data: [session("cs_test_odd_other", { amount_total: -1 }, { store: "someone-else" })] }];
  is("another store's odd checkout does not stop this store's page", (await call()).status, 200);
  for (const lastId of [null, "not-a-checkout"]) {
    pages = [{ object: "list", has_more: true, data: [session("cs_test_before"), { ...session("cs_test_x", {}, { store: "someone-else" }), id: lastId }] }];
    const r = await call();
    is(`more to come but the last id is ${JSON.stringify(lastId)}: 502, never a next of null that looks like the end`, r.status, 502);
  }

  part("When the buyer paid, not when the checkout page opened");
  const opened = Date.UTC(2026, 11, 31, 23, 50) / 1000;
  const paid = Date.UTC(2027, 0, 1, 0, 5) / 1000;
  const firstInvoicePaid = Date.UTC(2027, 0, 1, 0, 7) / 1000;
  pages = [{
    object: "list",
    has_more: false,
    data: [
      session("cs_test_newyear", { created: opened, payment_intent: { id: "pi_ny", object: "payment_intent", created: opened, latest_charge: charge("ch_ny", paid) } }),
      session("cs_test_newyear_sub", { mode: "subscription", created: opened, payment_intent: null, invoice: { id: "in_ny", object: "invoice", status_transitions: { paid_at: firstInvoicePaid } } }),
      session("cs_test_free", { payment_status: "no_payment_required", amount_total: 0, created: opened, payment_intent: null, invoice: null }),
      session("cs_test_nocurrency", { currency: null, payment_intent: { id: "pi_nc", object: "payment_intent", created: paid, latest_charge: charge("ch_nc", paid) } }),
    ],
  }];
  const asOf = asked.length;
  const newYear = (await call()).body as { data: Record<string, unknown>[] };
  is("the payment and the first invoice are read in the same single request", [asked.length - asOf, asked[asOf].searchParams.getAll("expand[]")], [1, ["data.payment_intent.latest_charge", "data.invoice"]]);
  is("opened on 31 December, paid on 1 January: the 1 January moment, the year the webhook says", newYear.data[0].paid_at, "2027-01-01T00:05:00.000Z");
  is("a membership: when its first invoice was paid", newYear.data[1].paid_at, "2027-01-01T00:07:00.000Z");
  is("nothing charged at checkout: no payment moment, never the page's opening", newYear.data[2].paid_at, null);
  is("no currency from Stripe: null, never a guessed usd", newYear.data[3].currency, null);
  is("a membership's first invoice is not read for refunds or disputes: null, never a guessed none", [newYear.data[1].refunded_cents, newYear.data[1].disputed], [null, null]);
  is("nothing charged: no refund or dispute to read either", [newYear.data[2].refunded_cents, newYear.data[2].disputed], [null, null]);

  part("Refunded and disputed, off the charge the request already expands");
  pages = [{
    object: "list",
    has_more: false,
    data: [
      session("cs_test_part", { payment_intent: { id: "pi_p", object: "payment_intent", latest_charge: charge("ch_p", paid, { amount_refunded: 1500 }) } }),
      session("cs_test_disputed", { payment_intent: { id: "pi_d", object: "payment_intent", latest_charge: charge("ch_d", paid, { disputed: true }) } }),
    ],
  }];
  const money = ((await call()).body as { data: Record<string, unknown>[] }).data;
  is("a partial refund in cents, and a dispute flagged", money.map((s) => [s.refunded_cents, s.disputed]), [[1500, false], [0, true]]);

  part("Only sales: a card saved in setup mode is complete and owes nothing, and is no sale");
  pages = [{
    object: "list",
    has_more: false,
    data: [
      session("cs_test_card", { mode: "setup", payment_status: "no_payment_required", amount_total: null, payment_intent: null, invoice: null, total_details: null }, { kind: "card" }),
      session("cs_test_card_meta", { payment_status: "no_payment_required", amount_total: 0, payment_intent: null, invoice: null }, { kind: "card" }),
      session("cs_test_paid"),
    ],
  }];
  is("only the paid checkout is listed", ((await call()).body as { data: Record<string, unknown>[] }).data.map((s) => s.checkout_session), ["cs_test_paid"]);

  part("Order bumps and bundles, as sale.completed lists them; upsells are their own payments");
  pages = [{
    object: "list",
    has_more: false,
    data: [session("cs_test_bump", {}, { bump: "p_extra", bump2: "p_more", bump2_bundle: "p_a,p_b", bundle: "p_x,p_y" })],
  }];
  const bumped = ((await call()).body as { data: Record<string, unknown>[] }).data[0];
  is("the bundle's products, the boxes checked in order, the first also as order_bump", [bumped.bundle_items, bumped.order_bump, bumped.order_bumps], [
    [{ id: "p_x", title: null }, { id: "p_y", title: null }],
    { id: "p_extra", title: null, bundle_items: null },
    [{ id: "p_extra", title: null, bundle_items: null }, { id: "p_more", title: null, bundle_items: [{ id: "p_a", title: null }, { id: "p_b", title: null }] }],
  ]);

  part("Fields chosen, as on the other lists");
  pages = [{ object: "list", has_more: true, data: [session("cs_test_f")] }];
  const chosen = await call("?fields=checkout_session,amount_cents");
  is("only the fields asked, the cursor kept", chosen.body, { data: [{ checkout_session: "cs_test_f", amount_cents: 4900 }], next: "cs_test_f" });
  const asOfTypo = [asked.length, await allowanceUsed(store, "api")];
  const typo = await call("?fields=amount");
  is("a field no sale has: 400 unknown_field, before Stripe is asked or the rest of the call taken", [typo.status, (typo.body as { error?: string }).error, asked.length - asOfTypo[0], (await allowanceUsed(store, "api")) - asOfTypo[1]], [400, "unknown_field", 0, 1]);
  const asOfFields = asked.length;
  const badName = await call("?fields=Amount!");
  is("a name that cannot be a field: 400 before Stripe is asked", [badName.status, (badName.body as { error?: string }).error, asked.length - asOfFields], [400, "fields", 0]);

  part("The /developers example is the answer's own shape");
  const page = readFileSync(join(process.cwd(), "app/developers/page.tsx"), "utf8");
  const section = page.slice(page.indexOf('<Endpoint path="/api/v1/sales">'));
  const example = JSON.parse(section.slice(section.indexOf("<Code>{`") + 8, section.indexOf("`}</Code>"))) as { data: Record<string, unknown>[] };
  const shape = (v: unknown): unknown => (Array.isArray(v) ? v.slice(0, 1).map(shape) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : null);
  pages = [{ object: "list", has_more: true, data: [session("cs_test_doc", {}, { bump: "p_extra", bundle: "p_x" })] }];
  const real = (await call()).body;
  is("the same fields, in the same order, all the way down", shape(example), shape(real));

  part("Texts cut on the server");
  is("control characters dropped, then cut, then a surrogate the cut left alone dropped", [cutText("a\u0000b\u001fc", 10), cutText("ab\ud83d\ude00", 3), cutText("\udc00x", 5), cutText("\u0007", 5), cutText(4, 5)], ["abc", "ab", "x", null, null]);
  const long = "漢".repeat(600);
  pages = [{
    object: "list",
    has_more: false,
    data: [session("cs_test_long", { customer_details: { email: `${"a".repeat(250)}@x.co`, name: long } }, { title: long, utm_source: long, option: "not an id!", product: "bad id!" })],
  }];
  const cut = ((await call()).body as { data: Record<string, Record<string, unknown>>[] }).data[0];
  is("the title, the name and a utm tag cut to their limits; an address longer than one can be is null, never cut; ids that cannot be ids are null",
    [(cut.product.title as string).length, (cut.buyer.name as string).length, (cut.source.utm_source as string).length, cut.buyer.email, cut.option, cut.product.id],
    [SALE_TEXT_LIMITS.title, SALE_TEXT_LIMITS.name, SALE_TEXT_LIMITS.utm, null, null, null]);

  part("At most SALES_TITLE_IDS titles read a page: products sold first, then those checked, then bundles'");
  const id = (n: number) => `p_${String(n).padStart(4, "0")}`;
  let n = 0;
  const metas = Array.from({ length: 10 }, () => {
    const m: Record<string, string> = { product: id(n++) };
    for (const key of BUMP_KEYS) Object.assign(m, { [key]: id(n++) }, bundleMeta(`${key}_bundle`, Array.from({ length: MAX_BUNDLE_ITEMS }, () => id(n++))));
    return { ...m, ...bundleMeta("bundle", Array.from({ length: MAX_BUNDLE_ITEMS }, () => id(n++))) };
  });
  const ids = titleIds(metas);
  is("cut at the most, products sold first, then the checked boxes", [ids.length, ids.slice(0, 10), ids.slice(10, 13)], [SALES_TITLE_IDS, metas.map((m) => m.product), [metas[0].bump, metas[0].bump2, metas[0].bump3]]);

  part("A page at every limit weighs no more than the cost registry's figure, and not much less");
  // A catalog built directly: ids at their 64 characters, titles at MAX_TITLE_LENGTH three-byte characters.
  const made = await addProduct(OWNER, "Template", "", "10", null);
  if (!made.ok) throw new Error("no template product");
  const base = (await storeForEmail(OWNER))!;
  const itemOf = base.catalog.items.find((x) => x.id === made.product.id)!;
  const listingOf = (await readListings(base, [made.product.id]))[0];
  const ids64 = Array.from({ length: 1 + MAX_BUNDLE_ITEMS + BUMP_KEYS.length * (1 + MAX_BUNDLE_ITEMS) }, (_, i) => `${"P".repeat(60)}${String(i).padStart(4, "0")}`);
  const wide = { ...base, catalog: { ...base.catalog, items: ids64.map((id) => ({ ...itemOf, id })), head: ids64.map((id) => ({ ...listingOf, id, title: "漢".repeat(MAX_TITLE_LENGTH) })) } } as Store;
  let k = 1;
  const full: Record<string, string> = { store: HANDLE, product: ids64[0], option: "o".repeat(64), title: "漢".repeat(SALE_TEXT_LIMITS.title), trial_days: "7", ...bundleMeta("bundle", ids64.slice(k, (k += MAX_BUNDLE_ITEMS))) };
  for (const key of BUMP_KEYS) Object.assign(full, { [key]: ids64[k++] }, bundleMeta(`${key}_bundle`, ids64.slice(k, (k += MAX_BUNDLE_ITEMS))));
  for (const utm of ["utm_source", "utm_medium", "utm_campaign", "utm_content"]) full[utm] = "漢".repeat(SALE_TEXT_LIMITS.utm);
  full.embed_site = `https://${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.example`;
  const worst = (i: number) => ({
    ...session(`cs_${"W".repeat(246)}${String(i).padStart(4, "0")}`, {
      amount_total: Number.MAX_SAFE_INTEGER, total_details: { amount_discount: Number.MAX_SAFE_INTEGER },
      payment_intent: { id: "pi_w", latest_charge: charge("ch_w", 1_790_000_060, { amount_refunded: Number.MAX_SAFE_INTEGER }) },
      customer_details: { email: "漢".repeat(SALE_TEXT_LIMITS.email), name: "漢".repeat(SALE_TEXT_LIMITS.name) },
    }),
    metadata: { ...full, kind: "plan" },
  });
  pages = [{ object: "list", has_more: true, data: Array.from({ length: SALES_PAGE }, (_, i) => worst(i)) }];
  const heavy = await sales(wide, null);
  if (!heavy) throw new Error("the worst page was not read");
  const bytes = Buffer.byteLength(JSON.stringify(heavy));
  const one = Buffer.byteLength(JSON.stringify(heavy.data[0]));
  const sale = heavy.data[0] as { order_bumps: unknown[]; bundle_items: { title: string | null }[] };
  is("every product of the sale is listed, with its catalog title", [heavy.data.length, sale.order_bumps.length, sale.bundle_items.every((p) => p.title === "漢".repeat(MAX_TITLE_LENGTH))], [SALES_PAGE, BUMP_KEYS.length, true]);
  is(`a full page: ${bytes} bytes, within API_SALES_ANSWER_BYTES (${API_SALES_ANSWER_BYTES})`, bytes <= API_SALES_ANSWER_BYTES, true);
  // Tight enough that a figure leaving out a part of a sale (the order_bump said twice, a bundle) fails here.
  is(`one sale: ${one} bytes, within API_SALE_BYTES (${API_SALE_BYTES}) and above 90% of it`, [one <= API_SALE_BYTES, one >= 0.9 * API_SALE_BYTES], [true, true]);
  pages = [{ object: "list", has_more: false, data: Array.from({ length: SALES_PAGE + 1 }, (_, i) => session(`cs_test_many${i}`)) }];
  is("more checkouts than a page asks for: unknown, 502", (await call()).status, 502);

  part("A sale's fields are SALE_FIELDS, in order");
  pages = [{ object: "list", has_more: false, data: [session("cs_test_keys")] }];
  is("the same list ?fields= is checked against", Object.keys(((await call()).body as { data: Record<string, unknown>[] }).data[0]), [...SALE_FIELDS]);

  part("Times a Date cannot hold, and a missing opening time: unknown, never a thrown error");
  for (const [what, extra] of [
    ["a charge time past what a Date holds", { payment_intent: { id: "pi_t", latest_charge: charge("ch_t", 9e12) } }],
    ["a first invoice paid past what a Date holds", { mode: "subscription", payment_intent: null, invoice: { id: "in_t", status_transitions: { paid_at: 9e12 } } }],
    ["an opening time past what a Date holds", { created: 9e12 }],
    ["no opening time", { created: null }],
  ] as [string, Record<string, unknown>][]) {
    pages = [{ object: "list", has_more: false, data: [session("cs_test_time", extra)] }];
    is(`${what}: 502`, (await call()).status, 502);
  }
  pages = [{ object: "list", has_more: false, data: [session("cs_test_opened")] }];
  is("opened_at is when the checkout page opened", ((await call()).body as { data: Record<string, unknown>[] }).data[0].opened_at, new Date(1_790_000_000_000).toISOString());

  part("An address is kept whole or not at all");
  for (const [what, email] of [["255 characters", `${"a".repeat(249)}@x.com`], ["a control character", "da\u0007na@example.com"]] as [string, string][]) {
    pages = [{ object: "list", has_more: false, data: [session("cs_test_mail", { customer_details: { email, name: "Dana" } })] }];
    is(`${what}: null, never cut or cleaned`, (((await call()).body as { data: Record<string, Record<string, unknown>>[] }).data[0].buyer.email), null);
  }
  pages = [{ object: "list", has_more: false, data: [session("cs_test_mail254", { customer_details: { email: `${"a".repeat(248)}@x.com`, name: "Dana" } })] }];
  is("254 characters: kept as it is", (((await call()).body as { data: Record<string, Record<string, unknown>>[] }).data[0].buyer.email as string).length, 254);

  part("The privacy policy says a key reads buyers' addresses and names here");
  const privacy = readFileSync(join(process.cwd(), "app/privacy/page.tsx"), "utf8").replace(/\s+/g, " ").replace(/&apos;/g, "'");
  is("one sentence, under the API's own heading", privacy.includes("Any key of a store, one that only reads included, can also list the store's sales with each buyer's email address and name, read from the creator's own Stripe account when the tool asks; we do not keep that list."), true);

  part("Kinds");
  is("as sale.completed names them", [saleKind({ metadata: { kind: "call" } }), saleKind({ metadata: { kind: "plan" }, mode: "subscription" }), saleKind({ mode: "subscription" }), saleKind({ mode: "payment" })], ["call", "payment_plan", "membership", "one_time"]);

  part("Fewer than the call's units left: refused, and only the request itself taken");
  const limit = allowanceFor(store, "api");
  const used = await allowanceUsed(store, "api");
  const fill = await takeAllowance(store, "api", limit - used - (API_SALES_UNITS - 2));
  if (!fill.ok) throw new Error("could not fill the synthetic month");
  const asOfLast = asked.length;
  const tight = await call();
  is(`${API_SALES_UNITS - 2} left: 429 monthly_limit, Stripe not asked`, [tight.status, (tight.body as { error?: string }).error, asked.length - asOfLast], [429, "monthly_limit", 0]);
  is(`the ${API_SALES_UNITS - 1} refused are not taken: only the request's own one`, await allowanceUsed(store, "api"), limit - (API_SALES_UNITS - 2) + 1);

  done();
}

void main();
