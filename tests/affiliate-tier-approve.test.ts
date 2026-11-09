/**
 * A second tier waiting as "buyer not confirmed" (owner, through Claude 1, 9 November 2026, 15h42), parts (b) and (c):
 * the creator approves one such line in person (the studio's route, with a review and a confirmation before it), which
 * puts it in the next payment batch; and the month's counts of this path are kept, numbers only, for the owner's
 * monthly report (how many orders fall here, how many the job decided, how many the creator approved, how many
 * requests it took). Synthetic only: the in-memory Redis double, through the real route.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import * as affiliates from "@/lib/affiliates";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { noteSession, readBook } from "@/lib/affiliates";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_tier_approve";
process.env.RESEND_API_KEY = "re_test_tier_approve";

const OWNER = "chef@example.com";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const BEA = "eeeeeeeeeeee";

type Month = Record<"waited" | "decided" | "approved" | "failed" | "reads", number>;
const monthOf = (affiliates as unknown as { unconfirmedMonth?: (month: string) => Promise<Month | null> }).unconfirmedMonth ?? (async () => null);
const settle = (affiliates as unknown as { settleUnconfirmed?: (store: unknown, now?: number) => Promise<{ decided: number }> }).settleUnconfirmed;
const THIS_MONTH = new Date().toISOString().slice(0, 7);

const sessions: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  const one = url.pathname.match(/^\/v1\/checkout\/sessions\/([A-Za-z0-9_]+)$/);
  if (one) return sessions[one[1]] ? answer(sessions[one[1]]) : answer({ error: { message: "no such" } }, 404);
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const person = (id: string, email: string, code: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 300 * DAY) * 1000, decidedAt: (NOW - 300 * DAY) * 1000, note: "", ...over });

const order = (id: string) => ({
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
  customer_details: { email: null },
});

type Reply = { status: number; body: { ok?: boolean; error?: string } };

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestTierApprove1", true);
  await setSubscription(OWNER, { customerId: "cus_harbor", subscriptionId: "sub_harbor", active: true, tier: "creator", period: paidPeriod() });
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, secondTier: 10 }));
  const store = async () => (await storeForEmail(OWNER))!;
  const statsId = (await store()).statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana")],
    ["HSET", `nl:aff:${statsId}:people`, BEA, person(BEA, "bea@example.com", "bea", { by: { id: ANA, percent: 10 } })],
  ]);
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const post = async (body: Record<string, unknown>): Promise<Reply> => {
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply["body"] };
  };
  const kept = async (ref: string) => {
    const [raw] = (await redis.pipeline([["HGET", `nl:aff:${statsId}:sales`, ref]])) as [string | null];
    return raw ? (JSON.parse(raw) as { buyerUnknown?: number; tierOff?: number }) : null;
  };
  const tier = async (ref: string) => (await readBook(await store())).lines.find((l) => l.ref === `tier2:${ref}`);

  part("B1: the creator approves one waiting line in person: it joins the payment batch");
  await noteSession(await store(), order("cs_wait1"));
  await noteSession(await store(), order("cs_wait2"));
  is("both wait", [(await tier("cs_wait1"))?.status, (await tier("cs_wait2"))?.status], ["buyer not confirmed", "buyer not confirmed"]);
  const before = (await readBook(await store())).rows.find((r) => r.affiliate.id === ANA);
  is("nothing of the tier is payable yet", before?.payable, 0);
  const approved = await post({ action: "tier-confirm", ref: "tier2:cs_wait1" });
  is("approved", [approved.status, approved.body.ok], [200, true]);
  is("the sale no longer waits, and has no tierOff", [(await kept("cs_wait1"))?.buyerUnknown, (await kept("cs_wait1"))?.tierOff], [undefined, undefined]);
  const book = await readBook(await store());
  is("its tier is earned and payable; the other still waits", [(await tier("cs_wait1"))?.status, book.rows.find((r) => r.affiliate.id === ANA)?.payable, (await tier("cs_wait2"))?.status], ["earned", 500, "buyer not confirmed"]);
  is("one is counted as waiting", book.unconfirmed, 1);

  part("B2: pressing it twice, a sale that does not wait, a sale that is not there, a ref that is not one");
  const twice = await post({ action: "tier-confirm", ref: "tier2:cs_wait1" });
  is("again: refused, nothing changed", [twice.status, twice.body.error], [409, "not_waiting"]);
  const nobody = await post({ action: "tier-confirm", ref: "tier2:cs_nope" });
  is("none such: refused", [nobody.status, nobody.body.error], [404, "gone"]);
  for (const bad of ["", "tier2:", "x y", "tier2:cs_wait2 ", "a".repeat(400), 5]) {
    const refused = await post({ action: "tier-confirm", ref: bad });
    is(`not a reference: ${JSON.stringify(bad).slice(0, 20)}`, [refused.status, refused.body.error], [400, "unknown"]);
  }
  is("the other sale still waits after all of that", (await kept("cs_wait2"))?.buyerUnknown, 1);
  const others = await post({ action: "tier-confirm", ref: "cs_wait2" });
  is("the sale's own reference is read as well", [others.status, others.body.ok], [200, true]);

  part("C1: the month's counts, numbers only");
  sessions.cs_job1 = { id: "cs_job1", customer_details: { email: "kai@example.com" } };
  await noteSession(await store(), order("cs_job1"));
  await settle?.(await store(), NOW + 60);
  const month = await monthOf(THIS_MONTH);
  is("three waited, one decided by the job, two approved by the creator, one request, none failed", month, { waited: 3, decided: 1, approved: 2, failed: 0, reads: 1 });
  const [fields] = (await redis.pipeline([["HGETALL", `nl:aff:unc:month:${THIS_MONTH}`]])) as [string[]];
  is("only the five names and their numbers are kept: no store, no person", (fields ?? []).filter((_, i) => i % 2 === 0).sort(), ["approved", "decided", "reads", "waited"]);
  is("a month that is not one reads nothing", await monthOf("2026-13-01"), null);

  part("S1: what the studio and the affiliate see, in plain English");
  const root = process.cwd();
  const read = (file: string) => {
    try {
      return readFileSync(join(root, file), "utf8");
    } catch {
      return "";
    }
  };
  const history = read("components/affiliate-commission-history.tsx");
  is("the creator's history names the state instead of calling it a partial refund", /buyer not confirmed/i.test(history), true);
  const panel = read("components/affiliate-unconfirmed.tsx");
  is("the panel asks before it approves (3.3.6) and says what approving does", [/Approve/.test(panel), /next payment/i.test(panel), /Cancel/.test(panel), /tier-confirm/.test(panel)], [true, true, true, true]);
  is("it announces results to a screen reader and keeps targets 44px", [/role="status"|role="alert"/.test(panel), /min-h-11|min-h-\[44px\]/.test(panel)], [true, true]);
  is("the studio shows it", /AffiliateUnconfirmed/.test(read("components/affiliate-studio.tsx")), true);
  is("the affiliate's page says it, in words", /"buyer not confirmed"/.test(read("lib/buyer-words/affiliates.ts")), true);
  is("the sweep reads waiting sales again", /settleUnconfirmed/.test(read("lib/checkout-sweep.ts")), true);
  done();
}

void main();
