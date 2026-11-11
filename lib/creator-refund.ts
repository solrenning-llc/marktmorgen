/**
 * 649 [WG9], unit 2: the refund the creator gives from the buyer's record in
 * the studio (app/api/store/person-refund/route.ts), on the creator's own
 * Stripe account. The rules are lib/creator-refund-rules.ts; this does them
 * in order, and asks Stripe to give money back only after every one passed:
 *
 *   1. only a role with the payments permission (today the owner alone);
 *   2. the store has its Stripe account;
 *   3. the form's token makes the action's idempotency key, and the reason
 *      is one Stripe takes (or none);
 *   4. the charge is read on the creator's account and must be a sale of
 *      this store: its payment carries one of the store's handles (the
 *      checkout writes it, lib/store-checkout.ts and lib/cart-checkout.ts).
 *      A charge of another store on the same account, or one without that
 *      mark (a membership's invoice, for now), is not found;
 *   5. what is left to refund is read off the charge, and the amount asked,
 *      all or a typed part, is checked against it;
 *   6. one refund is asked of Stripe, under the action's key: Stripe answers
 *      a repeat of the same key with the first refund (two clicks of the same
 *      form, at once or later, give back once) and a key still being worked
 *      on with 409, said here as "in_progress". The same key with other
 *      figures, or any other refusal Stripe answers with a 4xx, made nothing
 *      and writes no line ("invalid", "stripe_refused");
 *   7. the answer is read exactly (refundOutcome): "done" only for a refund
 *      of this charge, for this amount, that succeeded. One that cannot be
 *      read, or no answer at all, is "unknown" and never recorded as done:
 *      the creator is told to check the payment in Stripe, and sending the
 *      same form again is safe under the same key;
 *   8. one line in the team's activity log (lib/team.ts logTeam): who, the
 *      amount, the payment and what Stripe said. Never the buyer's address.
 *      A mark per refund told (per idempotency key when the answer could not
 *      be read), kept TOLD_DAYS, past the 24 hours Stripe keeps a key, so a
 *      repeat never writes the line twice; a mark whose answer is unknown
 *      writes the line anyway, since a missing record is worse than a
 *      repeated one.
 *
 * Closing what was bought needs nothing here: every door reads the payment
 * from Stripe and closes on a full refund by the one rule of lib/refunds.ts.
 *
 * Cost: one studio request (counted by guardStoreWrite before any of this),
 * at most two Stripe calls on the creator's account (no fee to Marktmorgen),
 * and three Redis commands (the mark, and the log's LPUSH and LTRIM).
 */
import { createHash } from "node:crypto";
import { onAccount, StripeError } from "@/lib/stripe-account";
import { saleHandles, type Store } from "@/lib/store";
import { claimMark } from "@/lib/claim-mark";
import { logTeam } from "@/lib/team";
import type { Role } from "@/lib/team-roles";
import { formatMoney } from "@/lib/money";
import {
  canRefund,
  parseRefundReason,
  refundAmount,
  refundIdempotencyKey,
  refundOutcome,
  refundableOf,
} from "@/lib/creator-refund-rules";

