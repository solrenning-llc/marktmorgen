/**
 * A platform fee that carries VAT collected for the tax office is never given back by the share settlement.
 *
 * Under 789 [IV1] the EU and UK VAT on a store's sale reaches the Solrenning LLC only through the application fee on the
 * creator's direct charge: fee = the plan's share + the VAT + the costs of receiving it (lib/eu-vat-lines.ts), and the
 * sale is marked `eu_vat` or `uk_vat` (with `uk_vat_gbp` beside a non-pound UK sale). The settlement (lib/share-settle.ts)
 * knows only the share, so it would hand back everything above it: the VAT the LLC owes, to the creator. Until the VAT
 * refund design is built (the VAT goes back with the buyer's money and the return is corrected, AGENTS.md IV (b)), such
 * a fee is unknown to the settlement: refused, counted, never refunded. A fee without the mark settles as before.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { settleFee, settleShares } from "@/lib/share-settle";
import { claimHandle, setStripeAccount, setSubscription } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const fee = { id: "fee_VatHeld000001", account: "acct_VatHeld00001", charge: "ch_VatHeld0000001", amount: 2020, refunded: 0, currency: "eur" };
const intentId = "pi_VatHeld0000001";

type Options = { meta: Record<string, string>; on?: "intent" | "charge"; diagnostic?: boolean };

async function run(options: Options) {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_vat_held_only_a_stand_in";
  const now = Math.floor(Date.now() / 1000), owner = "vat-held@example.test";
  assert.equal((await claimHandle(owner, "vat-held", "Synthetic shop", "")).ok, true);
  assert.equal((await setStripeAccount(owner, fee.account, true)).ok, true);
  assert.ok(await setSubscription(owner, { customerId: "cus_VatHeld000001", subscriptionId: "sub_VatHeld000001", active: true, tier: "creator", cycle: "month", shared: true, trialEnds: now - 30 * 86400, period: paidPeriod() }));
  const onCharge = options.on === "charge";
  // A 100.00 sale with 19.00 of German VAT on top: the buyer paid 119.00, and the fee holds 0 share + 19.00 + 1.20.
  const intent = { object: "payment_intent", id: intentId, currency: "eur", amount: 11900, amount_received: 11900, status: "succeeded", latest_charge: fee.charge, metadata: options.meta };
  const charge = { object: "charge", id: fee.charge, currency: "eur", amount: 11900, amount_refunded: 0, disputed: false, invoice: null, payment_intent: onCharge ? null : intent, metadata: onCharge ? options.meta : {} };
  const previous = globalThis.fetch;
  const posts: { path: string; amount: string | null }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    assert.equal(url.origin, "https://api.stripe.com");
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (method === "POST") posts.push({ path: url.pathname, amount: body.get("amount") });
    const feeReply = { object: "application_fee", ...fee, amount_refunded: fee.refunded };
    if (url.pathname === "/v1/application_fees") return Response.json({ object: "list", has_more: false, data: [feeReply] });
    if (url.pathname === "/v1/application_fees/" + fee.id && method === "GET") return Response.json(feeReply);
    if (url.pathname === "/v1/events") return Response.json({ object: "list", has_more: false, data: [] });
    if (url.pathname === "/v1/subscriptions/search") return Response.json({ object: "search_result", has_more: false, data: [] });
    if (url.pathname === "/v1/charges/" + fee.charge && method === "GET") return Response.json(charge);
    if (url.pathname === "/v1/application_fees/" + fee.id + "/refunds" && method === "POST") return Response.json({ object: "fee_refund", id: "fr_VatHeld0000001", fee: fee.id, currency: "eur", amount: Number(body.get("amount")) });
    throw Error("Unexpected synthetic endpoint " + url.pathname);
  };
  try {
    if (options.diagnostic) return { counts: await settleShares(Date.now() + 60000, now, true), posts, result: null, rejected: false };
    let result: number | null = null, rejected = false;
    try { result = await settleFee(fee, now, true); } catch { rejected = true; }
    return { counts: null, posts, result, rejected };
  } finally { globalThis.fetch = previous; }
}

const share = { share_bps: "0", share_base: "10000" };
const marked: [string, Record<string, string>][] = [
  ["EU VAT", { ...share, eu_vat: "DE:1900:1900" }],
  ["UK VAT in pounds", { ...share, uk_vat: "GB:2000:2000" }],
  ["UK VAT in another currency", { ...share, uk_vat: "GB:2000:2000", uk_vat_gbp: "1676:1.1930:2026-11" }],
  ["the sterling line alone", { ...share, uk_vat_gbp: "1676:1.1930:2026-11" }],
  ["an empty mark", { ...share, eu_vat: "" }],
];

for (const on of ["intent", "charge"] as const) for (const [label, meta] of marked) {
  test(`a fee holding ${label} (read on the ${on}) is never given back`, async () => {
    const r = await run({ meta, on });
    assert.deepEqual(r.posts, [], "the VAT owed to the tax office was refunded to the creator");
    assert.equal(r.rejected, true);
  });
}

test("the run counts it as an unknown amount and refunds nothing", async () => {
  const r = await run({ meta: marked[0][1], diagnostic: true });
  assert.deepEqual(r.posts, []);
  assert.equal(r.counts?.unknownAmounts, 1);
  assert.deepEqual(r.counts?.unknownAmountFees, [fee.id]);
});

test("a fee without a VAT mark still gives back what was taken above the share", async () => {
  const r = await run({ meta: share });
  assert.equal(r.rejected, false);
  assert.equal(r.result, fee.amount);
  assert.deepEqual(r.posts, [{ path: "/v1/application_fees/" + fee.id + "/refunds", amount: String(fee.amount) }]);
});
