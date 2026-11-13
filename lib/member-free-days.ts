/**
 * Free days given to one member (641 [WG1]; owner's Whop audit, "manage
 * users"): the creator puts off the next charge of one member's running
 * membership, as a courtesy or to make up for a problem. Everything happens
 * on the creator's own Stripe account (lib/stripe-account.ts, onAccount):
 * the membership's trial_end is set to its next charge plus the days, with no
 * proration (lib/member-free-days-rules.ts says why this and not a pause).
 * Marktmorgen takes nothing and charges nothing here. On a paid membership
 * the same request marks the new trial_end as free days, so nothing reads the
 * member as in a free trial (lib/member-free-days-rules.ts, freeDaysMarks).
 *
 * Read again on the server at the moment of giving, never taken from the
 * page: the member by their address, the membership among this store's
 * running ones of theirs (lib/member-discount.ts, memberSubRows), and its
 * next charge, which must be the one the creator was shown.
 *
 * Once, whatever the presses: a claim in Redis on the membership and the date
 * seen (SET NX, a day) lets one press through, and the Stripe call carries an
 * idempotency key from the membership, that date and the days. An answer from
 * Redis or Stripe that cannot be read is said as not known, and nothing is
 * recorded as done: no line in the activity log, no email. A date that has
 * moved since the creator saw it is refused, so a second press after the
 * first went through never adds the days again.
 *
 * Cost (MR): one studio request (the route's guard), the Stripe reads the
 * discount's own find makes and one write, all on the creator's account; two
 * Redis commands for the claim and the activity log's own two; and one email
 * to the member, taken from the store's own emails before it goes
 * (lib/email.ts, meter "store"/"email"), not sent when they are used up.
 */
import { onAccount, StripeError } from "@/lib/stripe-account";
import { memberSubRows } from "@/lib/member-discount";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { LockBusyError, withLock } from "@/lib/redis-lock";
import { logTeam } from "@/lib/team";
import type { Role } from "@/lib/team-roles";
import { sendEmail } from "@/lib/email";
import { fromCreator, storeBase } from "@/lib/purchase-email";
import { speech } from "@/lib/buyer-words";
import { freeDaysWords } from "@/lib/buyer-words/free-days";
import { readListings } from "@/lib/catalog";
import { forgetStatus } from "@/lib/membership-access";
import type { Store } from "@/lib/store";
import { type FreeDaysBlock, type FreeDaysSub, freeDaysMarks, freeDaysState, movedCharge, parseFreeDays } from "@/lib/member-free-days-rules";

/** The Stripe version lib/member-discount.ts reads memberships with, so a subscription reads the same here. */
const API_VERSION = "2025-09-30.clover";
const SUB_PATTERN = /^sub_[A-Za-z0-9]{6,64}$/;
/** How long a press holds a membership's date: longer than any answer, as long as Stripe keeps an idempotency key. */
const CLAIM_SECONDS = 86_400;

const claimKey = (store: Store, subscription: string, nextCharge: number) => `nl:free-days:${store.sid || store.handle}:${subscription}:${nextCharge}`;

/**
 * Every running membership of this store held under an address, with its next
 * charge; null when Stripe could not be reached, "unreadable" when it answered
 * in a shape that cannot be read whole (not known, never "none").
 */
