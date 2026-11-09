/**
 * Claude 6's money review of #3485 (CX-116), kept as checks: what waits for its buyer waits whatever else happened to
 * it, an off-shape record is unknown and never "no such affiliate", a renewal can be approved, the re-reads are
 * bounded when Stripe keeps failing, the two rewrites of a sale cannot undo each other, and the first tier is held
 * on an unknown buyer as the second is (rule 30).
 */
import { settleUnconfirmed, approveUnconfirmed, noteSession, readBook, TIER_BUYER_FROM } from "@/lib/affiliates";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_tier_review";
process.env.RESEND_API_KEY = "re_test_tier_review";

const OWNER = "chef@example.com";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const ANA = "aaaaaaaaaaaa";
const BEA = "eeeeeeeeeeee";

let refunds: Record<string, unknown>[] = [];
let invoices: Record<string, unknown>[] = [];
let sessions: Record<string, unknown> = {};
let down = false;
let asked = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  if (path === "/refunds") return answer({ object: "list", data: refunds, has_more: false });
  if (path === "/invoices") return answer({ object: "list", data: invoices, has_more: false });
  const one = path.match(/^\/checkout\/sessions\/([A-Za-z0-9_]+)$/);
  if (one) {
    asked += 1;
    if (down) return answer({ error: { message: "down" } }, 500);
    return sessions[one[1]] ? answer(sessions[one[1]]) : answer({ error: { message: "no such" } }, 404);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

// Hooks on the in-memory Redis: one off-shape answer for a record, and a change slipped in after a read of a sale.
const real = redis.pipeline.bind(redis);
let offShape: string | null = null;
let keepOff = false;
let slipIn: { ref: string; write: string } | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const one = commands.length === 1 ? commands[0] : null;
  if (offShape && one?.[0] === "HGET" && /^nl:aff:[^:]+:people$/.test(String(one[1])) && one[2] === offShape) {
    if (!keepOff) offShape = null;
    return [42];
  }
  const result = await real(commands);
  if (slipIn && one?.[0] === "HGET" && /^nl:aff:[^:]+:sales$/.test(String(one[1])) && one[2] === slipIn.ref) {
    const { ref, write } = slipIn;
    slipIn = null;
    await real([["HSET", String(one[1]), ref, write]]);
  }
  return result;
}) as typeof redis.pipeline;

const person = (id: string, email: string, code: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 300 * DAY) * 1000, decidedAt: (NOW - 300 * DAY) * 1000, note: "", ...over });

const order = (id: string, email: string | null, via = BEA) => ({
  id, mode: "payment", status: "complete", payment_status: "paid", created: NOW - 600, amount_total: 5_000, amount_subtotal: 5_000,
  currency: "usd", total_details: { amount_tax: 0 }, payment_intent: `pi_${id}`,
  metadata: { store: "harbor", product: "prod01", title: "Bread course", via, via_rate: "30" },
  customer_details: { email },
});

const invoice = (id: string, email: string | null) => ({
  id, status: "paid", billing_reason: "subscription_cycle", amount_paid: 5_000, currency: "usd", ...(email ? { customer_email: email } : {}),
  created: NOW - 900, status_transitions: { paid_at: NOW - 900 }, total_taxes: [],
  parent: { subscription_details: { metadata: { store: "harbor", product: "prod01", via: BEA, via_rate: "30", kind: "plan" } } },
  payments: { data: [{ payment: { type: "payment_intent", payment_intent: `pi_${id}` } }] },
});

async function setup() {
  redis.clear();
  refunds = [];
  invoices = [];
  sessions = {};
  down = false;
  asked = 0;
  offShape = null;
  slipIn = null;
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TierRev01", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, secondTier: 10 }));
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana")],
    ["HSET", `nl:aff:${statsId}:people`, BEA, person(BEA, "bea@example.com", "bea", { by: { id: ANA, percent: 10 } })],
  ]);
  return { store, statsId };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const flagged = (l: unknown) => (l as { unconfirmed?: number } | undefined)?.unconfirmed === 1;
const tier = async (store: Setup["store"], ref: string) => (await readBook(store)).lines.find((l) => l.ref === `tier2:${ref}`);
const payable = async (store: Setup["store"], id: string) => (await readBook(store)).rows.find((r) => r.affiliate.id === id)?.payable;
const kept = async (statsId: string, ref: string) => {
  const [raw] = (await redis.pipeline([["HGET", `nl:aff:${statsId}:sales`, ref]])) as [string | null];
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
};

