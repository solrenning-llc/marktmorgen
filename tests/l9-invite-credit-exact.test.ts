/**
 * CX-123 rule 24, lot L9 (proposed to Claude 4): an invited creator's payment earns the inviter a credit
 * (lib/creator-invite-credit.ts). The credit's record is written first, then the owed list it is paid from. When that
 * second write fails, the credit must still reach Stripe on a later run: a credit written but never listed as owed is
 * money the inviter never gets. Stripe is a stand-in; nothing real is charged.
 */
import { claimHandle, setSubscription } from "@/lib/store";
import { inviteCode, recordInvite, creditKey, OWED_KEY } from "@/lib/creator-invites";
import { settleInvites } from "@/lib/creator-invite-credit";
import { INVITE_HOLD_DAYS } from "@/lib/creator-invite-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;
const NOW = Date.UTC(2026, 9, 16, 12);
const nowS = Math.floor(NOW / 1000);
const PAST = INVITE_HOLD_DAYS + 4;
const INVITED = PAST + 20;
const balance = new Map<string, { amount: number }[]>();
const invoices = new Map<string, Record<string, unknown>[]>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (method === "GET" && path === "/invoices") return answer({ object: "list", data: invoices.get(url.searchParams.get("customer") ?? "") ?? [], has_more: false });
  if (method === "GET" && path === "/refunds") return answer({ object: "list", data: [], has_more: false });
  const txns = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)\/balance_transactions$/);
  if (txns && method === "GET") return answer({ object: "list", data: [], has_more: false });
  if (txns && method === "POST") {
    const form = new URLSearchParams(String(init?.body ?? ""));
    const row = { id: `cbtxn_${Math.random().toString(36).slice(2, 10)}`, amount: Number(form.get("amount")) };
    balance.set(txns[1], [...(balance.get(txns[1]) ?? []), row]);
    return answer(row);
  }
  const customer = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)$/);
  if (customer && method === "GET") return answer({ id: customer[1], object: "customer", balance: 0, currency: "usd" });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_invites_only_a_stand_in";
  redis.clear();
  const made = async (email: string, handle: string) => {
    const r = await claimHandle(email, handle, handle, "");
    if (!r.ok) throw new Error(`no store for ${handle}`);
    return r.store;
  };
  const ana = await made("ana@example.com", "ana");
  const bea = await made("bea@example.com", "bea");
  const code = await inviteCode(ana.sid);
  if (!code || (await recordInvite(bea, code, NOW - INVITED * DAY * 1000)) !== "recorded") throw new Error("no invite");
  await setSubscription("ana@example.com", { customerId: "cus_Ana0001", subscriptionId: "sub_Ana0001", active: true, period: paidPeriod() });
  await setSubscription("bea@example.com", { customerId: "cus_Bea0001", subscriptionId: "sub_Bea0001", active: true, period: paidPeriod() });
  invoices.set("cus_Bea0001", [{
    id: "in_BeaFirst01", object: "invoice", status: "paid", amount_paid: 2900, post_payment_credit_notes_amount: 0, currency: "usd",
    created: nowS - PAST * DAY, status_transitions: { paid_at: nowS - PAST * DAY },
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_x" } },
    payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: "pi_bea_first" } }], has_more: false },
  }]);

  part("The credit's record is written, then the write that lists it as owed fails once");
  const real = redis.pipeline.bind(redis);
  let failed = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!failed && commands.some((c) => c[0] === "SADD" && c[1] === OWED_KEY)) {
      failed = true;
      throw new Error("redis: connection reset");
    }
    return real(commands);
  }) as typeof redis.pipeline;
  const errors = console.error;
  console.error = () => {};
  try {
    await settleInvites(Date.now() + 60_000, NOW).catch(() => null);
  } finally {
    redis.pipeline = real;
    console.error = errors;
  }
  is("the write that lists it failed, after the record was kept", [failed, redis.run(["EXISTS", creditKey("in_BeaFirst01")])], [true, 1]);

  part("An unknown EXISTS result is never a complete successful settlement");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((command) => command[0] === "EXISTS" && command[1] === creditKey("in_BeaFirst01"))) return commands.map(() => "QUEUED");
    return real(commands);
  }) as typeof redis.pipeline;
  let unknownExists;
  try {
    unknownExists = await settleInvites(Date.now() + 60_000, NOW);
  } finally {
    redis.pipeline = real;
  }
  is("unknown existence is reported for retry and remains unpaid", [unknownExists.failed, unknownExists.complete, balance.get("cus_Ana0001") ?? []], [1, false, []]);

  part("An unreadable stored credit is unknown, never a complete successful settlement");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    return replies.map((reply, index) => commands[index]?.[0] === "GET" && commands[index]?.[1] === creditKey("in_BeaFirst01") ? "{broken" : reply);
  }) as typeof redis.pipeline;
  let unknown;
  try {
    unknown = await settleInvites(Date.now() + 60_000, NOW);
  } finally {
    redis.pipeline = real;
  }
  is("unknown credit is reported for retry and remains unpaid", [unknown.failed, unknown.complete, balance.get("cus_Ana0001") ?? []], [1, false, []]);

  part("A relisting write answered oddly, without landing, is unknown too (Codex N on #2722)");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // The relisting write, answered oddly without landing.
    if (commands[0]?.[0] === "ZADD" && commands.some((c) => c[0] === "SADD" && c[2] === "in_BeaFirst01")) return commands.map(() => "QUEUED");
    return real(commands);
  }) as typeof redis.pipeline;
  let oddWrite;
  try {
    oddWrite = await settleInvites(Date.now() + 60_000, NOW);
  } finally {
    redis.pipeline = real;
  }
  is("an odd relisting reply is reported for retry and pays nothing", [oddWrite.failed >= 1, oddWrite.complete, balance.get("cus_Ana0001") ?? []], [true, false, []]);

  part("Later runs still pay it, once");
  await settleInvites(Date.now() + 60_000, NOW);
  await settleInvites(Date.now() + 60_000, NOW);
  is("Ana's half of Bea's first payment reaches her plan, once", (balance.get("cus_Ana0001") ?? []).map((t) => t.amount), [-1450]);

  part("The credits already written are read back together, not one trip each (Claude 4 on #2722)");
  invoices.set("cus_Bea0001", [...(invoices.get("cus_Bea0001") ?? []), ...[2, 3, 4, 5].map((n) => ({
    ...(invoices.get("cus_Bea0001") ?? [])[0], id: `in_BeaMore0${n}`, created: nowS - PAST * DAY + n, status_transitions: { paid_at: nowS - PAST * DAY + n },
  }))]);
  await settleInvites(Date.now() + 60_000, NOW);
  const real2 = redis.pipeline.bind(redis);
  let reads = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "GET" && c[1] === creditKey(`bonus_${bea.sid}`))) reads += 1;
    return real2(commands);
  }) as typeof redis.pipeline;
  try {
    await settleInvites(Date.now() + 60_000, NOW);
  } finally {
    redis.pipeline = real2;
  }
  is("one read for the five credits written before and the bonus", reads, 1);
  done();
}

void main();
