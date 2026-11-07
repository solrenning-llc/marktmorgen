/**
 * Rule 24 for the billing emails sent once per charge (lib/billing-reminders.ts):
 * a trial or yearly renewal notice (sendReminders) and a failed plan payment
 * notice (sendFailedPlanNotices) are claimed with lib/claim-mark.ts claimMark,
 * a SET NX holding a value only that run writes. "OK" sends; nil is a mark
 * already taken. Any other answer ("QUEUED", undefined, an empty or short
 * pipeline, an object, a number, a rejection) is read back: the run's own value
 * means the write landed while its answer was lost, so the notice still goes,
 * once; another value (or a "1" written before marks carried their own value)
 * is taken, and nothing goes. Read back as nothing known, nothing is sent, the
 * charge is counted as failed, the mark is let go only while it holds that
 * run's own value (releaseMark, so the next run can send it, once), and the
 * rest of that pass is given up (Redis is not answering). A send that fails
 * lets go of the mark only while it still holds that run's value.
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
/** While set, the next Resend call fails (500) after running this, once. */
let emailFails: (() => Promise<void>) | null = null;
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
    if (emailFails) {
      const before = emailFails;
      emailFails = null;
      await before();
      return new Response(JSON.stringify({ message: "down" }), { status: 500 });
    }
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
/** A value lib/claim-mark.ts claimValue writes: the time in milliseconds, a point, nine random digits. */
const OWN_VALUE = /^\d{13}\.\d{9}$/;
const trialKey = (id: string) => `nl:remind:trial:${id}:${NOW + 7 * DAY}`;
const failedKey = (id: string) => `nl:remind:failed:in_${id.slice(4)}inv`;
const touchesMarks = (commands: Cmd[]) => commands.some((cmd) => cmd.some((part) => String(part).startsWith("nl:remind:")));
const isRelease = (commands: Cmd[]) => commands.some((cmd) => cmd[0] === "EVAL" && String(cmd[1]).startsWith("-- marktmorgen:release:v1"));
type Down = { landed: boolean; releaseWorks: boolean };
/**
 * Redis stops answering about the marks: every pipeline that touches one rejects. With `landed`, the claim's SET runs
 * for real first (the write landed, then the answer and the read back were lost); with `releaseWorks`, the
 * compare-and-delete script that lets a mark go still runs. Counts the claims and the releases tried.
 */
async function withRedisDown<T>(down: Down, work: () => Promise<T>): Promise<{ result: T; claims: number; releases: number }> {
  let claims = 0;
  let releases = 0;
  redis.pipeline = (async (commands: Cmd[]) => {
    if (!touchesMarks(commands)) return original(commands);
    if (isRelease(commands)) {
      releases += 1;
      if (down.releaseWorks) return original(commands);
    }
    if (commands.some(isClaim)) {
      claims += 1;
      if (down.landed) await original(commands);
    }
    throw new Error("fetch failed: Redis is down");
  }) as typeof redis.pipeline;
  try {
    return { result: await work(), claims, releases };
  } finally {
    redis.pipeline = original;
  }
}

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
  // Changed with claimMark (rule 23): the mark holds the run's own value, no longer "1".
  assert.match(String(await markOf(trialKey(id))), OWN_VALUE, "the mark holds a value only that run wrote");
  const again = await sendReminders(NOW);
  assert.deepEqual([again.sent, again.failed, emails.length], [0, 0, 1]);
});

test('a trial mark written as "1" before marks carried their own value still counts as taken', async () => {
  const id = nextId("Trial");
  lists = { trialing: [trial(id)] };
  await original([["SET", trialKey(id), "1", "EX", 60 * DAY]]);
  emails.length = 0;
  const result = await sendReminders(NOW);
  assert.deepEqual([emails.length, result.sent, result.failed], [0, 0, 0]);
  assert.equal(await markOf(trialKey(id)), "1", "and it is left as it is");
});

for (const [label, reply] of UNKNOWN) {
  test(`a trial notice already sent is not sent again when its SET NX answers ${label}`, async () => {
    const id = nextId("Trial");
    lists = { trialing: [trial(id)] };
    await sendReminders(NOW);
    const mark = await markOf(trialKey(id));
    assert.match(String(mark), OWN_VALUE, "the first notice's mark is there");
    emails.length = 0;
    const result = await withClaimReply(reply, () => sendReminders(NOW));
    assert.deepEqual([emails.length, result.sent], [0, 0], "never a second email");
    // Changed with claimMark (rule 23): was failed 1. The mark read back holds another run's value, so it is known
    // to be taken: nothing to do, not a failure.
    assert.equal(result.failed, 0, "read back as another run's mark: taken, not failed");
    assert.equal(await markOf(trialKey(id)), mark, "and the mark is kept, not deleted");
  });

  test(`a trial mark written as "1" is still taken when its SET NX answers ${label}`, async () => {
    const id = nextId("Trial");
    lists = { trialing: [trial(id)] };
    await original([["SET", trialKey(id), "1", "EX", 60 * DAY]]);
    emails.length = 0;
    const result = await withClaimReply(reply, () => sendReminders(NOW));
    assert.deepEqual([emails.length, result.sent, result.failed], [0, 0, 0]);
    assert.equal(await markOf(trialKey(id)), "1");
  });

  // Changed with claimMark (rule 23): was [0, 0, 1] (nothing sent, failed). The SET landed and only its answer was
  // lost, so the read back finds this run's own value: the notice goes now, once, and a later run sends nothing.
  test(`a first run whose SET NX landed but answered ${label} still sends the trial notice, once`, async () => {
    const id = nextId("Trial");
    lists = { trialing: [trial(id)] };
    emails.length = 0;
    const result = await withClaimReply(reply, () => sendReminders(NOW));
    assert.deepEqual([emails, result.sent, result.failed], [[`${id}@example.com`], 1, 0]);
    assert.match(String(await markOf(trialKey(id))), OWN_VALUE);
    const later = await sendReminders(NOW);
    assert.deepEqual([later.sent, later.failed, emails.length], [0, 0, 1], "never a second email");
  });
}

