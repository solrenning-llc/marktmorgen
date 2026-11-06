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
  const list = [];
  for (let k = 0; k < 24; k += 1) list.push({
    id: `in_BeaMonth${String(k).padStart(2, "0")}`, object: "invoice", status: "paid", amount_paid: 2900, post_payment_credit_notes_amount: 0, currency: "usd",
    created: nowS - Math.floor((PAST + k * 0.5) * DAY), status_transitions: { paid_at: nowS - Math.floor((PAST + k * 0.5) * DAY) },
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_x" } },
    payments: { data: [{ payment: { type: "payment_intent", payment_intent: `pi_bea_${k}` } }] },
  });
  invoices.set("cus_Bea0001", list);
  await settleInvites(Date.now() + 60_000, NOW);
  const real = redis.pipeline.bind(redis);
  let trips = 0; let cmds = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => { trips += 1; cmds += commands.length; return real(commands); }) as typeof redis.pipeline;
  await settleInvites(Date.now() + 60_000, NOW);
  redis.pipeline = real;
  console.log(`steady-state run, 24 invoices already credited: ${trips} Redis round trips, ${cmds} commands`);
  is("each credit reached Stripe once", (balance.get("cus_Ana0001") ?? []).length, 24);
  done();
}

void main();
