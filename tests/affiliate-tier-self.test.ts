/**
 * The second tier is never earned on the inviting affiliate's own purchase
 * (lib/affiliates.ts tierLines, Claude 5's affiliate audit, MEDIUM 4, 9 November
 * 2026). The programme's words promise that one's own purchases never earn;
 * before this, a sale kept no trace of who bought it, so Ana, who invited Bea,
 * could buy through Bea's link and earn her second tier on her own money.
 *
 * Checked, through the real writers (a checkout, an offer after paying, a
 * PayPal order, a membership's invoice) and the real book:
 *
 *   - Ana buying through Bea's link earns no second tier, under any spelling
 *     of her inbox and with her payout address; Bea's own line is as before;
 *   - Bea buying through her own link with her payout address earns her
 *     inviter nothing either;
 *   - anybody else's purchase through Bea's link still earns Ana her tier;
 *   - each sale keeps a one-way mark of its buyer for this store only, never
 *     the address, and the book's lines never carry it out;
 *   - a sale written down before the mark was kept is not known, and its
 *     second tier is read as it always was (never 0 by guess, never more).
 */
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { creditPayPalSale, noteCharge, noteSession, readBook } from "@/lib/affiliates";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_tier_self_only";
process.env.RESEND_API_KEY = "re_test_tier_self_only";

const OWNER = "chef@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const BEA = "eeeeeeeeeeee";
const ANA_PAYS = "ana.payouts@example.org";
const BEA_PAYS = "bea.pay@example.org";

let invoices: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  if (url.pathname.replace(/^\/v1/, "") === "/invoices") return answer({ object: "list", data: invoices, has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const person = (id: string, email: string, code: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "", ...over });

const order = (id: string, email: string, over: Record<string, unknown> = {}) => ({
  id,
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW - 600,
  amount_total: 5_000,
  amount_subtotal: 5_000,
  currency: "usd",
  total_details: { amount_tax: 0 },
  payment_intent: `pi_${id}`,
  metadata: { store: "harbor", product: "prod01", title: "Bread course", via: BEA, via_rate: "30" },
  customer_details: { email },
  ...over,
});

const invoice = (id: string, email: string) => ({
  id,
  status: "paid",
  billing_reason: "subscription_cycle",
  amount_paid: 5_000,
  currency: "usd",
  customer_email: email,
  created: NOW - 900,
  status_transitions: { paid_at: NOW - 900 },
  total_taxes: [],
  parent: { subscription_details: { metadata: { store: "harbor", product: "prod01", via: BEA, via_rate: "30", kind: "plan" } } },
  payments: { data: [{ payment: { type: "payment_intent", payment_intent: `pi_${id}` } }] },
});

async function setup() {
  redis.clear();
  invoices = [];
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestTierSelf1", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, secondTier: 10 }));
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana", { paypal: ANA_PAYS })],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
    ["HSET", `nl:aff:${statsId}:people`, BEA, person(BEA, "bea@example.com", "bea", { paypal: BEA_PAYS, by: { id: ANA, percent: 10 } })],
    ["HSET", `nl:aff:${statsId}:codes`, "bea", BEA],
  ]);
  return { store, statsId };
}

const tierOf = async (store: Awaited<ReturnType<typeof setup>>["store"], ref: string) => {
  const lines = (await readBook(store)).lines;
  return { tier: lines.find((l) => l.ref === `tier2:${ref}`)?.commission ?? 0, own: lines.find((l) => l.ref === ref)?.commission ?? null };
};