async function main(): Promise<void> {
  part("M1: a sale whose buyer is not confirmed waits whatever happened to it: partly refunded too");
  {
    const { store } = await setup();
    await noteSession(store, order("cs_part", null));
    refunds = [{ id: "re_1", status: "succeeded", payment_intent: "pi_cs_part", amount: 1_000 }];
    const book = await readBook(store);
    const line = book.lines.find((l) => l.ref === "tier2:cs_part");
    is("the tier is still marked waiting", flagged(line), true);
    is("the inviter is paid nothing automatically", await payable(store, ANA), 0);
    is("the book counts the sale once, and the panel can list it", [book.unconfirmed, (line?.commission ?? 0) > 0], [1, true]);
  }

  part("M2: a record that does not read is unknown, never \"no such affiliate\"");
  {
    const { store, statsId } = await setup();
    offShape = ANA;
    await noteSession(store, order("cs_shape", "ana@example.com"));
    const sale = await kept(statsId, "cs_shape");
    is("the inviter's own purchase is written waiting (or off), never as earning", sale?.buyerUnknown === 1 || sale?.tierOff === 1, true);
    is("the inviter is paid nothing on it", await payable(store, ANA), 0);
  }
  {
    const { store, statsId } = await setup();
    offShape = BEA;
    keepOff = true;
    await noteSession(store, order("cs_shape2", "kai@example.com"));
    keepOff = false;
    offShape = null;
    is("the recruit's own record off-shape: both tiers wait", [(await kept(statsId, "cs_shape2"))?.buyerUnknown, (await kept(statsId, "cs_shape2"))?.selfUnknown], [1, 1]);
  }

  part("M3: a waiting renewal can be approved, once");
  {
    const { store } = await setup();
    is("(fixture: invoices count from TIER_BUYER_FROM)", NOW - 900 >= TIER_BUYER_FROM, true);
    invoices = [invoice("in_Renew00001", null)];
    is("the renewal's tier waits", flagged(await tier(store, "in_Renew00001")), true);
    is("and is not payable", await payable(store, ANA), 0);
    is("the creator approves it", await approveUnconfirmed(store, "tier2:in_Renew00001"), "approved");
    const line = await tier(store, "in_Renew00001");
    is("now it is earned and payable", [flagged(line), line?.status, await payable(store, ANA)], [false, "earned", 500]);
    is("pressing again changes nothing", await approveUnconfirmed(store, "tier2:in_Renew00001"), "not-waiting");
  }

  part("L1: a sale Stripe keeps failing for is read a bounded number of times");
  {
    const { store } = await setup();
    await noteSession(store, order("cs_fail", null));
    down = true;
    for (let hour = 1; hour <= 14 * 24; hour += 1) await settleUnconfirmed(store, NOW + hour * 3_600);
    is("at most 40 reads in 14 days", asked <= 40, true);
    is("and at least one", asked >= 1, true);
  }

  part("L2: the job's rewrite and the creator's approval cannot undo each other");
  {
    const { store, statsId } = await setup();
    await noteSession(store, order("cs_cas", null));
    const waiting = (await kept(statsId, "cs_cas"))!;
    // After the approval reads the sale, the job decides it as the inviter's own purchase.
    slipIn = { ref: "cs_cas", write: JSON.stringify({ ...waiting, buyerUnknown: undefined, selfUnknown: undefined, tierOff: 1 }) };
    const answer = await approveUnconfirmed(store, "tier2:cs_cas");
    is("the approval does not overwrite it", answer, "not-waiting");
    is("tierOff stands, and nothing is paid on it", [(await kept(statsId, "cs_cas"))?.tierOff, await payable(store, ANA)], [1, 0]);
  }

  part("Rule 30: the first tier is held on an unknown buyer, as the second is");
  {
    const { store, statsId } = await setup();
    await noteSession(store, order("cs_first", null));
    const line = (await readBook(store)).lines.find((l) => l.ref === "cs_first");
    is("Bea's own commission waits", [flagged(line), await payable(store, BEA)], [true, 0]);
    sessions.cs_first = { id: "cs_first", customer_details: { email: "kai@example.com" } };
    is("the job decides it", (await settleUnconfirmed(store, NOW + 60)).decided, 1);
    is("Bea is paid, and so is the tier", [await payable(store, BEA), await payable(store, ANA)], [1_500, 500]);
    await noteSession(store, order("cs_first2", null));
    sessions.cs_first2 = { id: "cs_first2", customer_details: { email: "BEA@example.com" } };
    await settleUnconfirmed(store, NOW + 60);
    const own = (await readBook(store)).lines.find((l) => l.ref === "cs_first2");
    is("Bea's own purchase, found later: it is an own purchase and earns nothing", [(await kept(statsId, "cs_first2"))?.self, own?.status, own?.commission], [true, "own purchase", 0]);
  }
  done();
}

void main();
