import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CURRENT_RESEND_FALLBACK_REVIEW, RESEND_FALLBACK_BUDGET_LUA,
  initializeResendFallbackBudget, reserveResendFallback,
  markResendFallbackDispatched, settleResendFallback, resendFallbackBudgetKeys,
  cancelResendFallbackReserved, readAcceptedResendFallbackReceipt, RESEND_FALLBACK_RECEIPT_MS,
  type ResendFallbackReview, type ResendFallbackSdk, type ResendFallbackUsage,
} from "@/lib/resend-fallback-budget";

const realNow = Date.now;
const now = Date.parse("2026-11-01T12:00:00.000Z");
const start = Date.parse("2026-10-17T15:30:00.000Z"), reset = Date.parse("2026-11-17T15:30:00.000Z");
const review = (): ResendFallbackReview => ({
  schema: 1, reviewId: "synthetic:review:1", accountId: "synthetic:account:1",
  paidPlan: "Pro", paidForPeriod: true, includedEmails: 50_000,
  periodStartMs: start, resetsAtMs: reset, checkedAtMs: now - 1000, validUntilMs: now + 60_000,
  evidence: "synthetic paid account and billing-period evidence",
  protection: { kind: "inclusive_provider_hard_cap", sentAndReceived: true, overagesDisabled: true, capEmails: 50_000, evidence: "synthetic provider-inclusive cap evidence" },
  bootstrap: { noUnresolvedPriorAttempts: true, allPriorUsageIncluded: true, evidence: "synthetic reviewed first initialization" },
});
const usage = (): ResendFallbackUsage => ({ source: "resend_usage_api", accountId: "synthetic:account:1", observedAtMs: now, monthly: { used: 13, sent: 11, received: 2, limit: 50_000, resetsAt: new Date(reset).toISOString() } });
const request = () => ({ review: review(), usage: usage(), attemptId: "synthetic:message:1:stable-intent", recipients: 1, payloadFingerprint: "f".repeat(64) });
const noSdk: ResendFallbackSdk = { async pipeline() { throw new Error("No I/O belongs to unreviewed admission"); } };
const withClock = async (work: () => Promise<void>) => { Date.now = () => now; try { await work(); } finally { Date.now = realNow; } };

test("the real review is absent; usage alone cannot authorize fallback or initialize missing state", async () => withClock(async () => {
  assert.equal(CURRENT_RESEND_FALLBACK_REVIEW, null);
  assert.deepEqual(await reserveResendFallback({ usage: usage(), attemptId: "synthetic", recipients: 1 }, noSdk), { status: "denied", reason: "unreviewed_account" });
  assert.deepEqual(await initializeResendFallbackBudget({ usage: usage() }, noSdk), { status: "denied", reason: "unreviewed_bootstrap" });
  const unproved = review(); delete unproved.bootstrap;
  assert.deepEqual(await initializeResendFallbackBudget({ review: unproved, usage: usage() }, noSdk), { status: "denied", reason: "unreviewed_bootstrap" });
}));

test("every incomplete, unpaid, mismatched or stale protection fails before Redis", async () => withClock(async () => {
  const changes: ((value: ReturnType<typeof request>) => void)[] = [
    value => { value.review.paidForPeriod = false as true; },
    value => { value.review.paidPlan = "Free" as "Pro"; },
    value => { value.review.includedEmails = 0; },
    value => { value.review.validUntilMs = now; },
    value => { value.review.checkedAtMs = now + 1; },
    value => { value.review.periodStartMs = now; },
    value => { value.review.resetsAtMs += 1; },
    value => { value.review.evidence = ""; },
    value => { value.review.protection = { ...value.review.protection, overagesDisabled: false } as unknown as ResendFallbackReview["protection"]; },
    value => { value.review.protection = { ...value.review.protection, sentAndReceived: false } as unknown as ResendFallbackReview["protection"]; },
    value => { value.review.protection = { ...value.review.protection, capEmails: 50_001 } as ResendFallbackReview["protection"]; },
    value => { value.review.protection = { kind: "isolated_account", allSendersUseThisLedger: true, smtpDisabled: true, receivingDisabled: false as true, otherSendingPathsDisabled: true, evidence: "synthetic incomplete isolation" }; },
    value => { value.usage.accountId = "synthetic:other-account"; },
    value => { value.usage.source = "local_sent_counter" as "resend_usage_api"; },
    value => { value.usage.observedAtMs = now - 60_001; },
    value => { value.usage.observedAtMs = now + 1; },
    value => { value.usage.monthly.used = 11; },
    value => { value.usage.monthly.received = -1; },
    value => { value.usage.monthly.limit = null as unknown as number; },
    value => { value.usage.monthly.sent = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.usage.monthly.resetsAt = "tomorrow"; },
    value => { value.recipients = 0; }, value => { value.recipients = 101; },
  ];
  for (const change of changes) {
    const value = request(); change(value);
    assert.deepEqual(await reserveResendFallback(value, noSdk), { status: "denied", reason: "unreviewed_account" });
  }
}));

