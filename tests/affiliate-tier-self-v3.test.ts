/**
 * The pre-review of claude5/affiliate-tier-self-v2 @389f54dcb3, its proofs kept as checks, with the decisions that
 * followed it (coordinator, and Claude 1 for the owner, 9 November 2026, 15h42):
 *
 *   1  the second tier on a sale is decided when the sale is written down (tierOff: its buyer is the inviting
 *      affiliate or the recruit, by inbox or payout address), no buyer's mark is kept; a NEW sale whose order names
 *      no buyer is neither paid nor denied its second tier: it waits, shown as "buyer not confirmed", out of what is
 *      paid automatically (the creator may pay it by hand), and the book counts how many wait so;
 *   2  idleSweep reads the second tier by the same rule as readBook, so an inviter owed nothing is removed;
 *   3  isSelf reads the affiliate's inbox or payout address, as isOwn does, so a recruit buying through their own
 *      link with their payout address earns nothing on it.
 *
 * Rule 23: P1 expected the second tier on a sale with no buyer to be denied (fail-closed); by the 15h42 decision it
 * waits instead, so P1 checks it is not paid automatically and is shown as waiting. P3, a defect from before, is
 * fixed here.
 */
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { idleSweep, noteCharge, noteSession, readAffiliate, readBook } from "@/lib/affiliates";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_prerev_tier_only";
process.env.RESEND_API_KEY = "re_test_prerev_tier_only";

const OWNER = "chef@example.com";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const BEA = "eeeeeeeeeeee";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const person = (id: string, email: string, code: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 300 * DAY) * 1000, decidedAt: (NOW - 300 * DAY) * 1000, note: "", ...over });

async function setup(extra: Record<string, unknown> = {}) {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPrerevTr1", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, secondTier: 10, ...extra }));
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana")],
    ["HSET", `nl:aff:${statsId}:people`, BEA, person(BEA, "bea@example.com", "bea", { by: { id: ANA, percent: 10 } })],
  ]);
  return { store, statsId };
}

const order = (id: string, email: string | null, at = NOW - 600) => ({
  id,
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: at,
  amount_total: 5_000,
  amount_subtotal: 5_000,
  currency: "usd",
  total_details: { amount_tax: 0 },
  payment_intent: `pi_${id}`,
  metadata: { store: "harbor", product: "prod01", title: "Bread course", via: BEA, via_rate: "30" },
  customer_details: { email },
});

