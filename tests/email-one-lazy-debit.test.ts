/**
 * The merge of main into #3667 (coordinator's decision 20261122T194608Z-claude-1-coord-c7bd): lib/email.ts takes a
 * store's email figure once, lazily, right before a provider is posted (the PR's design), and gives back what a batch
 * that sent nothing took into the window it was taken from (main's, Codex N1's LOW 2 on #3926). Three guarantees:
 *  1. the figure is taken before any provider cost: at the moment of the SES POST it is already counted;
 *  2. a single email that Amazon refuses, before or after a POST, and that then goes through Resend is counted once;
 *  3. a list batch whose figure was taken before its billing window ended, and that Amazon then throttled, gives the
 *     email back into that window, never into the new one.
 * Synthetic only: the SES mail fixture, the Redis stub, a store record built here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { sendBatch, sendEmailOutcome, sendListBatch } from "@/lib/email";
import { allowanceUsed } from "@/lib/store-allowance";
import { allowanceWindow } from "@/lib/allowance-window";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { createResendFallbackFixture } from "./resend-fallback-fixture";

process.env.RESEND_API_KEY = "re_SYNTHETIC_TRANSPORT_ONLY";
globalThis.fetch = async () => { throw Error("No external service is allowed in this proof"); };

const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;

const shop = (period = paidPeriod()) => ({ sid: "b".repeat(32), handle: "lazy-debit", statsId: null, tier: "creator" as const, subscriptionActive: true,
  subscriptionId: "sub_LazyDebit000001", trialEnds: 0, planEndedAt: "", cycle: "month" as const, period });
const accepted: typeof fetch = async () => Response.json({ id: "synthetic_accepted" });
/** Resend through the real guarded fallback transport, its account and quota synthetic. */
const resendFallback = () => createResendFallbackFixture({ credential: process.env.RESEND_API_KEY as string, cap: 10, fetch: accepted });
const resendPosts = (f: Awaited<ReturnType<typeof createResendFallbackFixture>>) => f.requests.filter(r => r.method === "POST").length;
const letter = (to: string) => ({ from: "Shop <shop@example.test>", to, subject: "Hello", text: "Body", html: "<p>Body</p>" });

test("the store's figure is taken before the SES POST, once per email, for a single email and for a batch", async () => {
  redis.clear();
  const store = shop();
  const seenAtPost: number[] = [];
  // Reads the store's count at the POST, then answers as Amazon accepting it.
  const mail = installSesMailFixture({ onSes: async () => {
    seenAtPost.push(await allowanceUsed(store, "email"));
    return Response.json({ MessageId: `ses_peek_${seenAtPost.length}` });
  } });
  try {
    mail.configure(); await mail.setReady(true);
    const one = await sendEmailOutcome({ ...letter("one@example.test"), meter: { by: "store", store, kind: "email" } });
    assert.equal(one, "sent");
    assert.deepEqual(seenAtPost, [1], "counted before Amazon was asked, never after");
    const batch = await sendBatch([letter("two@example.test"), letter("three@example.test")], "LAZY_DEBIT_BATCH", { by: "store", store, kind: "email" });
    assert.equal(batch, "sent");
    assert.equal(seenAtPost[1], 3, "the batch's two emails were counted before its first POST");
    assert.equal(await allowanceUsed(store, "email"), 3, "three emails, three counted");
  } finally { mail.restore(); }
});

test("a single email Amazon cannot take before a POST goes through Resend and is counted once", async () => {
  redis.clear();
  const store = shop();
  const mail = installSesMailFixture();
  try {
    mail.configure(); await mail.setReady(false);
    const resend = await resendFallback();
    const outcome = await sendEmailOutcome({ ...letter("fallback@example.test"), meter: { by: "store", store, kind: "email" } }, resend.runtime);
    assert.deepEqual({ outcome, ses: mail.calls.ses, resend: resendPosts(resend) }, { outcome: "sent", ses: 0, resend: 1 });
    assert.equal(await allowanceUsed(store, "email"), 1, "Resend's post counts it, once");
  } finally { mail.restore(); }
});

test("a single email Amazon refuses after its POST goes through Resend and is still counted once", async () => {
  redis.clear();
  const store = shop();
  const mail = installSesMailFixture();
  try {
    mail.configure(); await mail.setReady(true); mail.setSesOutcome("refused");
    const resend = await resendFallback();
    const outcome = await sendEmailOutcome({ ...letter("refused@example.test"), meter: { by: "store", store, kind: "email" } }, resend.runtime);
    assert.deepEqual({ outcome, ses: mail.calls.ses, resend: resendPosts(resend) }, { outcome: "sent", ses: 1, resend: 1 });
    assert.equal(await allowanceUsed(store, "email"), 1, "the debit taken before Amazon's POST covers Resend's: never twice");
  } finally { mail.restore(); }
});

test("a list batch taken before its window ended and throttled after it gives the email back into that window", async () => {
  redis.clear();
  shift = 0;
  const at = Math.floor(Date.now() / 1000);
  // A billing month that ends a minute from now, renewing.
  const store = shop({ start: at - 29 * 86_400, end: at + 60, renews: true });
  const before = allowanceWindow(store, Date.now()), after = allowanceWindow(store, Date.now() + 120_000);
  assert.ok(before && after && before.id !== after.id, "a window rollover to test");
  const takenAtPost: number[] = [];
  const mail = installSesMailFixture({ onSes: async () => {
    takenAtPost.push(await allowanceUsed(store, "email"));
    shift += 120_000; // Amazon answers after the window's end.
    return new Response(JSON.stringify({ message: "Maximum sending rate exceeded." }), { status: 429, headers: { "x-amzn-errortype": "TooManyRequestsException" } });
  } });
  try {
    mail.configure(); await mail.setReady(true);
    const outcome = await sendListBatch([letter("reader@example.test")], "list:lazy-window-cross", { by: "store", store, kind: "email" });
    assert.equal(outcome, "waiting", "Amazon throttled it and took nobody");
    assert.deepEqual(takenAtPost, [1], "the email was taken from the old window before the POST");
    assert.equal(await allowanceUsed(store, "email", realNow()), 0, "the window it was taken from has it back");
    assert.equal(await allowanceUsed(store, "email", Date.now()), 0, "the new window is not handed an email it never had");
  } finally {
    mail.restore();
    shift = 0;
  }
});
