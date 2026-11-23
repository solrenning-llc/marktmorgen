/**
 * Issue #3952 (Codex X8; rule 24): a paid order sent from the server to the connected ad platforms
 * (lib/ad-events.ts) took an amount that did not read as 0 (`amount_total` missing, text, fractional, negative,
 * unsafe) and a currency that did not read as the store's current one, and claimed the order's once-only mark before
 * sending, so the guessed value was kept as sent. A renewal did the same with its invoice's currency. Now an order or
 * a renewal whose amount and currency do not read, as Stripe writes them, is not an ordinary one: nothing is sent
 * and no mark is taken, so the same order sent again with readable values goes out once, with its exact value.
 *
 * Through the real code with a stand-in Stripe and Meta; synthetic store, ids and Redis only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sendRenewals, sendServerPurchase, setServerToken, subKey } from "@/lib/ad-events";
import { claimHandle, ensureStatsId, setAdsServer, setPixels, setStripeAccount, storeForEmail } from "@/lib/store";
import { NO_PIXELS } from "@/lib/pixels";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_ad_value_stand_in";

const OWNER = "advalue@example.com";
const NOW = Date.now();
const META_TOKEN = "EAAB" + "v".repeat(60);

let sentValues: unknown[] = [];
/** The paid invoices the stand-in Stripe lists (renewals). */
let invoices: Record<string, unknown>[] = [];
/** How the stand-in Stripe answers the order's amount and currency, while set. */
let money: { amount_total?: unknown; currency?: unknown } = { amount_total: 5000, currency: "usd" };
const session = (id: string) => ({
  id,
  status: "complete",
  payment_status: "paid",
  ...money,
  created: Math.floor(NOW / 1000) - 60,
  customer_details: { email: "buyer@example.com", address: { country: "US" } },
  payment_intent: `pi_${id}`,
  metadata: { store: "advalue", product: "prod000001" },
});
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "graph.facebook.com") {
    const body = new URLSearchParams(String(init?.body ?? ""));
    const data = JSON.parse(body.get("data") ?? String(init?.body ?? "[]")) as { custom_data?: { value?: unknown; currency?: unknown } }[] | { data?: { custom_data?: { value?: unknown; currency?: unknown } }[] };
    const events = Array.isArray(data) ? data : data.data ?? [];
    sentValues.push(...events.map((e) => `${e.custom_data?.value} ${e.custom_data?.currency}`));
    return json({ events_received: 1 });
  }
  if (url.pathname.replace(/^\/v1/, "") === "/invoices") return json({ object: "list", data: invoices, has_more: false });
  const one = /\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(url.pathname);
  if (one) return json(session(one[1]));
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "advalue", "Ad Value Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestAdValue0001", true);
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  await setServerToken(statsId, "meta", META_TOKEN);
  await setAdsServer(OWNER, ["meta"]);
  await setPixels(OWNER, { ...NO_PIXELS, meta: "123456789012345" });
  const store = (await storeForEmail(OWNER))!;
  const buyer = { ip: "203.0.113.9", userAgent: "Mozilla/5.0", url: "https://marktmorgen.com/@advalue/thanks", cookies: {} };

  part("An order whose amount or currency does not read: nothing sent, no mark taken");
  let n = 0;
  for (const [label, shape] of [
    ["no amount", { currency: "usd" }],
    ["an amount as text", { amount_total: "5000", currency: "usd" }],
    ["a fractional amount", { amount_total: 50.5, currency: "usd" }],
    ["a negative amount", { amount_total: -5000, currency: "usd" }],
    ["an unsafe amount", { amount_total: 2 ** 60, currency: "usd" }],
    ["no currency", { amount_total: 5000 }],
    ["a currency that is not one", { amount_total: 5000, currency: "dollars" }],
  ] as [string, typeof money][]) {
    n += 1;
    const id = `cs_test_value${String(n).padStart(9, "0")}`;
    money = shape;
    sentValues = [];
    const result = await sendServerPurchase(store, id, buyer, NOW);
    is(`${label}: nothing sent`, sentValues.length, 0);
    is(`${label}: no mark taken`, redis.run(["EXISTS", `nl:adsrv:sent:${id}`]), 0);
    is(`${label}: said as not an order to send`, result, "invalid");
  }

  part("The same order sent again with its amount and currency read: once, exactly");
  money = { amount_total: 5000, currency: "eur" };
  sentValues = [];
  is("sent", await sendServerPurchase(store, "cs_test_value000000001", buyer, NOW), "sent");
  is("with its own value and currency, never the store's", sentValues, ["50 EUR"]);

  part("A renewal whose amount or currency does not read: nothing sent, no mark taken (Claude 1 2as's MEDIUM on #5241)");
  const SUB = "sub_AdValue00000001";
  // The cookies its first payment kept for its renewals (keepForRenewals), as the first payment would have.
  redis.run(["SET", subKey(SUB), JSON.stringify({ _fbp: "fb.1.1700000000.123456789" })]);
  const invoice = (id: string, paid: Record<string, unknown>) => ({
    id,
    status: "paid",
    billing_reason: "subscription_cycle",
    ...paid,
    customer_email: "buyer@example.com",
    created: Math.floor(NOW / 1000) - 300,
    status_transitions: { paid_at: Math.floor(NOW / 1000) - 300 },
    parent: { subscription_details: { subscription: SUB, metadata: { store: "advalue", product: "prod000001", ads: "a".repeat(32) } } },
  });
  let r = 0;
  for (const [label, paid] of [
    ["no currency", { amount_paid: 5000 }],
    ["a currency that is not one", { amount_paid: 5000, currency: "dollars" }],
    ["an amount as text", { amount_paid: "5000", currency: "usd" }],
    ["a fractional amount", { amount_paid: 50.5, currency: "usd" }],
  ] as [string, Record<string, unknown>][]) {
    r += 1;
    const id = `in_AdValueRenew${String(r).padStart(4, "0")}`;
    invoices = [invoice(id, paid)];
    sentValues = [];
    is(`${label}: no renewal sent`, [await sendRenewals(store, NOW), sentValues.length], [0, 0]);
    is(`${label}: no mark taken`, redis.run(["EXISTS", `nl:adsrv:sent:${id}`]), 0);
  }
  invoices = [invoice("in_AdValueRenew0001", { amount_paid: 5000, currency: "eur" })];
  sentValues = [];
  is("the same renewal read: sent once, with its own value and currency", [await sendRenewals(store, NOW), sentValues], [1, ["50 EUR"]]);

  part("A renewal whose currency does not read is not sent in the store's");
  const source = readFileSync(join(process.cwd(), "lib/ad-events.ts"), "utf8");
  is("no renewal falls back to the store's currency", /currency: typeof row\.currency === "string" \? row\.currency : store\.currency/.test(source), false);
  is("no order falls back to 0 or the store's currency", /amount_total === "number" \? session\.amount_total : 0|typeof session\.currency === "string" \? session\.currency : store\.currency/.test(source), false);

  done();
}

void main();
