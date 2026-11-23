/**
 * Codex L-20261119-1446 (#5010 row 85): the yearly price a membership moves onto is made on the creator's Stripe
 * account and kept only while the store is live (setWhileStoreLive, 773a4b189). Its "gone" answer was thrown away
 * and the Stripe id handed back, so previewYearly went on to ask Stripe for an invoice preview and switchYearly to
 * move the member's subscription, and charge it, after the store's erasure had begun. A "gone" now stops both
 * before any call that touches the member's subscription: the preview and the move answer "gone", and nothing but
 * the price itself (made on the creator's account, never charged) reaches Stripe. A live store still moves.
 * Every service and identifier here is a local synthetic stand-in.
 */
import { mintYearlyLink, previewYearly, switchYearly, yearlyPrice } from "@/lib/yearly-switch";
import { ERASING_KEY, addProduct, claimHandle, ensureListId, ensureStatsId, erasingField, setProductLink, setProductYearly, setStripeAccount, setSubscription, storeForEmail, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { skipWaits } from "./skip-waits";
skipWaits(["takeLock", "paced"]);

process.env.STRIPE_SECRET_KEY = "sk_test_yearly_price_gone";
process.env.RESEND_API_KEY = "re_test_yearly_price_gone";

const OWNER = "gone-owner@example.com";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const mails: { text: string }[] = [];
const calls: { method: string; path: string; body: URLSearchParams }[] = [];
let product = "";
/** What the next price POST does while Stripe is working on it, before it answers. */
let duringPrice: () => Promise<void> = async () => {};

const member = () => ({
  id: "sub_Gone00000001",
  status: "active",
  customer: { id: "cus_Gone000001", email: "gone@example.com" },
  created: NOW - 90 * DAY,
  start_date: NOW - 90 * DAY,
  trial_end: null,
  discount: null,
  discounts: [],
  pause_collection: null,
  metadata: { store: "gonehouse", product },
  items: { data: [{ id: "si_Gone00000001", quantity: 1, current_period_end: NOW + 10 * DAY, price: { unit_amount: 2000, currency: "usd", metadata: {}, recurring: { interval: "month", interval_count: 1 } } }] },
});

let made = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown) => new Response(JSON.stringify(v));
  if (url.hostname === "api.resend.com") {
    mails.push(JSON.parse(String(init?.body)));
    return json({ id: `email_${mails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const body = new URLSearchParams(init?.body ? String(init.body) : "");
  calls.push({ method, path, body });
  if (method === "GET" && path === "/customers") return json({ data: [{ id: "cus_Gone000001", created: 1 }], has_more: false });
  if (method === "GET" && path === "/customers/cus_Gone000001") return json({ id: "cus_Gone000001", email: "gone@example.com" });
  if (method === "GET" && path === "/subscriptions") {
    const row = member();
    return json({ object: "list", data: url.searchParams.get("customer") ? [{ ...row, customer: row.customer.id }] : [row], has_more: false });
  }
  if (method === "POST" && path === "/prices") {
    await duringPrice();
    made += 1;
    return json({ id: `price_GoneYearly${String(made).padStart(4, "0")}` });
  }
  if (method === "POST" && path === "/invoices/create_preview") {
    const at = Number(body.get("subscription_details[proration_date]"));
    return json({
      currency: "usd",
      starting_balance: 0,
      lines: {
        object: "list",
        has_more: false,
        data: [
          { amount: -667, parent: { subscription_item_details: { proration: true } }, period: { start: at } },
          { amount: 20000, parent: { subscription_item_details: { proration: false } }, period: { start: at } },
        ],
      },
    });
  }
  if (method === "POST" && path === "/subscriptions/sub_Gone00000001") {
    if (body.get("items[0][price]")) {
      return json({ id: "sub_Gone00000001", pending_update: null, items: { data: [{ id: "si_Gone00000001", price: { id: body.get("items[0][price]") } }] }, metadata: body.get("metadata[dc]") ? { dc: body.get("metadata[dc]") } : {}, latest_invoice: { id: "in_Gone0001", status: "paid", total: 19333, amount_paid: 19333, currency: "usd" } });
    }
    return json({ id: "sub_Gone00000001" });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** The store's erasure begun, as closeStoreRecord's first step leaves it: its erasing mark set. */
async function beginErasure(store: Store): Promise<void> {
  await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]]);
}
async function endErasure(store: Store): Promise<void> {
  await redis.pipeline([["HDEL", ERASING_KEY, await erasingField(storeRef(store))]]);
}

/** Calls that touch the member's subscription or ask Stripe what it would charge. */
const touched = (from: number) => calls.slice(from).filter((c) => c.method === "POST" && (c.path === "/invoices/create_preview" || c.path.startsWith("/subscriptions/"))).map((c) => c.path);
const kept = () => redis.keys().filter((key) => key.startsWith("nl:yearly:price:"));

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "gonehouse", "Gone House", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestGoneHse", true);
  await setSubscription(OWNER, { customerId: "cus_Owner0Gone1", subscriptionId: "sub_Owner0Gone1", active: true, period: paidPeriod() });
  const added = await addProduct(OWNER, "Supper Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!added.ok) throw new Error("no product");
  product = added.product.id;
  await setProductLink(OWNER, product, "https://example.com/club");
  await setProductYearly(OWNER, product, { cents: 20000 });
  const store = (await storeForEmail(OWNER))!;
  // The emailed link that opens this one move (lib/yearly-ask.ts), as the yearly switch's own test makes it.
  const token = await mintYearlyLink(store, "cus_Gone000001", "sub_Gone00000001");

  part("yearlyPrice: Stripe answers after the store's erasure began");
  duringPrice = () => beginErasure(store);
  const direct = await yearlyPrice(store, added.product, 20000).then((id) => `returned ${id}`, (error: unknown) => ((error as Error)?.name === "YearlyStoreGoneError" ? "gone" : `threw: ${String(error)}`));
  is("it says the store is gone, never hands the price on", direct, "gone");
  is("and keeps no price", kept(), []);
  await endErasure(store);

  part("previewYearly: no preview of a charge for a store being erased");
  duringPrice = () => beginErasure(store);
  let from = calls.length;
  const preview = await previewYearly(store, token, "sub_Gone00000001");
  is("answers gone", preview.ok ? "ok" : preview.reason, "gone");
  is("Stripe is asked for no invoice preview", touched(from), []);
  is("and no price is kept", kept(), []);
  await endErasure(store);

  part("switchYearly: the member's subscription is never moved nor charged");
  duringPrice = () => beginErasure(store);
  from = calls.length;
  const moved = await switchYearly(store, token, "sub_Gone00000001", Math.floor(Date.now() / 1000), TEST_CONSENT);
  is("answers gone", moved, { ok: false, reason: "gone" });
  is("nothing sent to the member's subscription", touched(from), []);
  is("and no price is kept", kept(), []);
  await endErasure(store);

  part("A live store still previews and moves");
  duringPrice = async () => {};
  const live = await previewYearly(store, token, "sub_Gone00000001");
  if (!live.ok) throw new Error(`no preview: ${live.reason}`);
  is("the year, less what is left of the month", live.preview.due, 19333);
  is("its price kept once", kept().length, 1);
  from = calls.length;
  is("moved", await switchYearly(store, token, "sub_Gone00000001", live.preview.at, TEST_CONSENT), { ok: true, title: "Supper Club" });
  is("on the kept price, no new one made", calls.slice(from).filter((c) => c.path === "/prices").length, 0);

  done();
}

void main();
