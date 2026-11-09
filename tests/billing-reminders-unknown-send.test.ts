/**
 * Rule 24 for the send itself in lib/billing-reminders.ts: a trial or yearly renewal notice (sendReminders) and a
 * failed plan payment notice (sendFailedPlanNotices) are each sent once per charge, under a mark taken before the send
 * (lib/claim-mark.ts). What the send answered decides what becomes of the mark (lib/email.ts sendEmailOutcome):
 *
 *   sent       the mark stays, nothing goes again;
 *   refused    known not taken (a 4xx from Resend, a refusal Amazon said, no sender): this run's own mark is let go,
 *              so the next run sends the notice, once;
 *   uncertain  it may have gone (Resend answered 5xx or the request threw after it may have reached Resend; Amazon
 *              answered 5xx or did not answer after it may have taken it): the mark stays, the notice is counted as
 *              uncertain (not as failed, never as sent) and logged, and no later run sends it a second time.
 *
 * Before this, sendEmail answered false in all three of the last cases alike and the mark was let go: the next day's
 * run sent the same notice again. The other side is said here too: an uncertain notice is not sent again by email.
 *
 * Synthetic subscriptions, Stripe, Resend, STS and SES answers; no email leaves this machine.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sendFailedPlanNotices, sendReminders } from "@/lib/billing-reminders";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_billing_unknown_send_only";
// A synthetic key the Resend fixture knows (tests/resend-fixture-credentials.ts), shared with tests/plan-payment-failed.test.ts.
process.env.RESEND_API_KEY = "re_test_failed_plan_only";

const NOW = 1_791_700_000;
const DAY = 86_400;
const REGION = "us-east-1";
const PRICE = { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } };

/** Addresses Resend took (a 200). */
const emails: string[] = [];
/** Addresses Amazon took (a 200). */
const amazon: string[] = [];
/** What Resend does with the next email: take it, refuse it (422), fail after it may have taken it (500), or throw. */
let resendDoes: "take" | "refuse" | "error" | "throw" = "take";
/** What Amazon does with the next email: take it, refuse it (400 MessageRejected), or fail after it may have taken it (500). */
let amazonDoes: "take" | "refuse" | "error" = "take";
let lists: Record<string, Record<string, unknown>[]> = {};

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com") {
    if (method === "GET" && url.pathname === "/v1/subscriptions") {
      return json({ data: lists[url.searchParams.get("status") ?? ""] ?? [], has_more: false });
    }
    if (method === "POST" && url.pathname.startsWith("/v1/subscriptions/")) return json({ id: url.pathname.split("/").pop() });
  }
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const to = Array.isArray(body.to) ? body.to[0] : body.to;
    const does = resendDoes;
    resendDoes = "take";
    if (does === "refuse") return json({ message: "synthetic known refusal" }, 422);
    if (does === "error") return json({ message: "synthetic server error after the post" }, 500);
    if (does === "throw") throw new TypeError("synthetic connection reset after the post");
    emails.push(to);
    return json({ id: "re_1" });
  }
  if (url.hostname === `sts.${REGION}.amazonaws.com`) {
    const credentials = { AccessKeyId: "ASIAEXAMPLEUNKNOWN01", SecretAccessKey: "lent-for-an-hour-and-never-stored-0000000", SessionToken: "session-token-1", Expiration: Math.floor(Date.now() / 1000) + 3_600 };
    return json({ AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: credentials } } });
  }
  if (url.hostname === `email.${REGION}.amazonaws.com`) {
    if (url.pathname === "/v2/email/account") {
      return json({ ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "HEALTHY", SendQuota: { Max24HourSend: 50_000, MaxSendRate: 100, SentLast24Hours: 0 } });
    }
    if (url.pathname === "/v2/email/outbound-emails") {
      const body = JSON.parse(String(init?.body)) as { Destination: { ToAddresses: string[] } };
      const does = amazonDoes;
      amazonDoes = "take";
      // The email's own fault, not the account's (lib/ses.ts sesSend "refused"): nothing else is told, Resend is tried.
      if (does === "refuse") return json({ message: "Illegal address" }, 400, { "x-amzn-errortype": "MessageRejected" });
      if (does === "error") return json({ message: "synthetic server error after acceptance" }, 500);
      amazon.push(body.Destination.ToAddresses[0]);
      return json({ MessageId: `m-${amazon.length}` });
    }
  }
  return json({}, 404);
}) as typeof fetch;

