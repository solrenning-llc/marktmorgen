import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  APPLY_LINK_DAYS_DEFAULT, APPLY_LINK_DAYS_MAX, APPLY_LINK_DAYS_MIN, APPLY_TOKEN, APPLICATION_ID,
  type Application, applicantDigest, applyTokenDigest, canPurchase, newApplication, newApplyToken,
  nextApplication, parseApplication, purchaseWith,
} from "@/lib/apply-first-rules";

// Synthetic data only: example.invalid addresses, fixed clock.
const DAY = 86_400_000;
const now = 1_800_000_000_000;
const id = "a".repeat(32);
const offer = "prod_synthetic01";
const email = "Applicant@Example.invalid ";
const tokenA = "0123456789abcdef".repeat(3);
const tokenB = "fedcba9876543210".repeat(3);

function submitted(): Application {
  const made = newApplication({ id, offer, email, now });
  assert.ok(made);
  return made;
}
function approved(days = 7, token = tokenA, at = now + 1_000): Application {
  const step = nextApplication(submitted(), { kind: "approve", now: at, days, token });
  assert.equal(step.ok, true);
  return (step as { ok: true; next: Application }).next;
}

test("a token is random hex with no personal data, kept only as its digest", () => {
  const one = newApplyToken();
  const two = newApplyToken();
  assert.match(one, APPLY_TOKEN);
  assert.notEqual(one, two);
  assert.equal(applyTokenDigest(tokenA), createHash("sha256").update(`nimbus-apply-first-token:${tokenA}`).digest("hex"));
  const record = approved();
  const stored = JSON.stringify(record);
  assert.equal(stored.includes(tokenA), false, "the plain token is never kept");
  assert.equal(stored.toLowerCase().includes("applicant@example.invalid"), false, "the address is never kept in the record");
  for (const word of ["applicant", "example", "invalid", "@"]) assert.equal(tokenA.includes(word), false);
  // A token is never made from the address: two applications for the same address get unrelated tokens.
  assert.equal(APPLY_TOKEN.test("applicant@example.invalid"), false);
});

test("the applicant digest is the trimmed lower-case address, never the address itself", () => {
  assert.equal(applicantDigest(email), applicantDigest("applicant@example.invalid"));
  assert.notEqual(applicantDigest(email), applicantDigest("other@example.invalid"));
  assert.match(applicantDigest(email) ?? "", /^[0-9a-f]{64}$/);
  for (const bad of ["", "   ", "no-at-sign", "a@b", "x".repeat(250) + "@example.invalid", 7, null, undefined]) {
    assert.equal(applicantDigest(bad as unknown as string), null, String(bad));
  }
});

test("a new application starts submitted, and a malformed one is not made", () => {
  const made = submitted();
  assert.equal(made.state, "submitted");
  assert.equal(made.at, now);
  assert.equal(made.tokenDigest, "");
  assert.equal(made.expiresAt, 0);
  assert.equal(newApplication({ id: "nope", offer, email, now }), null);
  assert.equal(newApplication({ id, offer: "", email, now }), null);
  assert.equal(newApplication({ id, offer, email: "bad", now }), null);
  assert.equal(newApplication({ id, offer, email, now: Number.NaN }), null);
  assert.equal(APPLICATION_ID.test(id), true);
});