async function main(): Promise<void> {
  part("A checkout: the inviting affiliate buys through her recruit's link");
  {
    const { store } = await setup();
    await noteSession(store, order("cs_ana1", "ana@example.com"));
    const { tier, own } = await tierOf(store, "cs_ana1");
    is("Ana earns no second tier on what she bought herself", tier, 0);
    // Not this change's to decide: the recruit's own share of a sale she brought is unchanged.
    is("Bea's own line is as before", own, 1_500);
  }
  for (const [label, email] of [
    ["her inbox written another way", "Ana+Bread@Example.com"],
    ["her payout address", ANA_PAYS],
  ] as const) {
    const { store } = await setup();
    await noteSession(store, order("cs_ana2", email));
    is(`nor with ${label}`, (await tierOf(store, "cs_ana2")).tier, 0);
  }
  {
    const { store } = await setup();
    await noteSession(store, order("cs_bea1", BEA_PAYS));
    is("the recruit buying through her own link with her payout address earns her inviter nothing", (await tierOf(store, "cs_bea1")).tier, 0);
  }
  {
    const { store } = await setup();
    await noteSession(store, order("cs_kai1", "kai@example.com"));
    is("anybody else's purchase through Bea's link still earns Ana her tier", (await tierOf(store, "cs_kai1")).tier, 500);
  }

  part("The other writers of a sale");
  {
    const { store } = await setup();
    await noteCharge(store, { id: "pi_offer01", status: "succeeded", amount: 5_000, currency: "usd", created: NOW - 300, receipt_email: "ana@example.com", metadata: { store: "harbor", product: "prod01", title: "Bread course", via: BEA, via_rate: "30" } });
    is("an offer taken after paying, by Ana through Bea's link: no second tier", (await tierOf(store, "pi_offer01")).tier, 0);
  }
  {
    const { store } = await setup();
    await creditPayPalSale(store, { store: "harbor", order: "PPORDERTIER01", capture: "CAPTIER01", email: "ana@example.com", product: "prod01", cents: 5_000, currency: "USD", at: NOW - 300, via: { aff: BEA, rate: 30 } }, "Bread course");
    is("a PayPal order, by Ana through Bea's link: no second tier", (await tierOf(store, "paypal:PPORDERTIER01")).tier, 0);
  }
  {
    const { store } = await setup();
    invoices = [invoice("in_TierSelf0001", "ana@example.com"), invoice("in_TierOther001", "kai@example.com")];
    is("a membership's invoice paid by Ana through Bea's link: no second tier", (await tierOf(store, "in_TierSelf0001")).tier, 0);
    is("and one paid by anybody else: the tier, as before", (await tierOf(store, "in_TierOther001")).tier, 500);
  }

  // Regra 23 (tier-self-v3, 9 November 2026): the buyer's mark is no longer kept; what is kept is tierOff, decided
  // when the sale is written, and never the address nor any mark of it.
  part("What is kept: the decision, never the address nor a mark of it");
  {
    const { store, statsId } = await setup();
    await noteSession(store, order("cs_ana3", "Ana+x@Example.com."));
    const [raw] = (await redis.pipeline([["HGET", `nl:aff:${statsId}:sales`, "cs_ana3"]])) as [string];
    const kept = JSON.parse(raw) as Record<string, unknown>;
    is("the sale keeps tierOff, one inbox however it is written", [kept.tierOff, "buyerMark" in kept], [1, false]);
    is("never the address or its name", [raw.toLowerCase().includes("ana@example.com"), raw.toLowerCase().includes("\"ana")], [false, false]);
    await noteSession(store, order("cs_kai3", "kai@example.com"));
    const [other] = (await redis.pipeline([["HGET", `nl:aff:${statsId}:sales`, "cs_kai3"]])) as [string];
    is("somebody else's purchase keeps nothing about its buyer", ["tierOff" in JSON.parse(other), "buyerUnknown" in JSON.parse(other)], [false, false]);
  }

  part("A sale written down before the decision was kept");
  {
    const { store, statsId } = await setup();
    await redis.pipeline([
      ["HSET", `nl:aff:${statsId}:sales`, "cs_old1", JSON.stringify({ ref: "cs_old1", pi: "pi_cs_old1", aff: BEA, at: NOW - 3_600, product: "prod01", title: "Bread course", base: 5_000, total: 5_000, currency: "usd", rate: 30, self: false, how: "click" })],
    ]);
    // Its buyer is not known: the second tier stays as it was read, neither guessed away nor raised.
    is("its second tier is read as before", (await tierOf(store, "cs_old1")).tier, 500);
    await redis.pipeline([
      ["HSET", `nl:aff:${statsId}:sales`, "cs_old2", JSON.stringify({ ref: "cs_old2", pi: "pi_cs_old2", aff: BEA, at: NOW - 3_600, product: "prod01", title: "Bread course", base: 5_000, total: 5_000, currency: "usd", rate: 30, self: false, how: "click", tierOff: "yes" })],
    ]);
    // Regra 23: was a buyerMark that did not read; now a tierOff that is not 1.
    is("a decision that does not read is not taken either", (await tierOf(store, "cs_old2")).tier, 500);
  }

  done();
}

void main();