const SES_ENV: Record<string, string> = {
  AWS_SES_ROLE_ARN: "arn:aws:iam::123456789012:role/synthetic-unknown-send",
  AWS_SES_REGION: REGION,
  AWS_SES_CONFIGURATION_SET: "marktmorgen",
  AWS_SES_TOPIC_ARN: `arn:aws:sns:${REGION}:123456789012:marktmorgen-email`,
  VERCEL_OIDC_TOKEN: "aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl",
};
/** Amazon is configured (and asked afresh about the account) only while `work` runs. */
async function withAmazon<T>(work: () => Promise<T>): Promise<T> {
  Object.assign(process.env, SES_ENV);
  await redis.run(["DEL", "nl:ses:state"]);
  try {
    return await work();
  } finally {
    for (const name of Object.keys(SES_ENV)) delete process.env[name];
    await redis.run(["DEL", "nl:ses:state"]);
  }
}

const trial = (id: string) => ({
  id,
  status: "trialing",
  created: NOW - 7 * DAY,
  trial_end: NOW + 7 * DAY,
  cancel_at_period_end: false,
  customer: { email: `${id}@example.com` },
  items: { data: [{ current_period_start: NOW - 7 * DAY, current_period_end: NOW + 7 * DAY, price: PRICE }] },
});
const pastDue = (id: string) => ({
  id,
  status: "past_due",
  created: NOW - 90 * DAY,
  trial_end: NOW - 76 * DAY,
  customer: { email: `${id}@example.com` },
  items: { data: [{ current_period_start: NOW - 2 * DAY, current_period_end: NOW + 28 * DAY, price: PRICE }] },
  latest_invoice: {
    id: `in_${id.slice(4)}inv`,
    status: "open",
    amount_due: 2900,
    hosted_invoice_url: `https://invoice.stripe.com/i/${id}`,
    next_payment_attempt: NOW + 3 * DAY,
  },
});

const markOf = async (key: string) => (await redis.pipeline([["GET", key]]))[0];
/** A value lib/claim-mark.ts claimValue writes: the time in milliseconds, a point, nine random digits. */
const OWN_VALUE = /^\d{13}\.\d{9}$/;
const trialKey = (id: string) => `nl:remind:trial:${id}:${NOW + 7 * DAY}`;
const failedKey = (id: string) => `nl:remind:failed:in_${id.slice(4)}inv`;
const sentTo = (id: string) => [...emails, ...amazon].filter((to) => to === `${id}@example.com`).length;

let n = 0;
const nextId = (kind: string) => `sub_${kind}${String(++n).padStart(8, "0")}`;

/** Runs `work` and keeps what it logged as an error. */
async function logged<T>(work: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const before = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { result: await work(), lines };
  } finally {
    console.error = before;
  }
}

const UNCERTAIN_RESEND: ["error" | "throw", string][] = [
  ["error", "Resend answered 500 after the post"],
  ["throw", "the request to Resend threw after the post"],
];

for (const [does, how] of UNCERTAIN_RESEND) {
  test(`a trial notice whose send is not known (${how}) keeps its mark, is counted uncertain, and is never sent again`, async () => {
    const id = nextId("Trial");
    lists = { trialing: [trial(id)] };
    resendDoes = does;
    const { result, lines } = await logged(() => sendReminders(NOW));
    assert.deepEqual([result.sent, result.failed, result.uncertain], [0, 0, 1], "neither sent nor failed: uncertain");
    assert.match(String(await markOf(trialKey(id))), OWN_VALUE, "the mark stays as this run wrote it");
    assert.ok(lines.some((line) => line.includes("may have gone") && line.includes(id)), "and it is logged, with the subscription");
    const later = await sendReminders(NOW);
    await sendReminders(NOW);
    assert.deepEqual([later.sent, later.failed, sentTo(id)], [0, 0, 0], "no later run sends it a second time");
  });

  test(`a failed payment notice whose send is not known (${how}) keeps its mark, is counted uncertain, and is never sent again`, async () => {
    const id = nextId("Fail");
    lists = { past_due: [pastDue(id)] };
    resendDoes = does;
    const { result, lines } = await logged(() => sendFailedPlanNotices());
    assert.deepEqual([result.sent, result.failed, result.uncertain], [0, 0, 1], "neither sent nor failed: uncertain");
    assert.match(String(await markOf(failedKey(id))), OWN_VALUE, "the mark stays as this run wrote it");
    assert.ok(lines.some((line) => line.includes("may have gone") && line.includes(`in_${id.slice(4)}inv`)), "and it is logged, with the invoice");
    const later = await sendFailedPlanNotices();
    await sendFailedPlanNotices();
    assert.deepEqual([later.sent, later.failed, sentTo(id)], [0, 0, 0], "no later run sends it a second time");
  });
}

