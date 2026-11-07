/**
 * Independent second review of #2887 (CX-116), synthetic only (Redis stub, mocked Resend).
 *
 *   A. Store side of Claude 5's MEDIUM: the store-id GET answered in an unknown shape ([] or [42])
 *      still drops the reminder for good on this head (left to #2878).
 *   B. Control (passes): after the reminder email went, changeRequest's re-read answers in an unknown
 *      shape, so "sent" is not written and the next round re-reads the entry; on the Resend path the
 *      transport's 35-day accepted receipt keeps it to one post and one allowance unit.
 *   C. A store read that throws every time keeps the reminder forever, even after the request's own
 *      record is confirmed gone (KEEP_DAYS does not bound the store side).
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { KEEP_DAYS, readDraft, REMIND_EVERY_DAYS } from "@/lib/payment-request-rules";
import { createRequest, readRequest } from "@/lib/payment-request-store";
import { sendDueReminders, sendRequestEmail } from "@/lib/payment-requests";
import { allowanceUsed } from "@/lib/store-allowance";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis);
const DUE = "nl:payreq:due";
const DAY = 86_400_000;
const posts: { to: string; key: string | null }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string[] };
    posts.push({ to: body.to[0], key: new Headers(init?.headers).get("Idempotency-Key") });
    return answer({ id: `email_${posts.length}` });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function paidStore(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, "Proof Studio", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1Req${handle.slice(0, 8).padEnd(8, "x")}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "pro", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_payment_requests_only_a_stand_in";
  // The fixture key the Resend credential binding accepts in tests (same as tests/payment-requests.test.ts).
  process.env.RESEND_API_KEY = "re_test_payment_requests_only_a_stand_in";
  const now = Date.now();

  part("A. The store-id GET answered in an unknown shape");
  const s = await paidStore("rv2887-a@example.com", "rvstorea");
  const ID = "fedcba9876543210fedcba9876543210";
  const entry = `${s.sid}|${ID}`;
  for (const [what, reply] of [["no reply ([])", [] as unknown[]], ["a number ([42])", [42]]] as const) {
    await real([["ZADD", DUE, String(now - 1000), entry]]);
    redis.pipeline = (async (c: Commands) => {
      if (c.length === 1 && c[0][0] === "GET" && c[0][1] === `nl:store:id:${s.sid}`) return reply;
      return real(c);
    }) as typeof redis.pipeline;
    try {
      await sendDueReminders(Date.now() + 10_000, now);
    } finally {
      redis.pipeline = real;
    }
    const [at] = await real([["ZSCORE", DUE, entry]]);
    is(`${what}: the reminder is not dropped`, at !== null, true);
  }
  await real([["ZREM", DUE, entry]]);

  part("B. Control: the record re-read after the email went answers in an unknown shape");
  const b = await paidStore("rv2887-b@example.com", "rvstoreb");
  const draft = readDraft({ email: "owes@example.com", name: "Dana", lines: [{ text: "Coaching", quantity: 1, amount: "120" }], note: "", dueDate: "", autoReminders: 2, consent: true }, "usd", now);
  const made = await createRequest(b, (draft as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft, now);
  if (!made.ok) throw new Error("synthetic request not made");
  await sendRequestEmail(b, made.request, now);
  is("the first email went and is written down", [posts.length, (await readRequest(made.request.id))?.sent.length], [1, 1]);
  const at = now + REMIND_EVERY_DAYS * DAY + 1;
  const usedBefore = await allowanceUsed(b, "email", at);
  let gets = 0;
  redis.pipeline = (async (c: Commands) => {
    // GET #1 of the record is the reminder's own exact read; GET #2 is changeRequest's re-read after sending.
    if (c.length === 1 && c[0][0] === "GET" && c[0][1] === `nl:payreq:r:${made.request.id}`) {
      gets += 1;
      if (gets === 2) return [42];
    }
    return real(c);
  }) as typeof redis.pipeline;
  try {
    await sendDueReminders(Date.now() + 10_000, at);
  } finally {
    redis.pipeline = real;
  }
  is("the record was read four times (two rounds)", gets, 4);
  is("the due reminder is posted once", posts.slice(1).filter((p) => p.to === "owes@example.com").length, 1);
  is("and takes one of the store's emails", (await allowanceUsed(b, "email", at)) - usedBefore, 1);

  part("C. A store read that always throws, with the request's record long gone");
  const c = await paidStore("rv2887-c@example.com", "rvstorec");
  const GONE = "0123456789abcdef0123456789abcdef";
  const centry = `${c.sid}|${GONE}`;
  await real([["ZADD", DUE, String(now - 1000), centry]]);
  redis.pipeline = (async (cmds: Commands) => {
    if (cmds.length === 1 && cmds[0][0] === "GET" && cmds[0][1] === `nl:store:id:${c.sid}`) throw new Error("Synthetic: store read fails");
    return real(cmds);
  }) as typeof redis.pipeline;
  try {
    // Daily runs from day 0 to KEEP_DAYS + 2: the request record (nl:payreq:r:GONE) never existed, so it is nil throughout.
    for (let day = 0; day <= KEEP_DAYS + 2; day += 1) await sendDueReminders(Date.now() + 10_000, now + day * DAY);
  } finally {
    redis.pipeline = real;
  }
  const [still] = await real([["ZSCORE", DUE, centry]]);
  is("a reminder whose request record is confirmed absent is gone after KEEP_DAYS", still, null);
  done();
}

void main();
