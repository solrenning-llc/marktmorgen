/**
 * Proof (review of PR #2714): a first-email claim answered in an unknown shape is kept
 * (it "may be ours"). The next runs read it as "the first email went at that time":
 * the member's first email about the failed payment is a REMINDER ("says so, first"),
 * the step-1 save_default_payment_method POST is never made, and with reminders: 0
 * no email at all ever goes for that invoice.
 */
import { failedPaymentEmail, recoverFailedPayments } from "@/lib/payment-recovery";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setDunning, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400_000;
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;

const mails: { to: string[] | string; subject: string }[] = [];
const posts: string[] = [];
let pastDue: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    mails.push(JSON.parse(String(init?.body)));
    return answer({ id: `email_${mails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/subscriptions" && method === "GET") return answer({ object: "list", data: url.searchParams.get("status") === "past_due" ? pastDue : [], has_more: false });
  if (/^\/subscriptions\/sub_\w+$/.test(path) && method === "POST") { posts.push(path); return answer({ id: path.split("/").pop() }); }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function withReply(name: string, prefix: string, reply: (real: unknown) => unknown, run: () => Promise<unknown>): Promise<void> {
  const real = redis.pipeline.bind(redis);
  let used = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const answer = await real(commands);
    if (!used && commands[0]?.[0] === name && String(commands[0]?.[1] ?? "").startsWith(prefix)) {
      used = true;
      return reply(answer);
    }
    return answer;
  }) as typeof redis.pipeline;
  try { await run(); } finally { redis.pipeline = real; }
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_recovery_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";
  redis.clear();
  const OWNER = "r2714-proof@example.com";
  await claimHandle(OWNER, "rproof", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRproof001", true);
  await setSubscription(OWNER, { customerId: "cus_Rproof00001", subscriptionId: "sub_Rproof00001", active: true, period: paidPeriod(Date.now(), { behind: 1, ahead: 30 }) });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  await setDunning(OWNER, { reminders: 3, cardNotice: false });
  await storeForEmail(OWNER);
  const run = () => recoverFailedPayments(Date.now() + 20_000);
  const mark = "nl:dun:acct_1TestRproof001:";
  pastDue = [{
    id: "sub_RproofFail01", status: "past_due", metadata: { store: "rproof", product: club.product.id },
    customer: { id: "cus_RproofFail1", email: "ana@example.com" },
    latest_invoice: { id: "in_RproofFail01", status: "open", amount_due: 2900, currency: "usd", hosted_invoice_url: "https://invoice.stripe.com/i/failing", next_payment_attempt: 0 },
  }];

  part("A first-email claim that landed but was answered in an unknown shape");
  {
    const real = redis.pipeline.bind(redis);
    let setUsed = false, getUsed = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const answer = await real(commands);
      const k = String(commands[0]?.[1] ?? "");
      if (!setUsed && commands[0]?.[0] === "SET" && k.startsWith(mark)) { setUsed = true; return ["QUEUED"]; }
      if (setUsed && !getUsed && commands.length === 1 && commands[0]?.[0] === "GET" && k.startsWith(mark)) { getUsed = true; throw new Error("read back lost"); }
      return answer;
    }) as typeof redis.pipeline;
    try { await run(); } finally { redis.pipeline = real; }
  }
  is("nothing sent on the unknown claim (as designed)", mails.length, 0);
  await run();
  is("same day, next run: still nothing (the kept claim reads as 'first email went')", mails.length, 0);
  shift += 3 * DAY;
  await run();
  const reminder = failedPaymentEmail({ storeName: "Harbor Kitchen", title: "The Inner Circle", amount: "$29.00", payUrl: "x", manageUrl: "y", isPlan: false, nextTry: null, reminder: true }).subject;
  is("three days later the member gets ONE email...", mails.length, 1);
  is("...and it is the REMINDER, though no first email ever went", mails[0]?.subject, reminder);
  is("the step-1 save_default_payment_method POST was never made", posts.length, 0);
  done();
}

void main();