test("inherited fields, getters, throwing proxies and sparse acknowledgements never grant admission", async () => withClock(async () => {
  let getters = 0;
  const value = request();
  const inherited = { ...value, review: Object.create(value.review) };
  assert.equal((await reserveResendFallback(inherited, noSdk)).status, "denied");
  const getter = Object.defineProperty({ ...value }, "usage", { get() { getters++; return usage(); } });
  assert.equal((await reserveResendFallback(getter, noSdk)).status, "denied");
  const trapped = { ...value, review: new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("synthetic trap"); } }) };
  assert.equal((await reserveResendFallback(trapped, noSdk)).status, "denied");
  let identityReads = 0;
  const changingIdentity = new Proxy(review(), { getOwnPropertyDescriptor(target, key) {
    if (key === "accountId") return { configurable: true, enumerable: true, writable: true, value: ++identityReads === 1 ? "synthetic:account:1" : "synthetic:other-account" };
    return Object.getOwnPropertyDescriptor(target, key);
  } });
  let usedLedger = "";
  await reserveResendFallback({ ...value, review: changingIdentity }, { async pipeline(batch) { usedLedger = String(batch[0][3]); return [["denied", "exhausted"]]; } });
  assert.equal(identityReads, 1);
  assert.equal(usedLedger, resendFallbackBudgetKeys("synthetic:account:1", value.attemptId)[0]);
  const sparse = new Array(1);
  assert.deepEqual(await reserveResendFallback(value, { async pipeline() { return sparse; } }), { status: "unknown" });
  const computed = Object.defineProperty([], "0", { get() { getters++; return ["reserved"]; } });
  assert.deepEqual(await reserveResendFallback(value, { async pipeline() { return computed; } }), { status: "unknown" });
  assert.equal(getters, 0);
}));

test("the global key is account-wide, the cap includes receipts, and a reviewId change cannot select new storage", async () => withClock(async () => {
  const calls: (string | number)[][] = [];
  const sdk: ResendFallbackSdk = { async pipeline(batch) { calls.push(...batch); return [["denied", "exhausted"]]; } };
  const first = request(); first.review.includedEmails = 1000; first.usage.monthly.limit = 2000;
  first.review.protection = { kind: "isolated_account", allSendersUseThisLedger: true, smtpDisabled: true, receivingDisabled: true, otherSendingPathsDisabled: true, evidence: "synthetic full isolation" };
  assert.deepEqual(await reserveResendFallback(first, sdk), { status: "denied", reason: "exhausted" });
  const second = { ...first, review: { ...first.review, reviewId: "synthetic:review:2" } };
  await reserveResendFallback(second, sdk);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "EVAL"); assert.equal(calls[0][1], RESEND_FALLBACK_BUDGET_LUA); assert.equal(calls[0][2], 2);
  assert.equal(calls[0][3], calls[1][3]); assert.equal(calls[0][4], calls[1][4]);
  assert.equal(calls[0][13], 1000); assert.equal(calls[0][15], 13); assert.equal(calls[0][16], 11); assert.equal(calls[0][17], 2);
  const [ledger, claim] = resendFallbackBudgetKeys(first.review.accountId, first.attemptId);
  assert.equal(calls[0][3], ledger); assert.equal(calls[0][4], claim);
  assert.equal(ledger.match(/\{[^}]+\}/)?.[0], claim.match(/\{[^}]+\}/)?.[0]);
}));

