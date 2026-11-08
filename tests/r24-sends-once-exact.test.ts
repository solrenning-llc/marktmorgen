/**
 * Rule 24 for what is sent or forgotten once (lib/trial-nudges.ts,
 * lib/winback-send.ts): a reply in an unknown shape is never "not sent yet",
 * never "this run's to send" and never "forgotten".
 *
 *   - a trial nudge goes only when EXISTS answers 0 for every later nudge and
 *     SET NX answers "OK"; an answer in another shape sends nothing and counts
 *     the store as failed, never sent twice;
 *   - a person's come-back marks are counted as forgotten only from DEL's own
 *     count: any other answer rejects, so the erasure is not reported complete.
 *
 * Synthetic stores and Stripe answers; no email leaves this machine.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { claimHandle, setSubscription } from "@/lib/store";
import { sendTrialNudges } from "@/lib/trial-nudges";
import { forgetWinbackPerson } from "@/lib/winback-send";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_r24_sends_once_only";
process.env.RESEND_API_KEY = "re_test_trial_nudges_only";

const DAY = 86_400;
const START = 1_791_000_000;
const emails: string[] = [];
let trials: Record<string, unknown>[] = [];
const trial = (id: string, handle: string) => ({ id, status: "trialing", trial_start: START, trial_end: START + 14 * DAY, cancel_at_period_end: false, metadata: { store: handle }, customer: { email: "x@example.com" } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/subscriptions") return new Response(JSON.stringify({ data: trials, has_more: false }), { status: 200 });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    emails.push(Array.isArray(body.to) ? body.to[0] : body.to);
    return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
/** Commands each rule picks answer its reply ("short": the whole pipeline answers no replies at all). */
async function withReplies<T>(rules: [(cmd: Cmd) => boolean, unknown][], work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Cmd[]) => {
    const out = await original(commands);
    const ruleOf = (cmd: Cmd) => rules.find(([match]) => match(cmd));
    if (commands.some((cmd) => ruleOf(cmd)?.[1] === "short")) return [];
    return commands.map((cmd, i) => { const rule = ruleOf(cmd); return rule ? rule[1] : out[i]; });
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}
const withReply = <T>(match: (cmd: Cmd) => boolean, reply: unknown, work: () => Promise<T>) => withReplies([[match, reply]], work);

let n = 0;
/** A store on a trial that has not sold, due its first nudge, and the subscription Stripe lists for it. */
async function trialStore(): Promise<{ email: string; sub: string }> {
  n += 1;
  const email = `r24-nudge-${n}@example.com`;
  const sub = `sub_R24Nudge${String(n).padStart(6, "0")}`;
  await claimHandle(email, `r24nudge${n}`, "Nudge", "");
  await setSubscription(email, { subscriptionId: sub, active: true, tier: "creator", cycle: "month", trialEnds: START + 14 * DAY, period: paidPeriod() });
  trials = [trial(sub, `r24nudge${n}`)];
  return { email, sub };
}
const isExists = (cmd: Cmd) => cmd[0] === "EXISTS" && String(cmd[1]).startsWith("nl:nudge:");
const isClaim = (cmd: Cmd) => cmd[0] === "SET" && String(cmd[1]).startsWith("nl:nudge:") && cmd.includes("NX");

test("a nudge goes once on exact replies (healthy control), and not again (confirmed control)", async () => {
  const { email } = await trialStore();
  emails.length = 0;
  const first = await sendTrialNudges(START + 3 * DAY);
  assert.deepEqual([first.sent, emails], [1, [email]]);
  const again = await sendTrialNudges(START + 3 * DAY);
  assert.deepEqual([again.sent, emails.length], [0, 1]);
});