test("a trial notice Resend refused (422) lets its own mark go, so the next run sends it, once (control)", async () => {
  const id = nextId("Trial");
  lists = { trialing: [trial(id)] };
  resendDoes = "refuse";
  const first = await logged(() => sendReminders(NOW));
  assert.deepEqual([first.result.sent, first.result.failed, first.result.uncertain ?? 0], [0, 1, 0]);
  assert.equal(await markOf(trialKey(id)), null, "its own mark is let go");
  await sendReminders(NOW);
  await sendReminders(NOW);
  assert.equal(sentTo(id), 1, "sent by the next run, exactly once");
});

test("a failed payment notice Resend refused (422) lets its own mark go, so the next run sends it, once (control)", async () => {
  const id = nextId("Fail");
  lists = { past_due: [pastDue(id)] };
  resendDoes = "refuse";
  const first = await logged(() => sendFailedPlanNotices());
  assert.deepEqual([first.result.sent, first.result.failed, first.result.uncertain ?? 0], [0, 1, 0]);
  assert.equal(await markOf(failedKey(id)), null, "its own mark is let go");
  await sendFailedPlanNotices();
  await sendFailedPlanNotices();
  assert.equal(sentTo(id), 1, "sent by the next run, exactly once");
});

test("through Amazon: a trial notice Amazon may have taken (500) keeps its mark, goes to no other sender, and is never sent again", async () => {
  const id = nextId("Trial");
  lists = { trialing: [trial(id)] };
  await withAmazon(async () => {
    amazonDoes = "error";
    const { result } = await logged(() => sendReminders(NOW));
    assert.deepEqual([result.sent, result.failed, result.uncertain], [0, 0, 1]);
    assert.match(String(await markOf(trialKey(id))), OWN_VALUE, "the mark stays as this run wrote it");
    await sendReminders(NOW);
    await sendReminders(NOW);
  });
  assert.equal(sentTo(id), 0, "not sent again by Amazon, nor by Resend");
});

test("through Amazon: a failed payment notice Amazon may have taken (500) keeps its mark and is never sent again", async () => {
  const id = nextId("Fail");
  lists = { past_due: [pastDue(id)] };
  await withAmazon(async () => {
    amazonDoes = "error";
    const { result } = await logged(() => sendFailedPlanNotices());
    assert.deepEqual([result.sent, result.failed, result.uncertain], [0, 0, 1]);
    assert.match(String(await markOf(failedKey(id))), OWN_VALUE);
    await sendFailedPlanNotices();
    await sendFailedPlanNotices();
  });
  assert.equal(sentTo(id), 0);
});

test("through Amazon: refused by Amazon and then by Resend, the notice lets its own mark go and the next run sends it, once (control)", async () => {
  const id = nextId("Trial");
  lists = { trialing: [trial(id)] };
  await withAmazon(async () => {
    amazonDoes = "refuse";
    resendDoes = "refuse";
    const { result } = await logged(() => sendReminders(NOW));
    assert.deepEqual([result.sent, result.failed, result.uncertain ?? 0], [0, 1, 0]);
    assert.equal(await markOf(trialKey(id)), null, "its own mark is let go");
    await sendReminders(NOW);
    await sendReminders(NOW);
  });
  assert.equal(sentTo(id), 1, "sent by the next run, exactly once");
});

test("through Amazon: a notice Amazon took goes once and is not sent again (healthy control)", async () => {
  const id = nextId("Fail");
  lists = { past_due: [pastDue(id)] };
  await withAmazon(async () => {
    const first = await sendFailedPlanNotices();
    assert.deepEqual([first.sent, first.failed, first.uncertain ?? 0], [1, 0, 0]);
    await sendFailedPlanNotices();
  });
  assert.deepEqual([amazon.filter((to) => to === `${id}@example.com`).length, sentTo(id)], [1, 1]);
});
