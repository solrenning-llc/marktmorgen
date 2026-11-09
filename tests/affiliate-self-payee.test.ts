/**
 * An affiliate's own purchase, matched by every address that is theirs (lib/affiliates.ts isSelf and the membership
 * payments in recurringReferrals; Claude 5's affiliate audit, MEDIUM 2). Synthetic only. Checked, on every path that
 * credits a sale (a checkout, an offer taken after paying, a PayPal order, a membership payment):
 *
 *   - buying through one's own link with the PayPal address one is paid at, written any way (canonicalEmail), is an own
 *     purchase: it earns nothing and counts toward no monthly bonus;
 *   - so is the creator buying through an affiliate's link, as a lead from the creator is (lib/affiliate-leads.ts);
 *   - a payout address that was written but does not read cannot be told apart: the sale earns nothing, said in the
 *     log, never taken for somebody else's;
 *   - anybody else buying through the link still earns the affiliate their share.
 */
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { creditPayPalSale, noteCharge, noteSession, readBook } from "@/lib/affiliates";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_self_payee_only";
process.env.RESEND_API_KEY = "re_test_affiliate_self_payee_only";

const OWNER = "chef@example.com";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbb";
const CY = "cccccccccccc";
const GONE = "dddddddddddd";

let invoices: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  if (url.pathname.replace(/^\/v1/, "") === "/invoices") return answer({ object: "list", data: invoices, has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const logged: string[] = [];
const quiet = console.error;
console.error = (...args: unknown[]) => {
  logged.push(args.map(String).join(" "));
};

const person = (id: string, email: string, code: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 30 * DAY) * 1000, decidedAt: 1, note: "", ...over });

const order = (id: string, email: string, via: string) => ({
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
  metadata: { store: "harbor", product: "prod01", title: "Bread course", via, via_rate: "30" },
  customer_details: { email },
});

const charge = (id: string, email: string, via: string) => ({
  id,
  status: "succeeded",
  amount: 5_000,
  currency: "usd",
  receipt_email: email,
  created: NOW - 500,
  metadata: { store: "harbor", product: "prod01", title: "Bread course", via, via_rate: "30" },
});

const paypal = (order: string, email: string, aff: string) => ({
  store: "harbor",
  order,
  capture: `CAP${order}`,
  email,
  product: "prod01",
  cents: 5_000,
  currency: "usd",
  at: NOW - 400,
  via: { aff, rate: 30 },
});

const invoice = (id: string, email: string, via: string) => ({
  id,
  status: "paid",
  billing_reason: "subscription_cycle",
  amount_paid: 5_000,
  currency: "usd",
  customer_email: email,
  created: NOW - 300,
  status_transitions: { paid_at: NOW - 300 },
  total_taxes: [],
  parent: { subscription_details: { metadata: { store: "harbor", product: "prod02", via, via_rate: "30", via_months: "3", via_at: String(NOW - 10 * DAY) } } },
  payments: { data: [{ payment: { type: "payment_intent", payment_intent: `pi_${id}` } }] },
});

async function setup(over: Record<string, unknown> = {}): Promise<Store> {
  redis.clear();
  invoices = [];
  logged.length = 0;
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSelfPay01", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, recurring: 3, ...over }));
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana", { paypal: "ana.payouts@example.org" })],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
    ["HSET", `nl:aff:${statsId}:people`, BEN, person(BEN, "ben@example.com", "ben")],
    ["HSET", `nl:aff:${statsId}:codes`, "ben", BEN],
    // A payout address written, but not one that reads as an address.
    ["HSET", `nl:aff:${statsId}:people`, CY, person(CY, "cy@example.com", "cy", { paypal: "cy at example dot org" })],
    ["HSET", `nl:aff:${statsId}:codes`, "cy", CY],
  ]);
  return store;
}

const lineOf = async (store: Store, ref: string) => (await readBook(store)).lines.find((l) => l.ref === ref);
const outcome = async (store: Store, ref: string) => {
  const line = await lineOf(store, ref);
  return [line?.status, line?.commission];
};
const OWN = ["own purchase", 0];
const EARNED = ["earned", 1_500];

