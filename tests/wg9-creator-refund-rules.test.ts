/**
 * 649 [WG9], unit 1: the rules of a refund the creator gives from the buyer's
 * record, pure (lib/creator-refund-rules.ts). Checked: only the role with the
 * payments permission may refund; what can still be refunded is read off the
 * charge on the creator's Stripe account, and anything unreadable is unknown,
 * never zero and never the whole charge; the typed amount, whole or partial,
 * is read the way prices are read (lib/money.ts readMoney) and never above
 * what is left; the reason is one Stripe takes; one idempotency key per
 * action, so two clicks of the same form give back once; and Stripe's answer
 * is "done" only when it is the refund asked for and succeeded.
 */
import { readFileSync } from "node:fs";
import {
  REFUND_REASONS,
  canRefund,
  refundAmount,
  refundIdempotencyKey,
  refundOutcome,
  refundableOf,
  parseRefundReason,
} from "@/lib/creator-refund-rules";
import { done, is, part } from "./check";

const charge = (over: Record<string, unknown> = {}) => ({ id: "ch_1", object: "charge", status: "succeeded", paid: true, amount: 5_000, amount_captured: 5_000, captured: true, amount_refunded: 0, currency: "usd", disputed: false, refunded: false, ...over });

part("Who may refund: only the role with the payments permission");
is("the owner may; admin, editor and support may not", [canRefund("owner"), canRefund("admin"), canRefund("editor"), canRefund("support")], [true, false, false, false]);
is("a role we do not have may not", canRefund("manager" as never), false);
is("it is the team's own payments permission, not a list of its own", /can\(role, "payments"\)/.test(readFileSync("lib/creator-refund-rules.ts", "utf8")), true);

part("What can still be refunded, read off the charge");
is("a paid charge with nothing refunded: all of it", refundableOf(charge()), { ok: true, chargeId: "ch_1", currency: "usd", amountCents: 5_000, refundedCents: 0, refundableCents: 5_000 });
is("part refunded already: only the rest", refundableOf(charge({ amount_refunded: 1_200 })), { ok: true, chargeId: "ch_1", currency: "usd", amountCents: 5_000, refundedCents: 1_200, refundableCents: 3_800 });
is("refunded in full already: nothing left, said as such", refundableOf(charge({ amount_refunded: 5_000, refunded: true })), { ok: false, reason: "fully_refunded" });
is("a disputed charge is defended or lost, never refunded here", refundableOf(charge({ disputed: true })), { ok: false, reason: "disputed" });
is("not paid (pending, failed): nothing to refund yet", [refundableOf(charge({ status: "pending" })), refundableOf(charge({ status: "failed", paid: false }))], [{ ok: false, reason: "not_paid" }, { ok: false, reason: "not_paid" }]);
const unreadable = { ok: false, reason: "unreadable" };
is("an amount or a refunded amount we cannot read: unknown, never zero", [refundableOf(charge({ amount: "5000" })), refundableOf(charge({ amount_refunded: null })), refundableOf(charge({ amount_refunded: -1 })), refundableOf(charge({ amount: 50.5 }))], [unreadable, unreadable, unreadable, unreadable]);
is("more refunded than charged: unknown, never a negative or the whole charge", refundableOf(charge({ amount_refunded: 6_000 })), unreadable);
is("a hold only authorized, never captured: not paid, nothing to refund (Claude 6 on #3634)", refundableOf(charge({ captured: false, amount_captured: 0 })), { ok: false, reason: "not_paid" });
is("a hold captured in part: unknown, never the whole authorized amount", refundableOf(charge({ amount_captured: 3_000 })), unreadable);
is("captured not said, or not a boolean: unknown", [refundableOf(charge({ captured: undefined })), refundableOf(charge({ captured: "true" }))], [unreadable, unreadable]);
is("an amount captured we cannot read: unknown", [refundableOf(charge({ amount_captured: undefined })), refundableOf(charge({ amount_captured: 50.5 })), refundableOf(charge({ amount_captured: -1 }))], [unreadable, unreadable, unreadable]);
is("no currency, a disputed flag we cannot read, or a paid flag that says otherwise: unknown", [refundableOf(charge({ currency: "" })), refundableOf(charge({ disputed: "no" })), refundableOf(charge({ paid: false }))], [unreadable, unreadable, unreadable]);
is("not a charge, no id, a bare id: unknown", [refundableOf(null), refundableOf("ch_1"), refundableOf({ ...charge(), object: "payment_intent" }), refundableOf({ ...charge(), id: "" })], [unreadable, unreadable, unreadable, unreadable]);