test("a valid reservation is only a hold; one exact dispatch acknowledgement is required before POST", async () => withClock(async () => {
  const sdk: ResendFallbackSdk = { async pipeline(batch) {
    const args = batch[0].slice(5);
    return [["reserved", args[2], String(args[3]), String(args[4]), String(args[5]), String(args[7])]];
  } };
  const held = await reserveResendFallback(request(), sdk);
  assert.equal(held.status, "reserved");
  if (held.status !== "reserved") return;
  const claim = held.claim;
  assert.equal(claim.recipients, 1); assert.equal(claim.periodStartMs, start); assert.equal(claim.resetsAtMs, reset);
  const dispatchSdk: ResendFallbackSdk = { async pipeline(batch) { return [["dispatch", claim.token, "1", String(now + 1000), batch[0].at(-1), String(now)]]; } };
  const dispatched = await markResendFallbackDispatched(claim, dispatchSdk);
  assert.equal(dispatched.status, "dispatch");
  if (dispatched.status !== "dispatch") return;
  assert.match(dispatched.claim.dispatchToken!, /^[a-f0-9]{32}$/);
  assert.equal(dispatched.sendBeforeMs, now + 1000);
  assert.ok(Number.isFinite(dispatched.sendBeforeMonotonicMs));
  assert.equal(claim.dispatchToken, undefined);
  assert.deepEqual(await markResendFallbackDispatched(claim, { async pipeline(batch) { return [["dispatch", claim.token, "1", String(now + 1001), batch[0].at(-1), String(now)]]; } }), { status: "unknown" });
  assert.deepEqual(await markResendFallbackDispatched(claim, { async pipeline() { throw new Error("synthetic applied write and lost response"); } }), { status: "unknown" });
  assert.deepEqual(await markResendFallbackDispatched(claim, { async pipeline() { return [["denied", "already_dispatched"]]; } }), { status: "denied", reason: "already_dispatched" });
  assert.deepEqual(await settleResendFallback(claim, "confirmed_not_accepted", noSdk), { status: "denied", reason: "unconfirmed_dispatch" });
  assert.deepEqual(await settleResendFallback(dispatched.claim, "unknown", { async pipeline() { return [["settled", "unknown"]]; } }), { status: "settled", outcome: "unknown" });
  assert.deepEqual(await settleResendFallback(dispatched.claim, "accepted", { async pipeline() { return [["already_settled", "accepted"]]; } }), { status: "already_settled", outcome: "accepted" });
  assert.deepEqual(await settleResendFallback(dispatched.claim, "confirmed_not_accepted", { async pipeline() { return [["settled", "accepted"]]; } }), { status: "unknown" });
  assert.deepEqual(await settleResendFallback(dispatched.claim, "unknown", { async pipeline() { return [["already_settled", "unknown"]]; } }), { status: "unknown" });
}));

test("local cancellation is a separate reserved-only CAS and dispatch tokens are per invocation", async () => withClock(async () => {
  const value = request();
  const held = await reserveResendFallback(value, { async pipeline(batch) { const a = batch[0].slice(5); return [["reserved", a[2], String(a[3]), String(a[4]), String(a[5]), String(a[7])]]; } });
  assert.equal(held.status, "reserved"); if (held.status !== "reserved") return;
  const tokens: unknown[] = [];
  const sdk: ResendFallbackSdk = { async pipeline(batch) { const a = batch[0].slice(5); tokens.push(a[21]); return [["dispatch", held.claim.token, "1", String(now + 1000), a[21], String(now)]]; } };
  await markResendFallbackDispatched(held.claim, sdk); await markResendFallbackDispatched(held.claim, sdk);
  assert.notEqual(tokens[0], tokens[1]);
  assert.deepEqual(await cancelResendFallbackReserved(held.claim, { async pipeline(batch) { assert.equal(batch[0][5], "cancel"); return [["denied", "not_reserved"]]; } }), { status: "denied", reason: "not_reserved" });
  assert.deepEqual(await cancelResendFallbackReserved(held.claim, { async pipeline() { return [["released"]]; } }), { status: "released" });
  assert.deepEqual(await cancelResendFallbackReserved(held.claim, { async pipeline() { return [["already_released"]]; } }), { status: "already_released" });
  assert.deepEqual(await cancelResendFallbackReserved(held.claim, { async pipeline() { throw Error("Lost cancel ACK"); } }), { status: "unknown" });
}));