/** How long a refund told in the log stays marked: past the 24 hours Stripe keeps an idempotency key. */
export const TOLD_DAYS = 2;
const toldKey = (id: string) => `nl:crefund:told:${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;

export type RefundError =
  | "forbidden"
  | "no_stripe"
  | "invalid"
  | "not_found"
  | "unavailable"
  | "unreadable"
  | "not_paid"
  | "disputed"
  | "fully_refunded"
  | "empty"
  | "zero"
  | "not_an_amount"
  | "over_refundable"
  | "currency_not_listed"
  | "in_progress"
  | "stripe_refused"
  | "unknown";

export type RefundAnswer =
  | { ok: true; state: "done" | "pending" | "failed"; cents: number; currency: string }
  | { ok: false; error: RefundError };

/** The HTTP status each answer goes back with. */
export function refundStatus(answer: RefundAnswer): number {
  if (answer.ok) return 200;
  switch (answer.error) {
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "no_stripe":
    case "not_paid":
    case "disputed":
    case "fully_refunded":
    case "in_progress":
    case "stripe_refused":
      return 409;
    case "unavailable":
    case "unreadable":
      return 503;
    case "unknown":
      return 502;
    default:
      return 400;
  }
}

const fail = (error: RefundError): RefundAnswer => ({ ok: false, error });

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Whether a charge is a sale of this store: its payment carries one of the store's handles. */
function ofThisStore(store: Store, charge: Record<string, unknown>): boolean {
  const intent = record(charge.payment_intent);
  if (!intent || intent.object !== "payment_intent") return false;
  const handle = record(intent.metadata)?.store;
  return typeof handle === "string" && handle !== "" && saleHandles(store).has(handle);
}

export async function giveRefund(
  store: Store,
  who: { email: string; role: Role },
  input: { charge?: unknown; token?: unknown; full?: unknown; amount?: unknown; reason?: unknown },
): Promise<RefundAnswer> {
  if (!canRefund(who.role)) return fail("forbidden");
  const account = store.stripeAccountId;
  if (!account) return fail("no_stripe");
  const chargeId = typeof input.charge === "string" ? input.charge : "";
  const key = refundIdempotencyKey(store.sid ?? "", chargeId, typeof input.token === "string" ? input.token : "");
  if (!key) return fail("invalid");
  const reason = input.reason === undefined || input.reason === "" ? null : parseRefundReason(input.reason);
  if (input.reason !== undefined && input.reason !== "" && !reason) return fail("invalid");

  let charge: Record<string, unknown>;
  try {
    charge = await onAccount("GET", account, `/charges/${encodeURIComponent(chargeId)}?expand[]=payment_intent`);
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) return fail("not_found");
    console.error("reading a charge to refund failed", error);
    return fail("unavailable");
  }
  if (!ofThisStore(store, charge)) return fail("not_found");
  const left = refundableOf(charge);
  if (!left.ok) return fail(left.reason);
  const amount = refundAmount({ full: input.full === true, typed: typeof input.amount === "string" ? input.amount : "" }, left);
  if (!amount.ok) return fail(amount.reason);

  const body = new URLSearchParams({ charge: chargeId, amount: String(amount.cents), "metadata[studio_refund]": "1", "metadata[by_role]": who.role });
  if (reason) body.set("reason", reason);
  let reply: unknown;
  try {
    reply = await onAccount("POST", account, "/refunds", body, undefined, key);
  } catch (error) {
    if (error instanceof StripeError) {
      if (error.status === 409 || error.code === "idempotency_key_in_use") return fail("in_progress");
      if (error.code === "charge_disputed" || error.code === "refund_disputed_payment") return fail("disputed");
      if (error.code === "charge_already_refunded") return fail("fully_refunded");
      if (error.code === "amount_too_large") return fail("over_refundable");
      // The same form's key sent with other figures: Stripe refuses it before doing anything (the first refund stands).
      if (error.code === "idempotency_error") return fail("invalid");
      // Any other refusal Stripe gives as a 4xx made nothing: said as refused, never as made or unknown.
      if (error.status >= 400 && error.status < 500) return fail("stripe_refused");
    }
    // Sent, and no answer that says what happened: unknown, never done.
    console.error("a studio refund's answer could not be read", error);
    reply = null;
  }

  const state = refundOutcome(reply, { chargeId, cents: amount.cents });
  const money = formatMoney(amount.cents, left.currency);
  const what =
    state === "done"
      ? `Refunded ${money} on payment ${chargeId}`
      : state === "pending"
        ? `Refund of ${money} on payment ${chargeId} waiting at Stripe`
        : state === "failed"
          ? `Refund of ${money} on payment ${chargeId} refused by Stripe`
          : `Sent a refund of ${money} on payment ${chargeId}; Stripe's answer could not be read`;
  const toldFor = state === "unknown" ? key : String((record(reply) ?? {}).id);
  if ((await claimMark(toldKey(toldFor), TOLD_DAYS * 86_400)) !== "taken" && store.sid) {
    await logTeam(store.sid, { who: who.email, role: who.role, what });
  }
  if (state === "unknown") return fail("unknown");
  return { ok: true, state, cents: amount.cents, currency: left.currency };
}
