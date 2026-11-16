/**
 * Main's `remember` on creditPayPalSale (false: the buyer, deleted from the store at their own request, is not tied to
 * the affiliate; lib/paypal-delivery.ts) holds for a PayPal sale whose link was pending at checkout too: when the link
 * is confirmed at the hand-over, the sale is credited and no bond names the buyer. Found merging main into #3479.
 *
 * The sweep's pass (notePayPalPendings) holds it too (Claude 4 cloud AB, MEDIUM on #3479): a link still unread at the
 * hand-over of a buyer deleted at their own request since paying, confirmed later by the sweep, credits the sale with no
 * bond; a deletion mark that does not read leaves the order on the list, uncredited, for the next pass (rule 24); and a
 * deletion completed between the sweep's read and the bond takes the bond back.
 */
import { NO_AFFILIATES, parseAffiliateSetting, viaCookieValue } from "@/lib/affiliate-setting";
import type { SendOutcome } from "@/lib/email";
import { VIA_PENDING_META, attributionOrPending, creditPayPalSale, notePayPalPendings, pendingChannel } from "@/lib/affiliates";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, storeForEmail, storeRef } from "@/lib/store";
import { ownErasureCommand, ownErasureField, suppressedKey } from "@/lib/suppression";
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
  await ensureListId(storeRef(store));
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

  const listId = store.listId!;
  const sellsPayPal = { ...store, paypalSeller: { merchant: "SYNTHETICMERCH1", at: NOW } } as typeof store;
  const listed = async (order: string) => (await redis.pipeline([["ZSCORE", `nl:aff:pend:pp:${statsId}`, order]]))[0] !== null;
  // A pending link that does not read at the hand-over either (decidePending answers unknown): the order stays on the
  // sweep's list, and the person was deleted at their own request after paying (the mark the hand-over read).
  const unreadAtHandOver = async (order: string, email: string) => {
    const pend = await pendingAt();
    const paid = paidWith(order, email, pend);
    await redis.pipeline([["SET", `nl:ppsell:paid:${paid.order}`, JSON.stringify(paid)], ["HSET", codes, "ana", JSON.stringify({ not: "an id" })]]);
    await creditPayPalSale(store, paid, "Glaze course", false, send);
    await redis.pipeline([["HSET", codes, "ana", ANA]]);
    return paid;
  };

  part("the sweep confirms the link of a buyer deleted at their own request: credited, and no bond names them");
  {
    const paid = await unreadAtHandOver("PPORDERREMEMBER3", "gone@example.com");
    is("not credited at the hand-over", await sale(`paypal:${paid.order}`), null);
    is("kept on the sweep's list", await listed(paid.order), true);
    await redis.pipeline([ownErasureCommand(listId, paid.email, NOW)]);
    await notePayPalPendings(sellsPayPal, NOW + 300, send);
    is("credited by the sweep", (await sale(`paypal:${paid.order}`))?.aff, ANA);
    is("no bond names the deleted buyer", await bondCount(), 1);
    is("off the list once decided", await listed(paid.order), false);
  }

  part("a deletion mark that does not read: the sweep credits nothing and keeps the order for its next pass (rule 24)");
  for (const [n, odd] of [["4", "soon"], ["5", 7], ["6", "?"]] as const) {
    const paid = await unreadAtHandOver(`PPORDERREMEMBER${n}`, `odd${n}@example.com`);
    const mark = ownErasureField(listId, paid.email);
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (b: Parameters<typeof real>[0]) =>
      b.length === 1 && b[0][0] === "HGET" && b[0][1] === suppressedKey(listId) && b[0][2] === mark ? [odd] : real(b)) as typeof redis.pipeline;
    const failed = await notePayPalPendings(sellsPayPal, NOW + 300, send);
    redis.pipeline = real;
    is(`mark ${JSON.stringify(odd)}: counted as not read`, failed, 1);
    is(`mark ${JSON.stringify(odd)}: not credited on a guess`, await sale(`paypal:${paid.order}`), null);
    is(`mark ${JSON.stringify(odd)}: no bond`, await bondCount(), 1);
    is(`mark ${JSON.stringify(odd)}: still on the list`, await listed(paid.order), true);
    await redis.pipeline([["ZREM", `nl:aff:pend:pp:${statsId}`, paid.order]]);
  }

  part("a deletion completed between the sweep's read and the bond: the bond is taken back");
  {
    const paid = await unreadAtHandOver("PPORDERREMEMBER7", "raced@example.com");
    const mark = ownErasureField(listId, paid.email);
    const real = redis.pipeline.bind(redis);
    let fired = false;
    redis.pipeline = (async (b: Parameters<typeof real>[0]) => {
      const answer = await real(b);
      if (!fired && b.length === 1 && b[0][0] === "HGET" && b[0][1] === suppressedKey(listId) && b[0][2] === mark) {
        fired = true;
        await real([ownErasureCommand(listId, paid.email, NOW + 1)]);
      }
      return answer;
    }) as typeof redis.pipeline;
    await notePayPalPendings(sellsPayPal, NOW + 300, send);
    redis.pipeline = real;
    is("the race was staged", fired, true);
    is("credited by the sweep", (await sale(`paypal:${paid.order}`))?.aff, ANA);
    is("the bond written before the deletion was seen is taken back", await bondCount(), 1);
  }

  part("taking the bond back does not answer: the order stays on the list and the next pass takes it back");
  {
    const paid = await unreadAtHandOver("PPORDERREMEMBER8", "lost@example.com");
    const mark = ownErasureField(listId, paid.email);
    const real = redis.pipeline.bind(redis);
    let fired = false;
    let forgets = 0;
    redis.pipeline = (async (b: Parameters<typeof real>[0]) => {
      if (b.length === 1 && b[0][0] === "EVAL" && b[0][3] === `nl:aff:${statsId}:bond`) {
        forgets += 1;
        return ["?"];
      }
      const answer = await real(b);
      if (!fired && b.length === 1 && b[0][0] === "HGET" && b[0][1] === suppressedKey(listId) && b[0][2] === mark) {
        fired = true;
        await real([ownErasureCommand(listId, paid.email, NOW + 1)]);
      }
      return answer;
    }) as typeof redis.pipeline;
    const failed = await notePayPalPendings(sellsPayPal, NOW + 300, send);
    redis.pipeline = real;
    is("the forget was asked and did not answer", [fired, forgets, failed], [true, 1, 1]);
    is("the bond is still there for now", await bondCount(), 2);
    is("the order is kept on the list", await listed(paid.order), true);
    await notePayPalPendings(sellsPayPal, NOW + 600, send);
    is("the next pass takes the bond back", await bondCount(), 1);
    is("and the order leaves the list", await listed(paid.order), false);
    is("credited once", (await sale(`paypal:${paid.order}`))?.aff, ANA);
  }
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