test("Redis remaining time is consumed from before RPC even with a frozen or offset worker clock", async () => withClock(async () => {
  const held = await reserveResendFallback(request(), { async pipeline(batch) { const a = batch[0].slice(5); return [["reserved", a[2], String(a[3]), String(a[4]), String(a[5]), String(a[7])]]; } });
  assert.equal(held.status, "reserved"); if (held.status !== "reserved") return;
  for (const offset of [0, -400]) {
    Date.now = () => now + offset;
    const late: ResendFallbackSdk = { async pipeline(batch) {
      await new Promise(resolve => setTimeout(resolve, 35));
      return [["dispatch", held.claim.token, "1", String(now + 20), batch[0].at(-1), String(now)]];
    } };
    assert.deepEqual(await markResendFallbackDispatched(held.claim, late), { status: "unknown" });
  }
  Date.now = () => now;
  for (const badTime of [undefined, null, now, String(now + 1000), "00", String(now - 1_001)]) {
    const sdk: ResendFallbackSdk = { async pipeline(batch) { return [["dispatch", held.claim.token, "1", String(now + 1000), batch[0].at(-1), badTime]]; } };
    assert.deepEqual(await markResendFallbackDispatched(held.claim, sdk), { status: "unknown" });
  }
}));

test("accepted recovery requires an exact owned payload-bound receipt, never a denial reason", async () => withClock(async () => {
  const value = request(), hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const input = { accountId: value.review.accountId, attemptId: value.attemptId, payloadFingerprint: value.payloadFingerprint, recipients: 1 };
  const proof = ["accepted", hash(input.accountId), hash(input.attemptId), input.payloadFingerprint, "1", String(now - 500), String(now - 500 + RESEND_FALLBACK_RECEIPT_MS), String(now)];
  const good = await readAcceptedResendFallbackReceipt(input, { async pipeline(batch) { assert.equal(batch.length, 1); assert.equal(batch[0][5], "receipt"); return [proof]; } });
  assert.deepEqual(good, { status: "accepted", ...input, acceptedAtMs: now - 500, expiresAtMs: now - 500 + RESEND_FALLBACK_RECEIPT_MS });
  const bad = [["denied", "completed"], ["accepted"], [...proof, "extra"], ...[1, 2, 3, 4, 5, 6, 7].map(i => { const p = [...proof]; p[i] = i < 4 ? "e".repeat(64) : "00"; return p; })];
  for (const reply of bad) assert.equal((await readAcceptedResendFallbackReceipt(input, { async pipeline() { return [reply]; } })).status, "unknown");
  let getters = 0;
  const computed = Object.defineProperty({ ...input }, "payloadFingerprint", { get() { getters++; return input.payloadFingerprint; } });
  assert.equal((await readAcceptedResendFallbackReceipt(computed, noSdk)).status, "denied"); assert.equal(getters, 0);
}));

test("a repeated reservation can recover its hold, but malformed ownership or bootstrap ACK is unknown", async () => withClock(async () => {
  const value = request(), token = "a".repeat(32);
  const recovered = await reserveResendFallback(value, { async pipeline() { return [["already_reserved", token, "1", String(start), String(reset), String(now + 60_000)]]; } });
  assert.equal(recovered.status, "already_reserved");
  for (const reply of [[], [["initialized"], ["initialized"]], [["initialized", "extra"]], ["OK"]]) {
    assert.deepEqual(await initializeResendFallbackBudget({ review: review(), usage: usage() }, { async pipeline() { return reply; } }), { status: "unknown" });
  }
  assert.deepEqual(await initializeResendFallbackBudget({ review: review(), usage: usage() }, { async pipeline() { return [["initialized"]]; } }), { status: "initialized" });
  assert.deepEqual(await reserveResendFallback(value, { async pipeline() { return [["reserved", token, "1", String(start), String(reset), String(now + 60_000)]]; } }), { status: "unknown" });
}));