part("The amount to give back: all that is left, or a typed part of it");
const left = refundableOf(charge({ amount_refunded: 1_200 }));
if (!left.ok) throw new Error("the charge above reads");
is("all: exactly what is left", refundAmount({ full: true, typed: "" }, left), { ok: true, cents: 3_800 });
is("a typed part, read as a price is read", [refundAmount({ full: false, typed: "12.5" }, left), refundAmount({ full: false, typed: " 38 " }, left)], [{ ok: true, cents: 1_250 }, { ok: true, cents: 3_800 }]);
is("more than is left: refused, never cut down to fit", refundAmount({ full: false, typed: "38.01" }, left), { ok: false, reason: "over_refundable" });
is("nothing typed, zero, or not one plain amount: refused", [refundAmount({ full: false, typed: "" }, left), refundAmount({ full: false, typed: "0" }, left), refundAmount({ full: false, typed: "$12" }, left), refundAmount({ full: false, typed: "1,200" }, left), refundAmount({ full: false, typed: "12.345" }, left), refundAmount({ full: false, typed: "-5" }, left)], [{ ok: false, reason: "empty" }, { ok: false, reason: "zero" }, { ok: false, reason: "not_an_amount" }, { ok: false, reason: "not_an_amount" }, { ok: false, reason: "not_an_amount" }, { ok: false, reason: "not_an_amount" }]);
const yen = refundableOf(charge({ currency: "jpy", amount: 2_700, amount_captured: 2_700 }));
if (!yen.ok) throw new Error("the yen charge reads");
is("a zero-decimal currency is typed whole", [refundAmount({ full: false, typed: "1000" }, yen), refundAmount({ full: false, typed: "10.5" }, yen)], [{ ok: true, cents: 1_000 }, { ok: false, reason: "not_an_amount" }]);
const other = refundableOf(charge({ currency: "xof", amount: 2_700, amount_captured: 2_700 }));
if (!other.ok) throw new Error("a currency off the list still reads");
is("a currency we do not price in: only all of it, never a typed part read as dollars", [refundAmount({ full: false, typed: "10" }, other), refundAmount({ full: true, typed: "" }, other)], [{ ok: false, reason: "currency_not_listed" }, { ok: true, cents: 2_700 }]);

part("The reason is one Stripe takes, or none is sent");
is("Stripe's three reasons", REFUND_REASONS, ["requested_by_customer", "duplicate", "fraudulent"]);
is("each reads back; anything else does not", [parseRefundReason("duplicate"), parseRefundReason("requested_by_customer"), parseRefundReason("Duplicate"), parseRefundReason("expired_uncaptured_charge"), parseRefundReason(undefined)], ["duplicate", "requested_by_customer", null, null, null]);

part("One key per action: two clicks of the same form give back once");
const A = "a".repeat(32);
is("the same action on the same charge: the same key", refundIdempotencyKey("st1", "ch_1", A) === refundIdempotencyKey("st1", "ch_1", A), true);
is("another action (a new form drawn after the first refund): another key", refundIdempotencyKey("st1", "ch_1", "b".repeat(32)) === refundIdempotencyKey("st1", "ch_1", A), false);
is("the key names the store, the charge and the action, within Stripe's 255 characters", [refundIdempotencyKey("st1", "ch_1", A), (refundIdempotencyKey("st1", "ch_1", A) ?? "").length <= 255], [`mm:refund:st1:ch_1:${A}`, true]);
is("no key without a real action token, or with ids we do not make", [refundIdempotencyKey("st1", "ch_1", "short"), refundIdempotencyKey("st1", "ch_1", "z".repeat(32)), refundIdempotencyKey("st 1", "ch_1", A), refundIdempotencyKey("st1", "ch:1", A), refundIdempotencyKey("st1", "", A)], [null, null, null, null, null]);

part("Stripe's answer: done only when it is this refund and it succeeded");
const asked = { chargeId: "ch_1", cents: 1_250, currency: "usd" };
const refund = (over: Record<string, unknown> = {}) => ({ id: "re_1", object: "refund", charge: "ch_1", amount: 1_250, currency: "usd", status: "succeeded", ...over });
is("succeeded, for this charge and this amount: done", refundOutcome(refund(), asked), "done");
is("the charge expanded as an object reads the same", refundOutcome(refund({ charge: { id: "ch_1", object: "charge" } }), asked), "done");
is("pending or waiting on an action: pending, not done", [refundOutcome(refund({ status: "pending" }), asked), refundOutcome(refund({ status: "requires_action" }), asked)], ["pending", "pending"]);
is("failed or canceled: failed", [refundOutcome(refund({ status: "failed" }), asked), refundOutcome(refund({ status: "canceled" }), asked)], ["failed", "failed"]);
is("another amount, another charge, a status Stripe does not send: unknown, never done", [refundOutcome(refund({ amount: 1_200 }), asked), refundOutcome(refund({ charge: "ch_2" }), asked), refundOutcome(refund({ status: "ok" }), asked)], ["unknown", "unknown", "unknown"]);
is("a currency missing, null, not text or not the charge's: unknown, never done (Codex Cloud 1 on #3634)", [refundOutcome(refund({ currency: undefined }), asked), refundOutcome(refund({ currency: null }), asked), refundOutcome(refund({ currency: 840 }), asked), refundOutcome(refund({ currency: "eur" }), asked), refundOutcome(refund({ currency: "USD" }), asked)], ["unknown", "unknown", "unknown", "unknown", "unknown"]);
is("pending or failed in another currency: unknown too", [refundOutcome(refund({ currency: "eur", status: "pending" }), asked), refundOutcome(refund({ currency: "eur", status: "failed" }), asked)], ["unknown", "unknown"]);
is("no answer, an error body, not a refund: unknown", [refundOutcome(null, asked), refundOutcome({ error: { type: "api_error" } }, asked), refundOutcome({ ...refund(), object: "charge" }, asked), refundOutcome({ ...refund(), id: "" }, asked)], ["unknown", "unknown", "unknown", "unknown"]);

part("Pure: no Stripe call, no Redis, no email");
const source = readFileSync("lib/creator-refund-rules.ts", "utf8");
is("nothing here reaches outside", /onAccount|stripeFetch|@\/lib\/redis|fetch\(|sendEmail|@\/lib\/mail/.test(source), false);

done();
