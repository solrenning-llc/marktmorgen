/**
 * CX-123 rule 24, lot L6 (C4-20261105-1945-C2-2 (5)): the failed-payment
 * emails (lib/payment-recovery.ts) decide from Redis marks which email is due
 * and whether it is ours to send. A mark answered in an unknown shape (a
 * missing reply, a count as text, an extra reply, a claim answered with
 * anything but OK) never sends an email on a guess: nothing goes this run,
 * and the email that is due goes once on a whole reading. Replies the
 * stand-in never gives by itself are injected for one pipeline only, after it
 * ran, as Upstash could answer a command it applied.
 */
import { recoverFailedPayments } from "@/lib/payment-recovery";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setDunning, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400_000;
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;

const mails: { to: string[] | string; subject: string }[] = [];
let pastDue: Record<string, unknown>[] = [];
/** Memberships told to keep the card that pays (the POST before the first email). */
const saved: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    mails.push(JSON.parse(String(init?.body)));
    return answer({ id: `email_${mails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/subscriptions" && method === "GET") {
    const all = url.searchParams.get("status") === "past_due" ? pastDue : [];
    const after = url.searchParams.get("starting_after");
    const from = after ? all.findIndex((s) => s.id === after) + 1 : 0;
    const limit = Number(url.searchParams.get("limit")) || 10;
    return answer({ object: "list", data: all.slice(from, from + limit), has_more: from + limit < all.length });
  }
  if (/^\/subscriptions\/sub_\w+$/.test(path) && method === "POST") {
    saved.push(path.split("/").pop() as string);
    return answer({ id: path.split("/").pop() });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** Runs `run` with the reply to the first pipeline whose first command is `name` on a key starting `prefix` replaced, after it ran. */
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
  try {
    await run();
  } finally {
    redis.pipeline = real;
  }
}

/** Like withReply, but the command never reaches Redis: the reply is all there is (a write that did not land). */
async function withReplyOnly(name: string, prefix: string, reply: unknown, run: () => Promise<unknown>): Promise<void> {
  const real = redis.pipeline.bind(redis);
  let used = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!used && commands[0]?.[0] === name && String(commands[0]?.[1] ?? "").startsWith(prefix)) {
      used = true;
      return reply;
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    await run();
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_recovery_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";
  redis.clear();
  const OWNER = "l6-recovery@example.com";
  await claimHandle(OWNER, "lsixrec", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLsixRec01", true);
  await setSubscription(OWNER, { customerId: "cus_LsixRec0001", subscriptionId: "sub_LsixRec0001", active: true, tier: "pro", period: paidPeriod(Date.now(), { behind: 1, ahead: 30 }) });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  await setDunning(OWNER, { reminders: 3, cardNotice: false });
  await storeForEmail(OWNER);
  const run = () => recoverFailedPayments(Date.now() + 20_000);
  const mark = "nl:dun:acct_1TestLsixRec01:";
  const sentTo = (to: string) => mails.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(to)).length;

  part("The first email: only an exact reading or claim sends it");
  pastDue = [{
    id: "sub_LsixFailing01", status: "past_due", metadata: { store: "lsixrec", product: club.product.id },
    customer: { id: "cus_LsixFailing1", email: "ana@example.com" },
    latest_invoice: { id: "in_LsixFailing01", status: "open", amount_due: 2900, currency: "usd", hosted_invoice_url: "https://invoice.stripe.com/i/failing", next_payment_attempt: 0 },
  }];
  await withReply("GET", mark, (real) => [...(real as unknown[]), "extra"], run);
  is("marks answered with an extra reply: nothing sent", sentTo("ana@example.com"), 0);
  await withReply("GET", mark, () => [undefined, 0, 0], run);
  is("a first mark with no answer: nothing sent", sentTo("ana@example.com"), 0);
  // Changed assertion (rule 23, Claude 4 on #2714): a claim answered oddly used to be kept and skipped, which left the
  // first email unsent and made later runs read it as sent. Now the claim holds a value of its own, read back.
  await withReplyOnly("SET", mark, ["QUEUED"], run);
  is("a claim answered oddly that did not land: nothing sent this run", [sentTo("ana@example.com"), saved.length], [0, 0]);
  await withReply("SET", mark, () => ["QUEUED"], run);
  is("a claim answered oddly that did land with our own value: read back, and the first email goes with the card kept", [sentTo("ana@example.com"), saved], [1, ["sub_LsixFailing01"]]);
  await run();
  is("and not twice", sentTo("ana@example.com"), 1);

  part("A reminder: a count read as text or missing never picks the email");
  shift += 3 * DAY;
  await withReply("GET", mark, (real) => [(real as unknown[])[0], "1", 0], run);
  is("a reminder count answered as text: nothing sent", sentTo("ana@example.com"), 1);
  await withReply("GET", mark, (real) => [(real as unknown[])[0], 0], run);
  is("a reply missing: nothing sent", sentTo("ana@example.com"), 1);
  await run();
  is("on a whole reading, the reminder due goes once", sentTo("ana@example.com"), 2);

  part("No more than a hundred written about per store per run, however many are behind (Claude 3 on #2714)");
  const many = (n: number) => Array.from({ length: n }, (_, i) => {
    const id = String(i).padStart(4, "0");
    return {
      id: `sub_LsixMany${id}`, status: "past_due", metadata: { store: "lsixrec", product: club.product.id },
      customer: { id: `cus_LsixMany${id}`, email: `m${id}@example.com` },
      latest_invoice: { id: `in_LsixMany${id}`, status: "open", amount_due: 2900, currency: "usd", hosted_invoice_url: `https://invoice.stripe.com/i/m${id}`, next_payment_attempt: 0 },
    };
  });
  pastDue = many(150);
  // Counted by the work done for each (the card kept before a first email), not by emails, which the store's own
  // monthly email figure also holds back.
  const before = saved.length;
  await run();
  is("150 behind: a hundred looked after this run", saved.length - before, 100);
  await run();
  is("the other fifty on the next", saved.length - before, 150);
  done();
}

void main();
