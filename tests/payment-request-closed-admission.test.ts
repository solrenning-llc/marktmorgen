import test from "node:test";
import assert from "node:assert/strict";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readDraft, statusOf, REMIND_EVERY_DAYS } from "@/lib/payment-request-rules";
import { createRequest, changeRequest, readRequest, dueReminders } from "@/lib/payment-request-store";
import { sendRequestEmail, remindNow, sendDueReminders, requestsOpen } from "@/lib/payment-requests";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { mail } from "./payment-request-closed-mail-world";
import { stripe } from "./payment-request-closed-stripe-world";

const real = redis.pipeline.bind(redis), realNow = Date.now;
const DAY = 86_400_000, marker = "nl:payreq:due";
type Mode = "paid" | "canceled" | "refunded" | "expired" | "open";
async function world(mode: Mode) {
  redis.clear(); mail.attempts = 0; mail.outcome = "sent"; stripe.calls = 0;
  const now = realNow();
  const owner = "request-owner@example.test";
  assert.equal((await claimHandle(owner, "request-closed-x5", "Synthetic", "")).ok, true);
  await ensureStatsId(owner); await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1ReqClosedX5001", true);
  await setSubscription(owner, { customerId: "cus_reqClosedX5001", subscriptionId: "sub_reqClosedX5001", active: true, tier: "scale", period: paidPeriod() });
  const shop = (await storeForEmail(owner))!;
  assert.equal(requestsOpen(shop), true, "the synthetic store passes the ordinary selling check");
  const created = now - (REMIND_EVERY_DAYS + 1) * DAY;
  const draft = readDraft({ email: "request-buyer@example.test", name: "Synthetic", lines: [{ text: "Synthetic service", quantity: 1, amount: "10" }], note: "", dueDate: "", autoReminders: 2, consent: true }, "usd", created);
  assert.ok(draft.ok);
  const made = await createRequest(shop, draft.draft, created); assert.ok(made.ok);
  await changeRequest(shop, made.request.id, current => ({ next: { ...current, sent: [created], ...(mode === "expired" ? { expiresAt: now + 1000 } : {}) }, answer: null }), now);
  const request = (await readRequest(made.request.id))!;
  assert.equal(statusOf(request, now), "open");
  mail.attempts = 0;
  return { shop, request, now, member: `${shop.sid}|${request.id}` };
}

for (const caller of ["direct", "manual", "daily"] as const) for (const mode of ["paid", "canceled", "refunded", "expired", "open"] as const) {
  test(`${caller}: a request closed before protected admission is never emailed (${mode})`, async () => {
    const w = await world(mode); let armed = true, clock = w.now, retryWrites = 0;
    Date.now = () => clock;
    redis.pipeline = async commands => {
      if (armed && commands.some(c => c[0] === "SET" && c[1] === `nl:payreq:w:${w.request.id}`)) {
        armed = false;
        if (mode === "expired") clock += 2000;
        else if (mode !== "open") await changeRequest(w.shop, w.request.id, current => ({ next: { ...current, state: mode, paidAt: mode === "paid" || mode === "refunded" ? w.now : 0, amountPaid: mode === "paid" || mode === "refunded" ? current.total : 0, refunded: mode === "refunded" ? current.total : 0, closedAt: w.now }, answer: null }), w.now);
      }
      if (commands.some(c => c[0] === "ZADD" && c[1] === marker && c[3] === w.member)) retryWrites++;
      return real(commands);
    };
    try {
      if (caller === "direct") {
        const out = await sendRequestEmail(w.shop, w.request, w.now);
        assert.equal(out.sent, mode === "open");
      } else if (caller === "manual") {
        const out = await remindNow(w.shop, w.request.id, w.now); assert.ok(out.ok);
        assert.equal(out.sent, mode === "open");
      } else {
        const out = await sendDueReminders(w.now + 10_000, w.now);
        assert.equal(out.sent, mode === "open" ? 1 : 0);
        assert.equal(retryWrites, 0, "a confirmed closed request gets no new deferred reminder");
        assert.equal((await real([["ZSCORE", marker, w.member]]))[0], mode === "open" ? String((await readRequest(w.request.id))!.sent[0] + 2 * REMIND_EVERY_DAYS * DAY) : null);
      }
      assert.equal(armed, false, "the transition preceded the actual protected admission");
      assert.equal(mail.attempts, mode === "open" ? 1 : 0);
      assert.equal(stripe.calls, 0);
      const current = (await readRequest(w.request.id))!;
      assert.equal(statusOf(current, clock), mode);
      assert.equal(current.sendingAt, undefined);
    } finally { redis.pipeline = real; Date.now = realNow; }
  });
}

test("a still-open refused reminder retains its one-day retry", async () => {
  const w = await world("open"); mail.outcome = "refused";
  const out = await sendDueReminders(realNow() + 10_000, w.now);
  assert.equal(out.sent, 0); assert.equal(mail.attempts, 1);
  assert.equal((await real([["ZSCORE", marker, w.member]]))[0], String(w.now + DAY));
  assert.equal((await dueReminders(w.now)).length, 0);
});

test("an open unresolved attempt is recorded once without another email", async () => {
  const w = await world("open");
  await changeRequest(w.shop, w.request.id, current => ({ next: { ...current, sendingAt: w.now - 1 }, answer: null }), w.now);
  const out = await sendRequestEmail(w.shop, w.request, w.now);
  assert.equal(out.sent, true); assert.equal(mail.attempts, 0);
  assert.deepEqual(out.request.sent, [w.request.sent[0], w.now - 1]);
});
