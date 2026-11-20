/**
 * 790 [IV2], unit 1 (owner, 20/11/2026, about 00h20 Fortaleza; AGENTS.md, EU VAT rule (i)): every Stripe Checkout
 * Session that charges a buyer asks Stripe for the buyer's full billing address (billing_address_collection=required),
 * in every country, with Stripe's own autofill; a checkout that charges nothing asks no address. Only the billing
 * address: no phone and no other field is added for it.
 *
 * Stripe API reference, POST /v1/checkout/sessions, billing_address_collection (docs.stripe.com, read 20/11/2026):
 * "Specify whether Checkout should collect the customer's billing address. Defaults to auto." Values: auto,
 * "Checkout will only collect the billing address when necessary"; required, "Checkout will always collect the
 * customer's billing address."
 *
 * 1. Every place in lib/ and app/ that names the Checkout Sessions endpoint by its exact path is classified below, one
 *    entry per occurrence, so a new place that creates a checkout fails here until somebody says whether it charges.
 * 2. The checkouts themselves, built by the real code with Stripe played by a stand-in for `fetch`: a product, a
 *    membership with a free trial, the cart, a payment request, a tip, a paid call, the creator's plan and the store
 *    assistant ask the address; a call booked from a package already paid for, which charges nothing, does not.
 *
 * Synthetic: no real account, payment, buyer or address.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Product, type Store } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { POST as cartRoute } from "@/app/api/store/cart/route";
import { createCheckout } from "@/lib/store-checkout";
import { readDraft } from "@/lib/payment-request-rules";
import { createRequest } from "@/lib/payment-request-store";
import { createRequestCheckout } from "@/lib/payment-requests";
import { createTipCheckout } from "@/lib/store-tip-checkout";
import { callCheckoutBody } from "@/lib/calls";
import { createBillingCheckout } from "@/lib/billing";
import { createAssistantCheckout } from "@/lib/assistant-billing";
import { ASSISTANT_PRICE_CENTS } from "@/lib/store-assistant-rules";
import { PLAN_PRICES } from "@/lib/plan";
import { TEST_CONSENT, withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_iv2_address_required_only";

const ROOT = process.cwd();
const FIELD = "billing_address_collection";

/**
 * Each occurrence of the exact path "/checkout/sessions", in file order.
 * - paid: a checkout that charges the buyer: asks the address.
 * - paid-unless-package: lib/calls.ts, one body for a paid booking (asks) and for a session from a package already
 *   paid for, whose coupon takes the whole amount, so nothing is charged (no address).
 * - pending-reserved: a paid checkout whose file another agent holds; left as it is in this unit (reported).
 * - replay: the outbox sends again, byte for byte, a body lib/store-checkout.ts built and bound by its digest.
 * - setup: a card update (mode=setup), not a purchase.
 * - demo: a verification on the demo account; the ones built by the real builders follow them.
 * - read / guard: not a creation.
 */
type Kind = "paid" | "paid-unless-package" | "pending-reserved" | "replay" | "setup" | "demo" | "read" | "guard";
const SITES: Record<string, Kind[]> = {
  "lib/assistant-billing.ts": ["paid", "read"],
  "lib/billing.ts": ["paid", "paid"],
  "lib/call-packages.ts": ["pending-reserved"],
  "lib/calls.ts": ["paid-unless-package"],
  "lib/card-update.ts": ["setup"],
  "lib/cart-checkout.ts": ["paid"],
  "lib/order-confirmation-outbox.ts": ["replay"],
  "lib/payment-requests.ts": ["paid"],
  "lib/store-checkout.ts": ["paid"],
  "lib/store-tip-checkout.ts": ["paid"],
  "lib/stripe-account.ts": ["guard"],
  "lib/verify-stripe.ts": ["demo", "demo", "demo", "demo"],
};

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const path = `${dir}/${name}`;
    if (statSync(join(ROOT, path)).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

const sessions: { body: URLSearchParams; headers: Headers; platform: boolean }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  if (path === "/checkout/sessions" && method === "POST") {
    sessions.push({ body: new URLSearchParams(String(init?.body)), headers, platform: !headers.has("Stripe-Account") });
    const id = `cs_test_${String(sessions.length).padStart(24, "a")}`;
    return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}`, status: "open" }));
  }
  if (path === "/prices" && method === "GET") {
    const key = url.searchParams.get("lookup_keys[]") ?? "";
    if (/assistant/i.test(key)) return new Response(JSON.stringify({ object: "list", data: [{ id: "price_Iv2Assistant01", unit_amount: ASSISTANT_PRICE_CENTS, currency: "usd", recurring: { interval: "month", interval_count: 1 } }], has_more: false }));
    return new Response(JSON.stringify({ object: "list", data: [{ id: "price_Iv2Plan0001", unit_amount: PLAN_PRICES.creator.month, currency: "usd", recurring: { interval: "month", interval_count: 1 } }], has_more: false }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const SHOP = "iv2addressshop";
const ask = (path: string, fields: Record<string, string>) => {
  const form = withConsent(new FormData());
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return new NextRequest(`https://marktmorgen.com${path}`, { method: "POST", body: form, headers: { host: "marktmorgen.com", "x-vercel-ip-country": "US" } });
};
const last = () => sessions.at(-1)!.body;
/** Only the billing address: no phone box, and no delivery address on something that is not shipped. */
const onlyTheAddress = (body: URLSearchParams) => [body.get(FIELD), body.has("phone_number_collection[enabled]"), [...body.keys()].some((k) => k.startsWith("shipping_address_collection"))];