for (const [label, reply] of [["undefined", undefined], ["a short pipeline", "short"], ["an object", {}], ["the number 1", 1]] as [string, unknown][]) {
  test(`a nudge already sent is not sent again when its SET NX answers ${label}`, async () => {
    await trialStore();
    await sendTrialNudges(START + 3 * DAY);
    emails.length = 0;
    // EXISTS is answered 0 too, so only the claim stands between the store and a second email.
    const result = await withReplies([[isExists, 0], [isClaim, reply]], () => sendTrialNudges(START + 3 * DAY));
    assert.deepEqual([emails.length, result.sent], [0, 0]);
    // Read back (lib/claim-mark.ts), the mark holds the earlier send's value: known as sent, so nothing to do, not a
    // failure. Before the read-back this was unknown and said as failed; either way no second email goes.
    assert.equal(result.failed, 0, "read back as already sent");
  });
}

for (const [label, reply] of [["undefined", undefined], ["a short pipeline", "short"], ["an object", {}], ["text", "1"]] as [string, unknown][]) {
  test(`no nudge goes when whether one was sent reads as ${label}`, async () => {
    await trialStore();
    emails.length = 0;
    const result = await withReply(isExists, reply, () => sendTrialNudges(START + 3 * DAY));
    assert.deepEqual([emails.length, result.sent, result.failed], [0, 0, 1]);
  });
}

// Codex Q and Claude 5 on #2898 (LOW, introduced): a SET NX that landed with its reply lost threw, and the next day's
// run saw the mark (EXISTS 1) and skipped, so the first nudge was lost. The claim is read back now (lib/claim-mark.ts):
// holding this run's own value it is ours and the nudge goes, once; unknown even then, it is let go and goes next day.
const isMarkRead = (cmd: Cmd) => cmd[0] === "GET" && String(cmd[1]).startsWith("nl:nudge:");
test("a nudge whose SET NX landed with its reply lost goes once, never lost and never twice", async () => {
  const { email } = await trialStore();
  emails.length = 0;
  const lost = await withReply(isClaim, "QUEUED", () => sendTrialNudges(START + 3 * DAY));
  const next = await sendTrialNudges(START + 4 * DAY);
  assert.deepEqual({ emails, lost: lost.sent + lost.failed, next: next.sent }, { emails: [email], lost: 1, next: 0 });
});

test("a nudge whose claim and its read-back are both unknown goes the next day, once", async () => {
  const { email } = await trialStore();
  emails.length = 0;
  const unknown = await withReplies([[isClaim, "QUEUED"], [isMarkRead, {}]], () => sendTrialNudges(START + 3 * DAY));
  assert.deepEqual([unknown.sent, unknown.failed, emails.length], [0, 1, 0], "nothing sent on it, said as failed");
  const next = await sendTrialNudges(START + 4 * DAY);
  const after = await sendTrialNudges(START + 5 * DAY);
  assert.deepEqual({ emails, next: next.sent, after: after.sent }, { emails: [email], next: 1, after: 0 });
});

const STATS = "a".repeat(32);
test("forgetting come-back marks counts what DEL removed (healthy and confirmed-absence controls)", async () => {
  const onceKeys = async () => {
    // The marks as lib/winback-send.ts writes them: found by the DEL it sends.
    let keys: Cmd = [];
    await withReply((cmd) => { if (cmd[0] === "DEL") keys = cmd; return false; }, null, () => forgetWinbackPerson(STATS, ["p1", "p2"], "buyer@example.com"));
    return keys.slice(1).map(String);
  };
  const keys = await onceKeys();
  assert.equal(keys.length, 2);
  await original(keys.map((key) => ["SET", key, "1"]));
  assert.equal(await forgetWinbackPerson(STATS, ["p1", "p2"], "buyer@example.com"), 2);
  assert.equal(await forgetWinbackPerson(STATS, ["p1", "p2"], "buyer@example.com"), 0);
});

for (const [label, reply] of [["undefined", undefined], ["a short pipeline", "short"], ["an object", {}], ["text", "2"], ["a negative", -1]] as [string, unknown][]) {
  test(`forgetting come-back marks rejects when DEL answers ${label}, rather than reporting them forgotten`, async () => {
    await withReply((cmd) => cmd[0] === "DEL", reply, () => assert.rejects(() => forgetWinbackPerson(STATS, ["p1"], "buyer@example.com")));
  });
}