test("a failed payment notice goes once on exact replies (healthy control), and not again (confirmed control)", async () => {
  const id = nextId("Fail");
  lists = { past_due: [pastDue(id)] };
  emails.length = 0;
  const first = await sendFailedPlanNotices();
  assert.deepEqual([first.sent, emails], [1, [`${id}@example.com`]]);
  // Changed with claimMark (rule 23): the mark holds the run's own value, no longer "1".
  assert.match(String(await markOf(failedKey(id))), OWN_VALUE);
  const again = await sendFailedPlanNotices();
  assert.deepEqual([again.sent, again.failed, emails.length], [0, 0, 1]);
});

test('a failed payment mark written as "1" before marks carried their own value still counts as taken', async () => {
  const id = nextId("Fail");
  lists = { past_due: [pastDue(id)] };
  await original([["SET", failedKey(id), "1", "EX", 90 * DAY]]);
  emails.length = 0;
  const result = await sendFailedPlanNotices();
  assert.deepEqual([emails.length, result.sent, result.failed], [0, 0, 0]);
  assert.equal(await markOf(failedKey(id)), "1");
});

for (const [label, reply] of UNKNOWN) {
  test(`a failed payment notice already sent is not sent again when its SET NX answers ${label}`, async () => {
    const id = nextId("Fail");
    lists = { past_due: [pastDue(id)] };
    await sendFailedPlanNotices();
    const mark = await markOf(failedKey(id));
    assert.match(String(mark), OWN_VALUE, "the first notice's mark is there");
    emails.length = 0;
    const result = await withClaimReply(reply, () => sendFailedPlanNotices());
    assert.deepEqual([emails.length, result.sent], [0, 0], "never a second email");
    // Changed with claimMark (rule 23): was failed 1; read back as another run's mark, it is taken, not failed.
    assert.equal(result.failed, 0, "read back as another run's mark: taken, not failed");
    assert.equal(await markOf(failedKey(id)), mark, "and the mark is kept, not deleted");
  });

  test(`a failed payment mark written as "1" is still taken when its SET NX answers ${label}`, async () => {
    const id = nextId("Fail");
    lists = { past_due: [pastDue(id)] };
    await original([["SET", failedKey(id), "1", "EX", 90 * DAY]]);
    emails.length = 0;
    const result = await withClaimReply(reply, () => sendFailedPlanNotices());
    assert.deepEqual([emails.length, result.sent, result.failed], [0, 0, 0]);
    assert.equal(await markOf(failedKey(id)), "1");
  });

  // Changed with claimMark (rule 23): was [0, 0, 1]; the write landed, so the notice goes now, once.
  test(`a first run whose SET NX landed but answered ${label} still sends the failed payment notice, once`, async () => {
    const id = nextId("Fail");
    lists = { past_due: [pastDue(id)] };
    emails.length = 0;
    const result = await withClaimReply(reply, () => sendFailedPlanNotices());
    assert.deepEqual([emails, result.sent, result.failed], [[`${id}@example.com`], 1, 0]);
    const later = await sendFailedPlanNotices();
    assert.deepEqual([later.sent, later.failed, emails.length], [0, 0, 1], "never a second email");
  });
}

// Changed with claimMark (rule 23): was "one unknown claim does not stop the run", sent 1 and failed 1. A lost answer
// whose write landed is now read back as this run's own, so both notices go, once each.
test("a lost answer on one claim does not stop the run: both trial notices go, once each", async () => {
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
    assert.deepEqual([result.sent, result.failed, emails], [2, 0, [`${stuck}@example.com`, `${fine}@example.com`]]);
  } finally {
    redis.pipeline = original;
  }
});

