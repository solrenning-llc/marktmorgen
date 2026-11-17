/**
 * The invite-credit job's Redis commands are bounded in code and priced (Claude 7's MEDIUM 6892802547 and Claude 5's
 * MEDIUM 6909172063 on #4514; rule MR/FX275: an unknown cost is never zero).
 *
 * The defect this file was written around: `invite-credit-reads` (tests/plan-cost-registry.ts) priced only the job's
 * function memory. Its Redis commands had no line and no ceiling: the whole invited list (ZREVRANGE 0 -1) and the whole
 * owed set (SMEMBERS) were read every day, and then a GET, EXISTS, claim and write per store, invoice and credit,
 * however many there were. The registry prices commands one by one everywhere else (COMMAND).
 *
 * Checked, with Stripe as a stand-in and the memory Redis (nothing real is charged):
 *   - the job has a whole-run command ceiling, and its line prices it at the registry's COMMAND rate on every plan,
 *     above the memory alone;
 *   - a run over many invited stores and owed credits sends at most that many commands, and reads neither list whole;
 *   - the runs keep their place: run after run, every invited store is reached and every share written, so the ceiling
 *     never leaves a store behind for good.
 */
import { claimHandle, setSubscription } from "@/lib/store";
import { inviteCode, recordInvite, creditKey } from "@/lib/creator-invites";
import * as job from "@/lib/creator-invite-credit";
import { INVITE_HOLD_DAYS } from "@/lib/creator-invite-rules";
import { TIERS } from "@/lib/plan";
import { COMMAND, COST_LINES, INVITE_JOB_RUNS_PER_MONTH } from "./plan-cost-registry";
import { VERCEL_FUNCTION_GB, VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR } from "@/lib/spend-cost-table";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Command = (string | number)[];
const DAY = 86_400;
const NOW = Date.UTC(2026, 9, 16, 12);
const nowS = Math.floor(NOW / 1000);
const PAID = INVITE_HOLD_DAYS + 4;
const INVITED = PAID + 20;
const STORES = 120;

const invoiceOf = (n: number) => ({
  id: `in_Ceil${String(n).padStart(6, "0")}`, object: "invoice", status: "paid", amount_paid: 2900, post_payment_credit_notes_amount: 0, currency: "usd",
  created: nowS - PAID * DAY, status_transitions: { paid_at: nowS - PAID * DAY },
  parent: { type: "subscription_details", subscription_details: { subscription: `sub_Ceil${String(n).padStart(6, "0")}` } },
  payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: `pi_Ceil${String(n).padStart(6, "0")}` } }], has_more: false },
});
const byId = new Map<string, ReturnType<typeof invoiceOf>>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (method === "GET" && path === "/invoices") {
    const n = /^cus_Ceil(\d{6})$/.exec(url.searchParams.get("customer") ?? "");
    return answer({ object: "list", data: n ? [invoiceOf(Number(n[1]))] : [], has_more: false });
  }
  const one = path.match(/^\/invoices\/(in_[A-Za-z0-9]+)$/);
  if (method === "GET" && one) return byId.has(one[1]) ? answer(byId.get(one[1])) : answer({ error: { message: "no such invoice" } }, 404);
  if (method === "GET" && (path === "/refunds" || path === "/disputes")) return answer({ object: "list", data: [], has_more: false });
  const txns = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)\/balance_transactions$/);
  if (txns && method === "GET") return answer({ object: "list", data: [], has_more: false });
  if (txns && method === "POST") return answer({ id: `cbtxn_${Math.random().toString(36).slice(2, 10)}`, amount: Number(new URLSearchParams(String(init?.body ?? "")).get("amount")) });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const errors = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = errors;
  }
}