async function main(): Promise<void> {
  part("A checkout through one's own link");
  {
    const store = await setup();
    await noteSession(store, order("cs_pay1", "ana.payouts@example.org", ANA));
    is("Ana paying with the PayPal address she is paid at is her own purchase", await outcome(store, "cs_pay1"), OWN);
    await noteSession(store, order("cs_pay2", "Ana.Payouts+treats@Example.org", ANA));
    is("written another way, the same inbox", await outcome(store, "cs_pay2"), OWN);
    await noteSession(store, order("cs_own1", "ana@example.com", ANA));
    is("with the address she joined with, as before", await outcome(store, "cs_own1"), OWN);
    await noteSession(store, order("cs_chef", "Chef@example.com", ANA));
    is("the creator buying through Ana's link earns her nothing", await outcome(store, "cs_chef"), OWN);
    await noteSession(store, order("cs_kai1", "kai@example.com", ANA));
    is("somebody else buying through her link earns her 30% of 5,000", await outcome(store, "cs_kai1"), EARNED);
    await noteSession(store, order("cs_ben1", "ana.payouts@example.org", BEN));
    is("Ana buying through Ben's link earns Ben his share", await outcome(store, "cs_ben1"), EARNED);
  }

  part("An own purchase counts toward no monthly bonus");
  {
    const store = await setup({ bonuses: [{ sales: 2, cents: 5_000 }] });
    await noteSession(store, order("cs_b1", "ana.payouts@example.org", ANA));
    await noteSession(store, order("cs_b2", "kai@example.com", ANA));
    const book = await readBook(store);
    is("two sales through the link, one her own: no bonus", book.lines.filter((l) => l.how === "bonus" && l.aff === ANA).length, 0);
    await noteSession(store, order("cs_b3", "lia@example.com", ANA));
    is("two from other people reach the goal", (await readBook(store)).lines.filter((l) => l.how === "bonus" && l.aff === ANA).map((l) => l.commission), [5_000]);
  }

  part("An offer taken after paying");
  {
    const store = await setup();
    await noteCharge(store, charge("pi_up1", "ana.payouts@example.org", ANA));
    is("paid with her payout address: her own", await outcome(store, "pi_up1"), OWN);
    await noteCharge(store, charge("pi_up2", "chef@example.com", ANA));
    is("the creator's own: nothing", await outcome(store, "pi_up2"), OWN);
    await noteCharge(store, charge("pi_up3", "kai@example.com", ANA));
    is("somebody else's: her share", await outcome(store, "pi_up3"), EARNED);
  }

  part("A PayPal order");
  {
    const store = await setup();
    await creditPayPalSale(store, paypal("PPSELF1", "ana.payouts@example.org", ANA), "Bread course");
    is("paid from her own PayPal account: her own", await outcome(store, "paypal:PPSELF1"), OWN);
    await creditPayPalSale(store, paypal("PPCHEF1", "chef@example.com", ANA), "Bread course");
    is("the creator's own: nothing", await outcome(store, "paypal:PPCHEF1"), OWN);
    await creditPayPalSale(store, paypal("PPKAI1", "kai@example.com", ANA), "Bread course");
    is("somebody else's: her share", await outcome(store, "paypal:PPKAI1"), EARNED);
  }

  part("A membership payment");
  {
    const store = await setup();
    invoices = [
      invoice("in_SelfPay00001", "ana.payouts+club@example.org", ANA),
      invoice("in_SelfChef0001", "chef@example.com", ANA),
      invoice("in_SelfKai00001", "kai@example.com", ANA),
    ];
    is("paid with her payout address: her own", await outcome(store, "in_SelfPay00001"), OWN);
    is("the creator's own: nothing", await outcome(store, "in_SelfChef0001"), OWN);
    is("somebody else's: her share", await outcome(store, "in_SelfKai00001"), EARNED);
  }

  part("A payout address that does not read: nothing is paid, and the log says why");
  {
    const store = await setup();
    await noteSession(store, order("cs_cy1", "kai@example.com", CY));
    is("a checkout through Cy's link earns nothing", (await lineOf(store, "cs_cy1"))?.commission, 0);
    is("said in the log", logged.some((l) => l.includes(CY) && /could not be read/.test(l)), true);
    await noteCharge(store, charge("pi_cy1", "kai@example.com", CY));
    await creditPayPalSale(store, paypal("PPCY1", "kai@example.com", CY), "Bread course");
    invoices = [invoice("in_SelfCy000001", "kai@example.com", CY)];
    const book = await readBook(store);
    is("nor an offer, a PayPal order or a membership payment", ["pi_cy1", "paypal:PPCY1", "in_SelfCy000001"].map((ref) => book.lines.find((l) => l.ref === ref)?.commission), [0, 0, 0]);
    logged.length = 0;
    await noteSession(store, order("cs_gone1", "kai@example.com", GONE));
    is("an affiliate whose record is not there cannot be told apart either", (await lineOf(store, "cs_gone1"))?.commission ?? 0, 0);
  }

  console.error = quiet;
  done();
}

void main();