export async function freeDaysSubs(store: Store, email: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<FreeDaysSub[] | "unreadable" | null> {
  const rows = await memberSubRows(store, email);
  if (rows === null || rows === "unreadable") return rows;
  return rows.map(({ row, raw }) => {
    const state = freeDaysState(raw, nowSeconds);
    return { id: row.id, product: row.product, amount: row.amount, currency: row.currency, interval: row.interval, nextCharge: state.nextCharge, blocked: state.blocked };
  });
}

export type GiveResult =
  | { ok: true; nextCharge: number; emailed: boolean }
  | { ok: false; reason: "days" | "not_member" | "changed" | "busy" | "refused" | "unknown" | "stripe" | "unavailable" }
  | { ok: false; reason: "blocked"; blocked: FreeDaysBlock };

/** The lock every change to a membership takes: a switch between plans or to yearly, a pause (lib/membership-pause.ts). */
const membershipLockKey = (subscription: string) => `nl:tier:${subscription}:lock`;
/** As lib/membership-pause.ts: longer than the reads and the change at their ceiling, with room; a press waits at most 5 s. */
const MEMBERSHIP_LOCK_SECONDS = 120;
const MEMBERSHIP_LOCK_WAIT_MS = 5_000;

/**
 * Gives `days` free days on one of the member's running memberships: its next
 * charge, `expected` as the creator was shown it, moves to `expected + days`.
 *
 * Under the membership's own lock, across the fresh read and the write (Codex V on #2912): a switch between plans that
 * read the membership as having no free days can never go on to charge after free days were given in between. A lock
 * held by another change answers "busy", and one that cannot be asked "unknown"; nothing is given either way.
 */
export async function giveFreeDays(
  store: Store,
  email: string,
  subscription: string,
  rawDays: unknown,
  expected: unknown,
  by: { who: string; role: Role },
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<GiveResult> {
  if (!SUB_PATTERN.test(subscription) || !isRedisConfigured()) return giveUnlocked(store, email, subscription, rawDays, expected, by, nowSeconds);
  try {
    // A write sent to Stripe and not confirmed keeps the lock a full term and lets it run out, as an unconfirmed switch
    // does (lib/tier-switch.ts, keepWhileUnconfirmed; Claude 4's LOW on #2912): a switch never reads the membership
    // while that update may still land.
    const sent = { maybe: false };
    return await withLock(
      membershipLockKey(subscription),
      MEMBERSHIP_LOCK_SECONDS,
      MEMBERSHIP_LOCK_WAIT_MS,
      () => giveUnlocked(store, email, subscription, rawDays, expected, by, nowSeconds, sent),
      (result) => sent.maybe && !result.ok && result.reason === "unknown",
    );
  } catch (error) {
    if (error instanceof LockBusyError) return { ok: false, reason: "busy" };
    console.error("giving a member free days could not take the membership's lock", error);
    return { ok: false, reason: "unknown" };
  }
}

async function giveUnlocked(
  store: Store,
  email: string,
  subscription: string,
  rawDays: unknown,
  expected: unknown,
  by: { who: string; role: Role },
  nowSeconds: number,
  /** Set once the write is sent to Stripe: an "unknown" after it may still land. */
  sent: { maybe: boolean } = { maybe: false },
): Promise<GiveResult> {
  const account = store.stripeAccountId;
  const days = parseFreeDays(rawDays);
  if (days === null) return { ok: false, reason: "days" };
  if (!account || !SUB_PATTERN.test(subscription) || typeof expected !== "number" || !Number.isSafeInteger(expected)) return { ok: false, reason: "not_member" };
  if (!isRedisConfigured()) return { ok: false, reason: "unknown" };

  const rows = await memberSubRows(store, email);
  if (rows === null) return { ok: false, reason: "stripe" };
  if (rows === "unreadable") return { ok: false, reason: "unavailable" };
  const found = rows.find((r) => r.row.id === subscription);
  if (!found) return { ok: false, reason: "not_member" };
  const state = freeDaysState(found.raw, nowSeconds);
  if (state.blocked) return { ok: false, reason: "blocked", blocked: state.blocked };
  // The date moved since the creator saw it: days given a moment ago, or a renewal. Nothing is added again.
  if (state.nextCharge !== expected) return { ok: false, reason: "changed" };
  const nextCharge = movedCharge(expected, days);

  // One press at a time on this membership and this date.
  const key = claimKey(store, subscription, expected);
  let claimed: unknown;
  try {
    claimed = repliesFor(await redisPipeline([["SET", key, String(days), "NX", "EX", CLAIM_SECONDS]]), 1)?.[0];
  } catch (error) {
    console.error("claiming a member's free days failed", error);
    return { ok: false, reason: "unknown" };
  }
  if (claimed === null) return { ok: false, reason: "busy" };
  if (claimed !== "OK") return { ok: false, reason: "unknown" };
  const release = () => redisPipeline([["DEL", key]]).catch(() => null);

  // The body depends only on the membership, the date seen and the days, so a repeat under the same key is Stripe's replay.
  // On a paid membership it also says the new trial_end is free days, not a trial (lib/member-free-days-rules.ts, freeDaysMarks).
  const marks = freeDaysMarks(found.raw, nextCharge);
  const body = new URLSearchParams({
    trial_end: String(nextCharge),
    proration_behavior: "none",
    "metadata[free_days]": String(days),
    "metadata[free_days_from]": String(expected),
  });
  for (const [key, value] of Object.entries(marks)) body.set(`metadata[${key}]`, value);
  let answer: Record<string, unknown>;
  sent.maybe = true;
  try {
    answer = await onAccount("POST", account, `/subscriptions/${encodeURIComponent(subscription)}`, body, API_VERSION, `member-free-days:${subscription}:${expected}:${days}`);
  } catch (error) {
    // Let go: if it did go through, the date has moved and a new press is refused as "changed"; if not, it may be tried again.
    await release();
    // Stripe saying no to the request itself is a refusal; anything else (no answer, its own error, a key in use) is not known.
    if (error instanceof StripeError && error.status >= 400 && error.status < 500 && error.status !== 409 && error.status !== 429 && error.code !== "idempotency_error") {
      return { ok: false, reason: "refused" };
    }
    console.error("giving a member free days failed", error);
    return { ok: false, reason: "unknown" };
  }
  // Only Stripe's own word that the next charge is now the new date counts as done.
  const kept = answer.metadata && typeof answer.metadata === "object" ? (answer.metadata as Record<string, unknown>) : null;
  const marked = kept !== null && Object.entries(marks).every(([key, value]) => (value === "" ? !(key in kept) : kept[key] === value));
  if (answer.id !== subscription || answer.trial_end !== nextCharge || answer.status !== "trialing" || !marked) {
    console.error("Stripe's answer to free days did not carry the new date", subscription);
    await release();
    return { ok: false, reason: "unknown" };
  }
  // Only now is the claim kept: it marks this press as done, so a replay never logs or emails twice.

  await forgetStatus(account, subscription).catch(() => null);
  const s = speech(store);
  await logTeam(store.sid, {
    who: by.who,
    role: by.role,
    what: `Payments: gave ${days} free ${days === 1 ? "day" : "days"} on membership ${subscription}; next charge ${s.date(expected * 1000)} → ${s.date(nextCharge * 1000)}`,
  });
  const emailed = await tellMember(store, email, found.row.product, days, expected, nextCharge, subscription).catch((error) => {
    console.error("emailing a member their free days failed", error);
    return false;
  });
  return { ok: true, nextCharge, emailed };
}

/** The member's note of their free days, from the store, in its language, with both dates. */
async function tellMember(store: Store, email: string, product: string, days: number, from: number, to: number, subscription: string): Promise<boolean> {
  const w = freeDaysWords(store.language);
  const s = speech(store);
  const title = (product ? (await readListings(store, [product]).catch(() => []))[0]?.title : "") || store.name;
  return sendEmail({
    meter: { by: "store", store: store, kind: "email" },
    from: fromCreator(store),
    to: email,
    replyTo: store.email,
    subject: w.subject(store.name).slice(0, 200),
    text: `${w.body(store.name, title, w.days(days), s.date(from * 1000), s.date(to * 1000))}\n\n${w.manage}\n${storeBase(store)}/manage`,
    idempotencyKey: `member-free-days:${subscription}:${from}`,
  });
}