const real = redis.pipeline.bind(redis);
/** Every command one run sends, in order. */
async function counted<T>(run: () => Promise<T>): Promise<{ result: T; sent: Command[] }> {
  const sent: Command[] = [];
  redis.pipeline = (async (batch: Command[]) => {
    sent.push(...batch);
    return real(batch);
  }) as typeof redis.pipeline;
  try {
    return { result: await run(), sent };
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_invite_command_ceiling_only_a_stand_in";
  const ceiling = (job as Record<string, unknown>).INVITE_RUN_COMMANDS;

  part("The job has a whole-run command ceiling, and its line prices it");
  is("a whole number of commands a run", typeof ceiling === "number" && Number.isSafeInteger(ceiling) && ceiling > 0, true);
  const line = COST_LINES.find((l) => l.id === "invite-credit-reads");
  const memorySecond = ((VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR / 1e6) * VERCEL_FUNCTION_GB) / 3600;
  // Every second day since the owner's decision of 17 November 2026: INVITE_JOB_RUNS_PER_MONTH (16) runs.
  const memoryOnly = INVITE_JOB_RUNS_PER_MONTH * 60 * memorySecond;
  const commands = typeof ceiling === "number" ? INVITE_JOB_RUNS_PER_MONTH * ceiling * COMMAND : Number.POSITIVE_INFINITY;
  for (const tier of TIERS) {
    const usd = line ? line.monthlyUsd(tier) : 0;
    is(`${tier}: ${INVITE_JOB_RUNS_PER_MONTH} runs at the most commands each, at COMMAND, above the memory alone`, usd >= memoryOnly + commands && usd > memoryOnly, true);
  }
  is("the line names the ceiling", (line?.sources ?? []).some((s) => s.file === "lib/creator-invite-credit.ts" && s.names.includes("INVITE_RUN_COMMANDS")), true);

  part("A run over many invited stores sends at most the ceiling, and reads neither list whole");
  redis.clear();
  const made = async (email: string, handle: string) => {
    const r = await claimHandle(email, handle, handle, "");
    if (!r.ok) throw new Error(`no store for ${handle}`);
    return r.store;
  };
  const ana = await made("ana-ceiling@example.com", "anaceiling");
  await setSubscription("ana-ceiling@example.com", { customerId: "cus_AnaCeiling1", subscriptionId: "sub_AnaCeiling1", active: true, period: paidPeriod() });
  const code = await inviteCode(ana.sid);
  if (!code) throw new Error("no invite code");
  for (let n = 0; n < STORES; n += 1) {
    const email = `invited${n}@example.com`;
    const store = await made(email, `invitedceil${n}`);
    if ((await recordInvite(store, code, NOW - INVITED * DAY * 1000)) !== "recorded") throw new Error(`no invite ${n}`);
    await setSubscription(email, { customerId: `cus_Ceil${String(n).padStart(6, "0")}`, subscriptionId: `sub_Ceil${String(n).padStart(6, "0")}`, active: true, period: paidPeriod() });
    byId.set(invoiceOf(n).id, invoiceOf(n));
  }
  const first = await counted(() => quiet(() => job.settleInvites(Date.now() + 60_000, NOW)));
  is("the run's commands stay within the ceiling", typeof ceiling === "number" && first.sent.length <= ceiling, true);
  is("the invited list is never read whole", first.sent.some((c) => c[0] === "ZREVRANGE" && String(c[2]) === "0" && String(c[3]) === "-1"), false);
  is("nor the owed set", first.sent.some((c) => c[0] === "SMEMBERS"), false);

  part("Run after run, every invited store is reached: the ceiling never leaves one behind for good");
  let runs = 1;
  const written = () => [...byId.keys()].filter((id) => redis.run(["EXISTS", creditKey(id)]) === 1).length;
  while (written() < STORES && runs < 40) {
    const next = await counted(() => quiet(() => job.settleInvites(Date.now() + 60_000, NOW)));
    is(`run ${runs + 1}: within the ceiling`, typeof ceiling === "number" && next.sent.length <= ceiling, true);
    runs += 1;
  }
  is("every invited store's share is written", written(), STORES);
  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
