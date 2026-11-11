/**
 * Telling a buyer, once per payment, that a payment their plan took after its agreed end was refunded and that the
 * plan has ended (the owner's decision of 9 November 2026, item 12: "A data foi prometida ao comprador."; the
 * coordinator's follow-up on #3367).
 *
 * The daily plans job (lib/plans.ts) refunds such payments (lib/plan-late-refunds.ts) and hands here the ones given
 * back in full. Each is told once, to the address Stripe holds on its invoice, in the store's language, from the
 * store's name, taken from the store's transactional figure before it is sent (lib/email.ts, EmailMeter "store"), as
 * the other emails that hand a buyer what is theirs are (a link to their purchases, a withdrawal's acknowledgement).
 * That figure is inside every plan's worst month already, so this adds no cost of its own beyond its few commands;
 * a store whose figure is spent has the email tried again on the next days' passes, at most LATE_TELL_TRIES times.
 *
 *   nl:plans:late-told:<invoice>  one small hash a late payment: `claim` (the email went, is going, or was given up)
 *                                 and `tries`; no name, no address. Written with HSETNX, HINCRBY and EXPIRE, gone by
 *                                 itself LATE_TELL_KEEP_DAYS after its last try.
 *
 * Never twice: the claim is taken (HSETNX) before the email goes and given back (HDEL) only when it could not be
 * sent; a payment older than LATE_TELL_WITHIN_DAYS is never told, so a claim that has expired cannot be taken again.
 * Bounded: one read of every payment's claim (at most the list's 100), then at most LATE_TELLS_PER_TRY emails a try
 * (PLAN_SETTLE_RUN.lateTellCommandsPerPlan in tests/plan-cost-registry.ts); the rest wait for the next pass.
 */
import { createHash } from "node:crypto";
import { EMAIL_PATTERN, normaliseEmail } from "@/lib/auth";
import { isSenderConfigured, sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { storeForId } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { fromStore, storeBase } from "@/lib/purchase-email";
import { speechFor } from "@/lib/buyer-words";
import { planLateRefundWords } from "@/lib/buyer-words/plan-late-refund";
import type { Given } from "@/lib/plan-late-refunds";

/** Buyer emails one try sends at the most; more wait for the next pass. */
export const LATE_TELLS_PER_TRY = 3;
/** Times one payment's email is tried before it is given up (and logged): a week of daily passes. */
export const LATE_TELL_TRIES = 7;
/** Days a payment's claim is kept after its last try. */
export const LATE_TELL_KEEP_DAYS = 400;
/** Payments taken longer ago than this are never told, so an expired claim is never taken again. */
export const LATE_TELL_WITHIN_DAYS = 365;
const DAY = 86_400;

export const lateToldKey = (invoice: string): string => `nl:plans:late-told:${invoice}`;

/**
 * Emails each buyer of `given` not told yet. `untold` counts the payments still to tell (an email not sent now, or
 * more than one try sends), so the plan is tried again; a store that is gone, an address that does not read and a
 * payment given up after LATE_TELL_TRIES are final, and logged.
 */
export async function tellLateRefunds(about: { sid: string; product: string }, end: number, given: Given[], now = Math.floor(Date.now() / 1000)): Promise<{ told: number; untold: number }> {
  const out = { told: 0, untold: 0 };
  if (!isRedisConfigured()) return out;
  const due = given.filter((paid) => {
    if (paid.paidAt < now - LATE_TELL_WITHIN_DAYS * DAY) return false;
    if (!paid.email || !EMAIL_PATTERN.test(paid.email.trim())) {
      console.error("a plan's late payment was refunded, but its invoice holds no address to tell its buyer", paid.invoice);
      return false;
    }
    return true;
  });
  if (!due.length) return out;
  // One read of every claim: a payment told before costs one command, never an email.
  const read = repliesFor(await redisPipeline(due.map((paid) => ["HEXISTS", lateToldKey(paid.invoice), "claim"])), due.length);
  if (!read) {
    out.untold = due.length;
    return out;
  }
  // Exactly 0: not told; exactly 1: told. Any other reply is not known, so that payment is untold and tried again on the
  // next pass, never taken as told (Claude 1's LOW on #3367; CX-123 rule 24).
  const claims = read.map((reply) => countOf(reply));
  out.untold += claims.filter((claim) => claim === null || claim > 1).length;
  const open = due.filter((_, i) => claims[i] === 0);
  if (!open.length) return out;
  const store = about.sid ? await storeForId(about.sid) : null;
  if (!store) {
    console.error("a plan's late payment was refunded, but there is no store to tell its buyer from", open.map((paid) => paid.invoice).join(","));
    return out;
  }
  if (!isSenderConfigured()) {
    out.untold += open.length;
    return out;
  }
  const listing = about.product ? await readListing(store, about.product).catch(() => null) : null;
  const words = planLateRefundWords(store.language);
  for (const [i, paid] of open.entries()) {
    if (i >= LATE_TELLS_PER_TRY) {
      out.untold += open.length - i;
      break;
    }
    const key = lateToldKey(paid.invoice);
    const taken = repliesFor(await redisPipeline([["HSETNX", key, "claim", "1"], ["HINCRBY", key, "tries", 1], ["EXPIRE", key, LATE_TELL_KEEP_DAYS * DAY]]).catch(() => null), 3);
    const claimed = taken ? countOf(taken[0]) : null;
    const tries = taken ? countOf(taken[1]) : null;
    if (claimed === null || tries === null) {
      out.untold += 1;
      continue;
    }
    // Taken by another pass (sent, or going now): never a second.
    if (claimed !== 1) continue;
    if (tries > LATE_TELL_TRIES) {
      console.error(`a plan's late refund could not be told to its buyer in ${LATE_TELL_TRIES} tries; given up`, paid.invoice);
      continue;
    }
    const say = speechFor(store.language, paid.currency);
    const text = words.lines({
      store: store.name,
      product: listing?.title ?? null,
      amount: say.money(paid.amount),
      paidOn: say.date(paid.paidAt * 1000),
      endedOn: say.date(end * 1000),
      link: storeBase(store),
    }).join("\n");
    const sent = await sendEmail({
      meter: { by: "store", store, kind: "transactional" },
      from: fromStore(store),
      to: normaliseEmail(paid.email as string),
      subject: words.subject(store.name).slice(0, 180),
      text,
      idempotencyKey: `plan-late-told:${createHash("sha256").update(paid.invoice).digest("hex").slice(0, 32)}`,
    }).catch(() => false);
    if (sent) {
      out.told += 1;
      continue;
    }
    // Not sent: the claim is given back, so the next pass tries again (its tries counted).
    await redisPipeline([["HDEL", key, "claim"]]).catch((error: unknown) => console.error("giving back a late refund's email claim failed", error));
    out.untold += 1;
  }
  return out;
}
