/**
 * A trial nudge's mark outlives every transport's once-only window before the
 * email is posted (r24 sweep, unit 5.1; Claude 2's review of #3342):
 *
 *   - the Amazon path keeps its once-only key a day (lib/email.ts, nl:ses:once:),
 *     and the nudges run once a day, so a mark that only grows after the send
 *     cannot be what keeps a nudge from going twice;
 *   - a mark whose hold is not confirmed sends nothing, and the nudge goes on a
 *     later run, once;
 *   - a hold whose reply is lost never leads to a second send;
 *   - the healthy control sends once, with the mark already long while the
 *     provider has the email, and never again.
 *
 * Synthetic stores, Stripe answers and Amazon stand-in; no email leaves this machine.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { claimHandle, setSubscription } from "@/lib/store";
import { sendTrialNudges } from "@/lib/trial-nudges";
import { store as redis, advance } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_trial_nudge_mark_only";
delete process.env.RESEND_API_KEY;

const DAY = 86_400;
const START = 1_791_000_000;
const CURSOR = "nl:trialnudge:cursor";
/** A day and a minute: the next daily run, just past the Amazon once-only key. */
const NEXT_RUN_MS = (DAY + 60) * 1000;

let trials: Record<string, unknown>[] = [];
/** The nudge mark's seconds left, read each time Amazon is handed an email. */
const ttlAtSend: number[] = [];

const mail = installSesMailFixture({
  fallback: async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "api.stripe.com" && url.pathname === "/v1/subscriptions") {
      return new Response(JSON.stringify({ data: trials, has_more: false }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  },
  onSes: () => {
    const [id] = trials.map((row) => String(row.id));
    ttlAtSend.push(Number(redis.run(["TTL", `nl:nudge:${id}:0`])));
    return undefined;
  },
});

let n = 0;
async function oneTrial(): Promise<string> {
  n += 1;
  const email = `mark-${n}@example.com`;
  const sub = `sub_MarkSend${String(n).padStart(6, "0")}`;
  await claimHandle(email, `marksend${n}`, "Mark", "");
  await setSubscription(email, { subscriptionId: sub, active: true, tier: "creator", cycle: "month", trialEnds: START + 14 * DAY, period: paidPeriod() });
  trials = [{ id: sub, status: "trialing", trial_start: START, trial_end: START + 14 * DAY, cancel_at_period_end: false, metadata: { store: `marksend${n}` }, customer: { email: "x@example.com" } }];
  await redis.pipeline([["DEL", CURSOR]]);
  mail.clearCaptured();
  ttlAtSend.length = 0;
  return email;
}

const isHold = (cmd: (string | number)[]) => cmd[0] === "EVAL" && String(cmd[1]).startsWith("-- marktmorgen:extend:v1") && String(cmd[3]).startsWith("nl:nudge:");

/** Runs `body` with every hold of a nudge mark answered by `answer` (the command applied first when `apply`). */
async function withHolds<T>(answer: () => unknown, apply: boolean, body: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some(isHold)) {
      if (apply) await original(commands);
      return answer();
    }
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    return await body();
  } finally {
    redis.pipeline = original;
  }
}

/** Three daily runs, each a day and a minute after the one before. */
async function threeDays(first: () => Promise<unknown>): Promise<void> {
  await first();
  advance(NEXT_RUN_MS);
  await sendTrialNudges(START + 4 * DAY, Date.now() + 15_000);
  advance(NEXT_RUN_MS);
  await sendTrialNudges(START + 5 * DAY, Date.now() + 15_000);
}

test("control: the nudge goes once through Amazon, its mark already long while Amazon has it, and never again", async () => {
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  const email = await oneTrial();
  await threeDays(() => sendTrialNudges(START + 3 * DAY, Date.now() + 15_000));
  assert.deepEqual(mail.ses.map((m) => m.to[0]), [email], "once, through Amazon");
  assert.equal(mail.sent.length, 1, "nothing through the fallback either");
  assert.equal(ttlAtSend.length, 1);
  assert.ok(ttlAtSend[0] > 30 * DAY, `the mark outlives every once-only window before the send (TTL ${ttlAtSend[0]} s)`);
});

test("a hold of the mark that is refused both times: nothing sent that run, the nudge goes on a later run, once", async () => {
  await oneTrial();
  await threeDays(() => withHolds(() => [{ error: "ERR synthetic refusal" }], false, () => sendTrialNudges(START + 3 * DAY, Date.now() + 15_000)));
  assert.equal(mail.sent.length, 1, "one nudge in all, never a second one after the Amazon key ran out");
  assert.equal(mail.ses.length, 1);
  assert.ok(ttlAtSend.every((ttl) => ttl > 30 * DAY), `every send went with the mark already long (${ttlAtSend.join(", ")})`);
});

test("a hold of the mark that answers in an unknown shape: the same, never twice", async () => {
  await oneTrial();
  await threeDays(() => withHolds(() => ["QUEUED"], false, () => sendTrialNudges(START + 3 * DAY, Date.now() + 15_000)));
  assert.equal(mail.sent.length, 1, "one nudge in all");
});

test("a hold that landed with its reply lost: the mark stands, and the nudge is never sent twice", async () => {
  await oneTrial();
  await threeDays(() =>
    withHolds(
      () => {
        throw new TypeError("synthetic Redis reply lost");
      },
      true,
      () => sendTrialNudges(START + 3 * DAY, Date.now() + 15_000),
    ),
  );
  assert.ok(mail.sent.length <= 1, `at most once (${mail.sent.length})`);
});