test("transitions: submitted to approved or declined; approved to used or declined; declined and used are final", () => {
  const app = submitted();
  const yes = nextApplication(app, { kind: "approve", now: now + 1, days: 7, token: tokenA });
  assert.equal(yes.ok, true);
  const no = nextApplication(app, { kind: "decline", now: now + 1 });
  assert.equal(no.ok && no.next.state, "declined");
  const ok = approved();
  assert.equal(ok.state, "approved");
  assert.equal(ok.expiresAt, now + 1_000 + 7 * DAY);
  assert.equal(ok.tokenDigest, applyTokenDigest(tokenA));
  const revoked = nextApplication(ok, { kind: "decline", now: now + 2_000 });
  assert.equal(revoked.ok && revoked.next.state, "declined");
  assert.equal(revoked.ok && revoked.next.tokenDigest, "", "a revoked link no longer opens anything");
  const declined = (no as { ok: true; next: Application }).next;
  for (const step of [
    { kind: "approve", now: now + 3, days: 7, token: tokenB },
    { kind: "decline", now: now + 3 },
  ] as const) assert.deepEqual(nextApplication(declined, step), { ok: false, why: "final" });
  const used = purchaseWith(ok, { token: tokenA, email, offer, now: now + 2 * DAY });
  assert.equal(used.ok, true);
  const spent = (used as { ok: true; next: Application }).next;
  assert.equal(spent.state, "used");
  assert.equal(spent.usedAt, now + 2 * DAY);
  assert.deepEqual(nextApplication(spent, { kind: "decline", now: now + 3 * DAY }), { ok: false, why: "final" });
  assert.deepEqual(nextApplication(spent, { kind: "approve", now: now + 3 * DAY, days: 7, token: tokenB }), { ok: false, why: "final" });
});

test("approving an approved application only renews a link that has expired, with a new token", () => {
  const ok = approved(1);
  assert.deepEqual(nextApplication(ok, { kind: "approve", now: now + 2_000, days: 7, token: tokenB }), { ok: false, why: "still-open" });
  const renewed = nextApplication(ok, { kind: "approve", now: now + 2 * DAY, days: 7, token: tokenB });
  assert.equal(renewed.ok, true);
  const next = (renewed as { ok: true; next: Application }).next;
  assert.equal(next.tokenDigest, applyTokenDigest(tokenB));
  assert.deepEqual(canPurchase(next, { token: tokenA, email, offer, now: now + 2 * DAY + 1 }), { ok: false, why: "wrong-token" });
  assert.deepEqual(nextApplication(ok, { kind: "approve", now: now + 2 * DAY, days: 7, token: tokenA }), { ok: false, why: "same-token" });
});

test("the creator's chosen expiry is a whole number of days within bounds", () => {
  assert.equal(APPLY_LINK_DAYS_DEFAULT, 7);
  for (const days of [0, APPLY_LINK_DAYS_MIN - 1, APPLY_LINK_DAYS_MAX + 1, 1.5, Number.NaN, Infinity, -3]) {
    assert.deepEqual(nextApplication(submitted(), { kind: "approve", now: now + 1, days, token: tokenA }), { ok: false, why: "bad-input" }, String(days));
  }
  for (const days of [APPLY_LINK_DAYS_MIN, APPLY_LINK_DAYS_MAX]) {
    assert.equal(nextApplication(submitted(), { kind: "approve", now: now + 1, days, token: tokenA }).ok, true);
  }
  for (const token of ["", "short", tokenA.toUpperCase(), tokenA + "0", 5]) {
    assert.deepEqual(nextApplication(submitted(), { kind: "approve", now: now + 1, days: 7, token: token as string }), { ok: false, why: "bad-input" });
  }
  assert.deepEqual(nextApplication(submitted(), { kind: "approve", now: now - 1, days: 7, token: tokenA }), { ok: false, why: "bad-input" }, "a decision before the application");
});

test("the approved link opens only for its own address, its own offer and before it expires", () => {
  const ok = approved(7);
  const at = now + 3 * DAY;
  assert.deepEqual(canPurchase(ok, { token: tokenA, email: "applicant@example.invalid", offer, now: at }), { ok: true });
  assert.deepEqual(canPurchase(ok, { token: tokenA, email: "other@example.invalid", offer, now: at }), { ok: false, why: "wrong-email" });
  assert.deepEqual(canPurchase(ok, { token: tokenB, email, offer, now: at }), { ok: false, why: "wrong-token" });
  assert.deepEqual(canPurchase(ok, { token: tokenA, email, offer: "prod_other00001", now: at }), { ok: false, why: "wrong-offer" });
  assert.deepEqual(canPurchase(ok, { token: tokenA, email, offer, now: ok.expiresAt }), { ok: false, why: "expired" }, "the expiry instant is already expired");
  assert.deepEqual(canPurchase(ok, { token: tokenA, email, offer, now: ok.expiresAt - 1 }), { ok: true });
  assert.deepEqual(purchaseWith(ok, { token: tokenA, email, offer, now: ok.expiresAt }), { ok: false, why: "expired" });
});

