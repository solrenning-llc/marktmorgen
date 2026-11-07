/**
 * Rule 24 for the billing emails sent once per charge (lib/billing-reminders.ts):
 * a trial or yearly renewal notice (sendReminders) and a failed plan payment
 * notice (sendFailedPlanNotices) go only when the mark's SET NX answers exactly
 * "OK". nil is a mark already taken; any other answer ("QUEUED", undefined, an
 * empty or short pipeline, an object, a number) is unknown: nothing is sent, the
 * charge is counted as failed, and the mark is not deleted, so a notice already
 * sent is never sent twice.
 *
 * Synthetic subscriptions and Stripe answers; no email leaves this machine.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sendFailedPlanNotices, sendReminders } from "@/lib/billing-reminders";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_billing_claim_exact_only";
// A synthetic key the Resend fixture knows (tests/resend-fixture-credentials.ts), shared with tests/plan-payment-failed.test.ts.
process.env.RESEND_API_KEY = "re_test_failed_plan_only";

const NOW = 1_791_700_000;
const DAY = 86_400;
const PRICE = { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } };
const emails: string[] = [];
let lists: Record<string, Record<string, unknown>[]> = {};

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

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com") {
    if (method === "GET" && url.pathname === "/v1/subscriptions") {
      return new Response(JSON.stringify({ data: lists[url.searchParams.get("status") ?? ""] ?? [], has_more: false }), { status: 200 });
    }
    if (method === "POST" && url.pathname.startsWith("/v1/subscriptions/")) {
      return new Response(JSON.stringify({ id: url.pathname.split("/").pop() }), { status: 200 });
    }
  }
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    emails.push(Array.isArray(body.to) ? body.to[0] : body.to);
    return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
const isClaim = (cmd: Cmd) => cmd[0] === "SET" && String(cmd[1]).startsWith("nl:remind:") && cmd.includes("NX");
/** The claim's SET NX runs for real and then answers `reply` ("short": the pipeline answers no replies; "throw": it rejects). */
async function withClaimReply<T>(reply: unknown, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Cmd[]) => {
    const out = await original(commands);
    if (!commands.some(isClaim)) return out;
    if (reply === "throw") throw new Error("connection reset");
    if (reply === "short") return [];
    return commands.map((cmd, i) => (isClaim(cmd) ? reply : out[i]));
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}
const markOf = async (key: string) => (await original([["GET", key]]))[0];

const UNKNOWN: [string, unknown][] = [
  ["QUEUED", "QUEUED"],
  ["undefined", undefined],
  ["an empty list", []],
  ["a short pipeline", "short"],
  ["an object", {}],
  ["the number 1", 1],
  ["a rejection", "throw"],
];

let n = 0;
const nextId = (kind: string) => `sub_${kind}${String(++n).padStart(8, "0")}`;

test("a trial notice goes once on exact replies (healthy control), and not again (confirmed control)", async () => {
  const id = nextId("Trial");
  lists = { trialing: [trial(id)] };
  emails.length = 0;
  const first = await sendReminders(NOW);
  assert.deepEqual([first.sent, emails], [1, [`${id}@example.com`]]);
  const again = await sendReminders(NOW);
  assert.deepEqual([again.sent, again.failed, emails.length], [0, 0, 1]);
});

for (const [label, reply] of UNKNOWN) {
  test(`a trial notice already sent is not sent again when its SET NX answers ${label}`, async () => {
    const id = nextId("Trial");
    lists = { trialing: [trial(id)] };
    await sendReminders(NOW);
    const key = `nl:remind:trial:${id}:${NOW + 7 * DAY}`;
    assert.equal(await markOf(key), "1", "the first notice's mark is there");
    emails.length = 0;
    const result = await withClaimReply(reply, () => sendReminders(NOW));
    assert.deepEqual([emails.length, result.sent], [0, 0], "never a second email");
    assert.equal(result.failed, 1, "said as failed, not as nothing to do");
    assert.equal(await markOf(key), "1", "and the mark is kept, not deleted");
  });

  test(`no trial notice goes on a first run whose SET NX answers ${label}`, async () => {
    const id = nextId("Trial");
    lists = { trialing: [trial(id)] };
    emails.length = 0;
    const result = await withClaimReply(reply, () => sendReminders(NOW));
    assert.deepEqual([emails.length, result.sent, result.failed], [0, 0, 1]);
  });
}

test("a failed payment notice goes once on exact replies (healthy control), and not again (confirmed control)", async () => {
  const id = nextId("Fail");
  lists = { past_due: [pastDue(id)] };
  emails.length = 0;
  const first = await sendFailedPlanNotices();
  assert.deepEqual([first.sent, emails], [1, [`${id}@example.com`]]);
  const again = await sendFailedPlanNotices();
  assert.deepEqual([again.sent, again.failed, emails.length], [0, 0, 1]);
});

for (const [label, reply] of UNKNOWN) {
  test(`a failed payment notice already sent is not sent again when its SET NX answers ${label}`, async () => {
    const id = nextId("Fail");
    lists = { past_due: [pastDue(id)] };
    await sendFailedPlanNotices();
    const key = `nl:remind:failed:in_${id.slice(4)}inv`;
    assert.equal(await markOf(key), "1", "the first notice's mark is there");
    emails.length = 0;
    const result = await withClaimReply(reply, () => sendFailedPlanNotices());
    assert.deepEqual([emails.length, result.sent], [0, 0], "never a second email");
    assert.equal(result.failed, 1, "said as failed, not as nothing to do");
    assert.equal(await markOf(key), "1", "and the mark is kept, not deleted");
  });

  test(`no failed payment notice goes on a first run whose SET NX answers ${label}`, async () => {
    const id = nextId("Fail");
    lists = { past_due: [pastDue(id)] };
    emails.length = 0;
    const result = await withClaimReply(reply, () => sendFailedPlanNotices());
    assert.deepEqual([emails.length, result.sent, result.failed], [0, 0, 1]);
  });
}

test("one unknown claim does not stop the run: the next subscription's notice still goes", async () => {
  const stuck = nextId("Trial");
  const fine = nextId("Trial");
  lists = { trialing: [trial(stuck), trial(fine)] };
  emails.length = 0;
  let first = true;
  redis.pipeline = (async (commands: Cmd[]) => {
    const out = await original(commands);
    if (first && commands.some(isClaim)) {
      first = false;
      return commands.map((cmd, i) => (isClaim(cmd) ? "QUEUED" : out[i]));
    }
    return out;
  }) as typeof redis.pipeline;
  try {
    const result = await sendReminders(NOW);
    assert.deepEqual([result.sent, result.failed, emails], [1, 1, [`${fine}@example.com`]]);
  } finally {
    redis.pipeline = original;
  }
});