// Changed with releaseMark on "unknown" (coordinator, 7 November 2026; rule 23): a mark that landed while Redis stopped
// answering was kept and the notice never went; it is now let go while it holds the lost run's own value, so the next
// run sends it, once. When the release cannot run either, the mark stays and no run ever sends it twice.
const DOWN: [string, Down][] = [
  ["the SET landed, the release runs", { landed: true, releaseWorks: true }],
  ["the SET landed, the release fails too", { landed: true, releaseWorks: false }],
  ["the SET never landed", { landed: false, releaseWorks: true }],
];
for (const [how, down] of DOWN) {
  // Sent by a later run: once when the mark is gone (never landed, or let go); never while the lost run's value stays.
  const laterSends = !down.landed || down.releaseWorks ? 1 : 0;
  test(`Redis down (${how}): no trial notice, one failure, the pass stops at the first claim, and later at most one email`, async () => {
    const first = nextId("Trial");
    const second = nextId("Trial");
    const yearly = nextId("Year");
    lists = {
      trialing: [trial(first), trial(second)],
      active: [{ ...trial(yearly), status: "active", trial_end: null, items: { data: [{ current_period_start: NOW - 340 * DAY, current_period_end: NOW + 25 * DAY, price: { lookup_key: "nimbus_labs_creator_year", unit_amount: 29000, recurring: { interval: "year" } } }] } }],
    };
    emails.length = 0;
    const { result, claims, releases } = await withRedisDown(down, () => sendReminders(NOW));
    assert.deepEqual([emails.length, result.sent, result.failed], [0, 0, 1], "nothing sent, said as failed");
    assert.equal(claims, 1, "no further claim waits out its own timeout once Redis did not answer");
    assert.equal(releases, 1, "the unknown claim's own mark is let go, best effort");
    const mark = await markOf(trialKey(first));
    if (down.landed && !down.releaseWorks) assert.match(String(mark), OWN_VALUE, "a release that could not run leaves the mark as it landed");
    else assert.equal(mark, null, "the lost run's own mark is gone");
    const later = await sendReminders(NOW);
    assert.equal(later.failed, 0);
    await sendReminders(NOW);
    assert.equal(emails.filter((to) => to === `${first}@example.com`).length, laterSends, laterSends ? "sent by the next run, exactly once" : "never sent twice");
    assert.deepEqual(
      [emails.filter((to) => to === `${second}@example.com`).length, emails.filter((to) => to === `${yearly}@example.com`).length],
      [1, 1],
      "the subscriptions after it are claimed on the next run, once each",
    );
  });

  test(`Redis down (${how}): no failed payment notice, one failure, the pass stops at the first claim, and later at most one email`, async () => {
    const first = nextId("Fail");
    const second = nextId("Fail");
    lists = { past_due: [pastDue(first), pastDue(second)] };
    emails.length = 0;
    const { result, claims, releases } = await withRedisDown(down, () => sendFailedPlanNotices());
    assert.deepEqual([emails.length, result.sent, result.failed, claims, releases], [0, 0, 1, 1, 1]);
    if (down.landed && !down.releaseWorks) assert.match(String(await markOf(failedKey(first))), OWN_VALUE);
    else assert.equal(await markOf(failedKey(first)), null);
    await sendFailedPlanNotices();
    await sendFailedPlanNotices();
    assert.equal(emails.filter((to) => to === `${first}@example.com`).length, laterSends);
    assert.equal(emails.filter((to) => to === `${second}@example.com`).length, 1);
  });
}

test("a trial notice whose send failed lets its own mark go, so the next run sends it, once", async () => {
  const id = nextId("Trial");
  lists = { trialing: [trial(id)] };
  emails.length = 0;
  emailFails = async () => {};
  const first = await sendReminders(NOW);
  assert.deepEqual([first.sent, first.failed], [0, 1]);
  assert.equal(await markOf(trialKey(id)), null, "its own mark is let go");
  const later = await sendReminders(NOW);
  assert.deepEqual([later.sent, emails], [1, [`${id}@example.com`]]);
});

test("a trial notice whose send failed never lets go of a mark another run wrote meanwhile", async () => {
  const id = nextId("Trial");
  lists = { trialing: [trial(id)] };
  emails.length = 0;
  emailFails = async () => {
    await original([["SET", trialKey(id), "another-run", "EX", 60 * DAY]]);
  };
  const first = await sendReminders(NOW);
  assert.deepEqual([first.sent, first.failed], [0, 1]);
  assert.equal(await markOf(trialKey(id)), "another-run", "not this run's to let go");
});

test("a failed payment notice whose send failed lets its own mark go, and never another run's", async () => {
  const id = nextId("Fail");
  lists = { past_due: [pastDue(id)] };
  emails.length = 0;
  emailFails = async () => {};
  const first = await sendFailedPlanNotices();
  assert.deepEqual([first.sent, first.failed], [0, 1]);
  assert.equal(await markOf(failedKey(id)), null, "its own mark is let go");
  const later = await sendFailedPlanNotices();
  assert.deepEqual([later.sent, emails], [1, [`${id}@example.com`]]);

  const other = nextId("Fail");
  lists = { past_due: [pastDue(other)] };
  emailFails = async () => {
    await original([["SET", failedKey(other), "another-run", "EX", 90 * DAY]]);
  };
  const again = await sendFailedPlanNotices();
  assert.deepEqual([again.sent, again.failed], [0, 1]);
  assert.equal(await markOf(failedKey(other)), "another-run", "not this run's to let go");
});