test("without approval there is no purchase, and a used link never opens again", () => {
  assert.deepEqual(canPurchase(submitted(), { token: tokenA, email, offer, now: now + 1 }), { ok: false, why: "not-approved" });
  const declined = (nextApplication(submitted(), { kind: "decline", now: now + 1 }) as { ok: true; next: Application }).next;
  assert.deepEqual(canPurchase(declined, { token: tokenA, email, offer, now: now + 2 }), { ok: false, why: "declined" });
  const ok = approved();
  const spent = (purchaseWith(ok, { token: tokenA, email, offer, now: now + DAY }) as { ok: true; next: Application }).next;
  assert.deepEqual(canPurchase(spent, { token: tokenA, email, offer, now: now + DAY + 1 }), { ok: false, why: "used" });
  assert.deepEqual(purchaseWith(spent, { token: tokenA, email, offer, now: now + DAY + 1 }), { ok: false, why: "used" });
});

test("rule 24: an unknown or malformed record, state or clock never allows the purchase", () => {
  const ok = approved();
  const good = JSON.stringify(ok);
  assert.deepEqual(parseApplication(good), ok);
  const unknowns: unknown[] = [
    null, undefined, "", "{bad", "[]", "null", 7,
    JSON.stringify({ ...ok, state: "maybe" }),
    JSON.stringify({ ...ok, state: "APPROVED" }),
    JSON.stringify({ ...ok, version: 2 }),
    JSON.stringify({ ...ok, id: "short" }),
    JSON.stringify({ ...ok, offer: "" }),
    JSON.stringify({ ...ok, applicant: "applicant@example.invalid" }),
    JSON.stringify({ ...ok, tokenDigest: "" }),
    JSON.stringify({ ...ok, tokenDigest: "z".repeat(64) }),
    JSON.stringify({ ...ok, expiresAt: "1800000000000" }),
    JSON.stringify({ ...ok, expiresAt: ok.decidedAt }),
    JSON.stringify({ ...ok, expiresAt: ok.decidedAt + (APPLY_LINK_DAYS_MAX * DAY) + 1 }),
    JSON.stringify({ ...ok, decidedAt: ok.at - 1 }),
    JSON.stringify({ ...ok, usedAt: now + 5 }),
    JSON.stringify({ ...ok, state: "used", usedAt: 0 }),
    JSON.stringify({ ...ok, state: "submitted" }),
    JSON.stringify({ ...ok, state: "declined" }),
    good.replace('"state":"approved"', '"state":"approved","state":"approved"'),
    "x".repeat(5_000),
  ];
  for (const raw of unknowns) {
    assert.equal(parseApplication(raw), null, String(raw).slice(0, 80));
  }
  for (const record of [null, undefined, { ...ok, state: "maybe" }, { ...ok, state: "used", usedAt: 0 }, "approved"] as unknown[]) {
    assert.deepEqual(canPurchase(record as Application, { token: tokenA, email, offer, now: now + DAY }), { ok: false, why: "unknown" });
    assert.deepEqual(purchaseWith(record as Application, { token: tokenA, email, offer, now: now + DAY }), { ok: false, why: "unknown" });
    assert.deepEqual(nextApplication(record as Application, { kind: "decline", now: now + DAY }), { ok: false, why: "unknown" });
  }
  for (const clock of [Number.NaN, Infinity, -1, 1.5, ok.decidedAt - 1]) {
    assert.deepEqual(canPurchase(ok, { token: tokenA, email, offer, now: clock }), { ok: false, why: "unknown" }, String(clock));
  }
  for (const typed of [null, undefined, "", "bad"]) {
    assert.deepEqual(canPurchase(ok, { token: tokenA, email: typed as unknown as string, offer, now: now + DAY }), { ok: false, why: "wrong-email" });
  }
  assert.deepEqual(canPurchase(ok, { token: 7 as unknown as string, email, offer, now: now + DAY }), { ok: false, why: "wrong-token" });
  // A parsed record carries only its known fields.
  const extra = parseApplication(JSON.stringify({ ...ok, note: "keep me" }));
  assert.deepEqual(extra, ok);
});