async function main(): Promise<void> {
  part("Every place that names the Checkout Sessions endpoint is classified");
  const found: Record<string, number> = {};
  // Every source folder, and every way to write the endpoint: "/checkout/sessions", "/v1/checkout/sessions", a full
  // URL or a template ending in it (the independent review of this unit). Reads of one session ("/checkout/sessions/"
  // followed by an id, or "?") are not creations and are not counted.
  const folders = ["lib", "app", "components", "workers", "cli", "scripts"].filter((dir) => existsSync(join(ROOT, dir)));
  for (const file of folders.flatMap((dir) => sources(dir))) {
    const count = (readFileSync(join(ROOT, file), "utf8").match(/["'`](?:[^"'`\s]*\/v1)?\/checkout\/sessions["'`]|\/checkout\/sessions`/g) ?? []).length;
    if (count) found[file] = count;
  }
  is("the same files, each with one entry per occurrence (a new one fails until classified here)", found, Object.fromEntries(Object.entries(SITES).map(([file, kinds]) => [file, kinds.length])));
  const helper = existsSync(join(ROOT, "lib/billing-address.ts")) ? readFileSync(join(ROOT, "lib/billing-address.ts"), "utf8") : "";
  is("the one helper sets only the billing address, to required", [/body\.set\("billing_address_collection", "required"\)/.test(helper), (helper.match(/body\.(set|append)\(/g) ?? []).length], [true, 1]);
  for (const [file, kinds] of Object.entries(SITES)) {
    const text = readFileSync(join(ROOT, file), "utf8");
    if (kinds.includes("paid") || kinds.includes("paid-unless-package")) {
      is(`${file}: asks the address through the helper`, /import \{ askBillingAddress \} from "@\/lib\/billing-address";/.test(text) && /askBillingAddress\(body\)/.test(text), true);
    } else {
      is(`${file}: names no billing address of its own`, text.includes(FIELD), false);
    }
  }
  is("the card update stays a setup with no address", /mode: "setup"/.test(readFileSync(join(ROOT, "lib/card-update.ts"), "utf8")), true);
  const privacy = readFileSync(join(ROOT, "app/privacy/page.tsx"), "utf8").replace(/\s+/g, " ");
  is("the privacy policy says every paid checkout asks the billing address", privacy.includes("asks for your billing address on every paid checkout"), true);
  is("and that it is never used for marketing", privacy.includes("never used for marketing"), true);
  is("and no longer says it is asked only with sales tax on", privacy.includes("When a creator switches on sales tax, Stripe asks the buyer for the address it needs to work the tax out"), false);

  redis.clear();
  const owner = "iv2address@example.com";
  await claimHandle(owner, SHOP, "Address Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Addr0001", true);
  await setSubscription(owner, { customerId: "cus_Iv2Addr0001", subscriptionId: "sub_Iv2Addr0001", active: true, period: paidPeriod() });
  const made = await addProduct(owner, "Pattern pack", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(owner, made.product.id, "https://example.com/pack");
  const id = made.product.id;

  part("A product, by card");
  let before = sessions.length;
  const bought = await checkoutRoute(ask("/api/store/checkout", { handle: SHOP, product: id, billing_country: "US" }));
  is("Stripe's page opens", [bought.status, sessions.length - before], [303, 1]);
  is("asks the full billing address, and nothing else for it", onlyTheAddress(last()), ["required", false, false]);
  is("everything else as before: a payment of the product's price", [last().get("mode"), last().get("line_items[0][price_data][unit_amount]")], ["payment", "2900"]);

  part("A membership with a free trial is still a paid purchase");
  const member = await addProduct(owner, "Monthly notes", "", "12", { interval: "month", trialDays: 7, payments: 0 });
  if (!member.ok) throw new Error("no membership");
  await setProductLink(owner, member.product.id, "https://example.com/notes");
  const store = (await storeForEmail(owner))!;
  before = sessions.length;
  await createCheckout(store, (await readProduct(store, member.product.id))!, "https://marktmorgen.com", undefined, { digitalConsent: TEST_CONSENT });
  is("a subscription, with its trial, asks the address", [sessions.length - before, last().get("mode"), last().get("subscription_data[trial_period_days]"), last().get(FIELD)], [1, "subscription", "7", "required"]);

  part("The cart");
  before = sessions.length;
  const cart = await cartRoute(ask("/api/store/cart", { handle: SHOP, id, billing_country: "US" }));
  is("Stripe's page opens", [cart.status, sessions.length - before], [303, 1]);
  is("asks the full billing address, and nothing else for it", onlyTheAddress(last()), ["required", false, false]);

  part("A payment request");
  const draft = readDraft({ email: "client@example.com", name: "Dana", lines: [{ text: "Coaching, October", quantity: 1, amount: "120" }], note: "", dueDate: "", autoReminders: 0, consent: true }, "usd");
  if (!draft.ok) throw new Error("no draft");
  const request = await createRequest(store, draft.draft);
  if (!request.ok) throw new Error("no request");
  before = sessions.length;
  await createRequestCheckout(store, request.request, "https://marktmorgen.com");
  is("asks the full billing address, and nothing else for it", [sessions.length - before, ...onlyTheAddress(last())], [1, "required", false, false]);

  part("A tip");
  before = sessions.length;
  await createTipCheckout({ ...store, tips: { ...store.tips, on: true } } as Store, "https://marktmorgen.com", 500);
  is("asks the full billing address, and nothing else for it", [sessions.length - before, ...onlyTheAddress(last())], [1, "required", false, false]);

  part("A call: paid, and from a package already paid for");
  const call = { id: "iv2call", title: "Coaching call", summary: "", priceCents: 9000, fields: [], call: { minutes: 60 } } as unknown as Product;
  const start = Date.now() + 3 * 86_400_000;
  const booking = (fromPackage: { id: string; coupon: string; email: string; back: string } | null) =>
    callCheckoutBody({ store, product: call, start, end: start + 3_600_000, buyerTz: "America/New_York", origin: "https://marktmorgen.com", via: null, fromPackage });
  is("a paid booking asks the full billing address, and nothing else for it", onlyTheAddress(booking(null)), ["required", false, false]);
  const free = booking({ id: "cs_test_iv2package", coupon: "iv2_session_coupon", email: "buyer@example.com", back: `https://marktmorgen.com/@${SHOP}` });
  is("a session from a package charges nothing and asks no address", [free.get("discounts[0][coupon]"), free.has(FIELD)], ["iv2_session_coupon", false]);

  part("The creator's plan and the store assistant, on the platform");
  before = sessions.length;
  await createBillingCheckout(store, "https://marktmorgen.com", { tier: "creator", cycle: "month" });
  is("the plan's subscription asks the full billing address, and nothing else for it", [sessions.length - before, sessions.at(-1)!.platform, ...onlyTheAddress(last())], [1, true, "required", false, false]);
  before = sessions.length;
  await createAssistantCheckout(store, "https://marktmorgen.com");
  is("the assistant's subscription asks the full billing address, and nothing else for it", [sessions.length - before, sessions.at(-1)!.platform, last().get("metadata[addon]") !== null, ...onlyTheAddress(last())], [1, true, true, "required", false, false]);

  done();
}

void main();