async function main(): Promise<void> {
  part("P1: an order naming no buyer: its second tier waits, never paid automatically");
  {
    const { store, statsId } = await setup();
    await noteCharge(store, { id: "pi_noemail1", status: "succeeded", amount: 5_000, currency: "usd", created: NOW - 60, metadata: { store: "harbor", product: "prod01", title: "Jam", kind: "upsell", parent: "cs_x", via: BEA, via_rate: "30" } });
    await noteSession(store, order("cs_noemail", null));
    const raw = await redis.pipeline([["HGET", `nl:aff:${statsId}:sales`, "cs_noemail"], ["HGET", `nl:aff:${statsId}:sales`, "pi_noemail1"]]);
    is("written with no buyer's mark at all", raw.map((r) => "buyerMark" in JSON.parse(String(r))), [false, false]);
    is("and marked as a sale whose buyer is not confirmed", raw.map((r) => JSON.parse(String(r)).buyerUnknown), [1, 1]);
    const book = await readBook(store);
    const tier = ["tier2:cs_noemail", "tier2:pi_noemail1"].map((ref) => book.lines.find((l) => l.ref === ref));
    is("its second tier is shown, waiting: buyer not confirmed", tier.map((l) => l?.status), ["buyer not confirmed", "buyer not confirmed"]);
    const ana = book.rows.find((r) => r.affiliate.id === ANA);
    is("never in what is paid automatically", ana?.payable, 0);
    is("but owed, so a payment by hand settles it", (ana?.owed ?? 0) >= 1_000, true);
    is("the book counts the sales waiting so, with no personal data", book.unconfirmed, 2);
  }
  part("P1b: the inviter buying through the recruit's link: decided when written, never paid");
  {
    const { store, statsId } = await setup();
    await noteSession(store, order("cs_anaown", "Ana+x@Example.com"));
    const [raw] = await redis.pipeline([["HGET", `nl:aff:${statsId}:sales`, "cs_anaown"]]);
    is("written with tierOff, no mark", [JSON.parse(String(raw)).tierOff, "buyerMark" in JSON.parse(String(raw))], [1, false]);
    is("no second tier", (await readBook(store)).lines.some((l) => l.ref === "tier2:cs_anaown"), false);
    await noteSession(store, order("cs_kai", "kai@example.com"));
    is("somebody else's purchase: the second tier is paid as before", (await readBook(store)).lines.find((l) => l.ref === "tier2:cs_kai")?.commission, 500);
  }

  part("P2: idleSweep still counts the tier the book no longer pays, so the inviter is never warned or removed");
  {
    const { store } = await setup({ idle: 90 });
    const s2 = (await storeForEmail(OWNER))!;
    await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...s2.affiliates, idle: 90, idleOn: NOW - 250 * DAY }));
    const st = (await storeForEmail(OWNER))!;
    // Ana bought through Bea's link 200 days ago, with her own inbox: the book owes her nothing on it.
    await noteSession(st, order("cs_anaold", "ana@example.com", NOW - 600));
    const owedAna = (await readBook(st)).lines.filter((l) => l.aff === ANA).reduce((s, l) => s + l.commission, 0);
    is("the book owes Ana nothing", owedAna, 0);
    await redis.pipeline([["HSET", `nl:aff:${st.statsId}:people`, ANA, person(ANA, "ana@example.com", "ana", { warned: NOW + 100 * DAY })]]);
    await idleSweep(st, Date.now() + 200 * DAY * 1000);
    // Expected: Ana, idle for 200 days and owed nothing, is warned. Observed: not warned (owedHigh counts the tier).
    is("Ana, owed nothing, warned and idle past the date, is removed", (await readAffiliate(st, ANA))?.status, "removed");
    void store;
  }
  part("P2 control: the same sale bought by somebody else, its tier (500) paid: Ana is removed");
  {
    await setup();
    const s2 = (await storeForEmail(OWNER))!;
    await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...s2.affiliates, idle: 90, idleOn: NOW - 250 * DAY }));
    const st = (await storeForEmail(OWNER))!;
    await noteSession(st, order("cs_kaiold", "kai@example.com", NOW - 600));
    await redis.pipeline([["HSET", `nl:aff:${st.statsId}:payouts`, "p1", JSON.stringify({ id: "p1", aff: ANA, cents: 500, currency: "usd", date: "2026-10-01", reference: "cash", at: 1 })]]);
    await redis.pipeline([["HSET", `nl:aff:${st.statsId}:people`, ANA, person(ANA, "ana@example.com", "ana", { warned: NOW + 100 * DAY })]]);
    await idleSweep(st, Date.now() + 200 * DAY * 1000);
    is("control: Ana, paid her 500, warned and idle past the date, is removed", (await readAffiliate(st, ANA))?.status, "removed");
  }
  part("P3 (pre-existing, same promise): the recruit buying through her own link with her payout address still earns her own commission");
  {
    const { store, statsId } = await setup();
    await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, BEA, person(BEA, "bea@example.com", "bea", { paypal: "bea.pay@example.org", by: { id: ANA, percent: 10 } })]]);
    await noteSession(store, order("cs_beapay", "bea.pay@example.org"));
    const lines = (await readBook(store)).lines;
    is("tier denied (this branch)", lines.find((l) => l.ref === "tier2:cs_beapay")?.commission ?? 0, 0);
    is("own commission on her own purchase: none expected", lines.find((l) => l.ref === "cs_beapay")?.commission, 0);
  }
  done();
}

void main();
