/**
 * The three MEDIUM findings of the money reviews of #3485 (Claude 3, Claude 4, Claude 6; confirmed by Codex G), each
 * against the real writers, book and approval, with the in-memory Redis double and a Stripe stand-in:
 *
 *   - M1: a second tier whose buyer is not confirmed waits whatever its refund status: a partial refund (or a partial
 *     dispute) used to relabel it "partly refunded", which put it in what is paid automatically;
 *   - M2: an affiliate's record that does not read (text that does not parse, a reply that is not text) is not known,
 *     never "no such affiliate": the inviter's own purchase through their recruit's link waits, never earns;
 *   - M3: a membership's renewal paid with no buyer's email waits as "buyer not confirmed", and the creator can approve
 *     it: approving writes that payment down, so the line read from the invoice gives way to it.
 */
import * as affiliates from "@/lib/affiliates";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { approveUnconfirmed, noteSession, readBook } from "@/lib/affiliates";
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_tier_review";
process.env.RESEND_API_KEY = "re_test_tier_review";

const OWNER = "chef@example.com";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const BEA = "eeeeeeeeeeee";
const TIER_BUYER_FROM = (affiliates as unknown as { TIER_BUYER_FROM?: number }).TIER_BUYER_FROM ?? 1_794_182_400;

let refunds: Record<string, unknown>[] = [];
let invoices: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  if (url.pathname === "/v1/refunds") return answer({ object: "list", data: refunds, has_more: false });
  if (url.pathname === "/v1/invoices") return answer({ object: "list", data: invoices, has_more: false });
  const invoice = url.pathname.match(/^\/v1\/invoices\/(in_[A-Za-z0-9_]+)$/);
  if (invoice) {
    const found = invoices.find((row) => row.id === invoice[1]);
    return found ? answer(found) : answer({ error: { message: "no such" } }, 404);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const person = (id: string, email: string, code: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 300 * DAY) * 1000, decidedAt: (NOW - 300 * DAY) * 1000, note: "", ...over });

const order = (id: string, email: string | null) => ({
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
});

/** A membership's renewal sold through Bea's link, paid since TIER_BUYER_FROM, as Stripe lists it, with no buyer's email. */
const renewal = (id: string) => ({
  id,
  object: "invoice",
  status: "paid",
  amount_paid: 4_000,
  currency: "usd",
  created: Math.max(NOW - 3_600, TIER_BUYER_FROM + 60),
  status_transitions: { paid_at: Math.max(NOW - 3_600, TIER_BUYER_FROM + 60) },
  total_taxes: [],
  customer_email: null,
  parent: { subscription_details: { metadata: { store: "harbor", product: "prod01", via: BEA, via_rate: "30", via_months: "12", via_at: String(NOW - 40 * DAY) } } },
  payments: { data: [{ status: "paid", payment: { payment_intent: `pi_${id}` } }] },
});

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestTierReview", true);
  await setSubscription(OWNER, { customerId: "cus_harbor", subscriptionId: "sub_harbor", active: true, tier: "creator", period: paidPeriod() });
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, secondTier: 10 }));
  const store = async () => (await storeForEmail(OWNER))!;
  const statsId = (await store()).statsId!;
  const people = `nl:aff:${statsId}:people`;
  const reset = async () => {
    await redis.pipeline([
      ["HSET", people, ANA, person(ANA, "ana@example.com", "ana")],
      ["HSET", people, BEA, person(BEA, "bea@example.com", "bea", { by: { id: ANA, percent: 10 } })],
    ]);
  };
  await reset();
  const tier = async (ref: string) => (await readBook(await store())).lines.find((l) => l.ref === `tier2:${ref}`);
  const anaPayable = async () => (await readBook(await store())).rows.find((r) => r.affiliate.id === ANA)?.payable ?? 0;

  part("M1: a waiting second tier on a partly refunded sale still waits, out of the payment batch");
  await noteSession(await store(), order("cs_part", null));
  is("control: it waits", [(await tier("cs_part"))?.status, await anaPayable()], ["buyer not confirmed", 0]);
  refunds = [{ id: "re_part1", status: "succeeded", payment_intent: "pi_cs_part", amount: 1_000 }];
  const partly = await tier("cs_part");
  is("partly refunded: still waiting, its commission on what was kept", [partly?.status, partly?.commission], ["buyer not confirmed", 400]);
  is("nothing of it is payable", await anaPayable(), 0);
  is("and it is counted as waiting, so the studio lists it for approval", (await readBook(await store())).unconfirmed, 1);
  refunds = [{ id: "re_part2", status: "succeeded", payment_intent: "pi_cs_part", amount: 5_000 }];
  is("refunded in full: no second tier at all, nothing to wait for", (await tier("cs_part"))?.status ?? "none", "none");
  refunds = [];

  part("M2: an affiliate's record that does not read is not known: the inviter's own purchase waits, never earns");
  for (const [who, id] of [["the inviter", ANA], ["the recruit", BEA]] as const) {
    await redis.pipeline([["HSET", people, id, "{not json"]]);
    const ref = `cs_unread${id === ANA ? "a" : "b"}`;
    await noteSession(await store(), order(ref, "ana@example.com"));
    await reset();
    const line = await tier(ref);
    is(`${who}'s record unreadable: the inviter's own purchase is not paid a second tier`, [line?.status ?? "none", line?.status === "earned"], ["buyer not confirmed", false]);
  }
  // A reply that is not text at all, for the inviter's record only.
  const pipeline = redis.pipeline.bind(redis);
  let once = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const answers = await pipeline(commands);
    return answers.map((a, i) => (once && commands[i][0] === "HGET" && commands[i][1] === people && commands[i][2] === ANA ? ((once = false), 42) : a));
  }) as typeof redis.pipeline;
  try {
    await noteSession(await store(), order("cs_unreadn", "ana@example.com"));
  } finally {
    redis.pipeline = pipeline;
  }
  is("the inviter's record answered 42: waits, never earns", (await tier("cs_unreadn"))?.status, "buyer not confirmed");
  is("nothing of the three is payable to the inviter", await anaPayable(), 0);
  // Control: the records read, and the inviter bought through their recruit's link: no second tier at all.
  await noteSession(await store(), order("cs_ownana", "ana@example.com"));
  is("control: the inviter's own purchase, records read, earns no second tier", (await tier("cs_ownana"))?.status ?? "none", "none");

  part("M3: a membership's renewal paid with no buyer's email waits, and the creator can approve it");
  for (const ref of ["cs_part", "cs_unreada", "cs_unreadb", "cs_unreadn"]) await approveUnconfirmed(await store(), `tier2:${ref}`);
  const before = await anaPayable();
  invoices = [renewal("in_renew1")];
  is("it waits as buyer not confirmed", (await tier("in_renew1"))?.status, "buyer not confirmed");
  is("nothing of it is payable", await anaPayable(), before);
  const approved = await approveUnconfirmed(await store(), "tier2:in_renew1");
  is("approving it works", approved, "approved");
  const after = await tier("in_renew1");
  is("then it earns, once, on its own payment", [after?.status, after?.commission, (await readBook(await store())).lines.filter((l) => l.ref === "tier2:in_renew1").length], ["earned", 400, 1]);
  is("and it is payable", await anaPayable(), before + 400);
  is("approving it again: not waiting", await approveUnconfirmed(await store(), "tier2:in_renew1"), "not-waiting");
  is("an invoice that is not one of the store's waiting lines: gone", await approveUnconfirmed(await store(), "tier2:in_nothere"), "gone");

  done();
}

void main();
