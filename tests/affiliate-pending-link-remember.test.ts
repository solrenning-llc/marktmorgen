/**
 * Main's `remember` on creditPayPalSale (false: the buyer, deleted from the store at their own request, is not tied to
 * the affiliate; lib/paypal-delivery.ts) holds for a PayPal sale whose link was pending at checkout too: when the link
 * is confirmed at the hand-over, the sale is credited and no bond names the buyer. Found merging main into #3479.
 */
import { NO_AFFILIATES, parseAffiliateSetting, viaCookieValue } from "@/lib/affiliate-setting";
import { VIA_PENDING_META, attributionOrPending, creditPayPalSale, pendingChannel } from "@/lib/affiliates";
import type { SendOutcome } from "@/lib/email";
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_remember_pending";
process.env.RESEND_API_KEY = "re_test_remember_pending";

const OWNER = "potter@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";

globalThis.fetch = (async () =>
  new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

let sends = 0;
const send = async (): Promise<SendOutcome> => {
  sends += 1;
  return "sent";
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "kiln", "Kiln Notes", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRememberPn", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, days: 30, lifetime: true }));
  let store = (await storeForEmail(OWNER))!;
  if (!store.sid) await ensureStoreId(storeRef(store));
  store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const codes = `nl:aff:${statsId}:codes`;
  const people = `nl:aff:${statsId}:people`;
  const bonds = `nl:aff:${statsId}:bond`;
  await redis.pipeline([
    ["HSET", people, ANA, JSON.stringify({ id: ANA, email: "ana@example.com", code: "ana", status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "", rate: null })],
    ["HSET", codes, "ana", ANA],
  ]);
  const sale = async (ref: string) => {
    const [raw] = await redis.pipeline([["HGET", `nl:aff:${statsId}:sales`, ref]]);
    return typeof raw === "string" ? (JSON.parse(raw) as { aff: string }) : null;
  };
  const bondCount = async () => Number((await redis.pipeline([["HLEN", bonds]]))[0]);
  // The link's code record does not read at checkout, so the link is pending; it reads again by the hand-over.
  const pendingAt = async () => {
    await redis.pipeline([["HSET", codes, "ana", JSON.stringify({ not: "an id" })]]);
    const credit = await attributionOrPending(store, "prod01", { via: viaCookieValue(undefined, "ana", NOW - 600), session: undefined }, ["prod01"]);
    await redis.pipeline([["HSET", codes, "ana", ANA]]);
    return pendingChannel(credit)[VIA_PENDING_META] ?? "";
  };
  const paidWith = (order: string, email: string, pend: string) => ({
    store: "kiln", order, capture: `CAP${order}`, email, product: "prod01", cents: 4_000, currency: "USD", at: NOW - 60, handle: "kiln", meta: { [VIA_PENDING_META]: pend },
  });

  part("control: a pending link confirmed at the hand-over ties the buyer to the affiliate when remember is true");
  {
    const pend = await pendingAt();
    is("control: the link was pending at checkout", pend.length > 0, true);
    const paid = paidWith("PPORDERREMEMBER1", "kept@example.com", pend);
    await redis.pipeline([["SET", `nl:ppsell:paid:${paid.order}`, JSON.stringify(paid)]]);
    await creditPayPalSale(store, paid, "Glaze course", true, send);
    is("credited to the affiliate", (await sale(`paypal:${paid.order}`))?.aff, ANA);
    is("one bond written", await bondCount(), 1);
  }

  part("remember false: the sale is credited and no bond names the deleted buyer");
  {
    const pend = await pendingAt();
    const paid = paidWith("PPORDERREMEMBER2", "deleted@example.com", pend);
    await redis.pipeline([["SET", `nl:ppsell:paid:${paid.order}`, JSON.stringify(paid)]]);
    await creditPayPalSale(store, paid, "Glaze course", false, send);
    is("still credited to the affiliate", (await sale(`paypal:${paid.order}`))?.aff, ANA);
    is("no new bond", await bondCount(), 1);
    is("no notice sent", sends, 0);
  }
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
