/**
 * A member pausing their membership, or coming back early, from the page the
 * emailed link opens (app/[handle]/manage). The rules, and why, are in
 * lib/membership-pause-rules.ts.
 *
 * The membership is checked against the link before Stripe is asked anything,
 * as cancelling is (lib/membership-manage.ts, openCancel): it has to belong to
 * the customer the link was issued for, on this store's account, and be one
 * this store sold. Then Stripe is told to skip the payments of the pause
 * (pause_collection, void, resuming on the day it ends), and the membership
 * carries when the pause starts and when it was asked for, which is all the
 * doors read (lib/membership-access.ts, memberState).
 */
import { onAccount, StripeError } from "@/lib/stripe-account";
import { withLock } from "@/lib/redis-lock";
import { grantOf, subsOf, type SubRow } from "@/lib/membership-manage";
import { forgetStatus } from "@/lib/membership-access";
import { productOfSub } from "@/lib/tier-rules";
import { readListings } from "@/lib/catalog";
import { sendEmail } from "@/lib/email";
import { fromCreator, storeBase } from "@/lib/purchase-email";
import { speech } from "@/lib/buyer-words";
import { membershipWords } from "@/lib/buyer-words/membership";
import type { Store } from "@/lib/store";
import { type PauseSub, addMonths, cannotPause, pauseOf, periodEndOf } from "@/lib/membership-pause-rules";

const SUB_PATTERN = /^sub_[A-Za-z0-9]{6,64}$/;

/**
 * One change to a membership at a time: the lock a switch between plans or to yearly takes (lib/tier-switch.ts,
 * lib/yearly-fallback.ts), held from reading the membership to Stripe's answer. Resuming inside a pause starts a new
 * period with a payment (`billing_cycle_anchor=now`), and Stripe charges for every such request it carries out, so
 * two presses that both read the membership as paused must never both send it: the second waits, then reads it as it
 * is. A lock that cannot be taken, or Redis that cannot be asked, changes nothing and answers "error".
 */
const membershipLockKey = (subscription: string) => `nl:tier:${subscription}:lock`;
/** Longer than the reads and the change at their ceiling (STRIPE_TIMEOUT_MS, 20 s, lib/fetch-timeout.ts), with room. */
const MEMBERSHIP_LOCK_SECONDS = 120;
const MEMBERSHIP_LOCK_WAIT_MS = 5_000;

/** Runs one change to a membership under its lock; a lock not taken (or not askable) is "error", never a change. */
async function underLock<T>(subscription: string, what: string, work: () => Promise<T | { ok: false; reason: "error" }>): Promise<T | { ok: false; reason: "error" }> {
  try {
    return await withLock(membershipLockKey(subscription), MEMBERSHIP_LOCK_SECONDS, MEMBERSHIP_LOCK_WAIT_MS, work);
  } catch (error) {
    console.error(`${what} could not take the membership's lock`, error);
    return { ok: false, reason: "error" };
  }
}

export type PauseResult = { ok: true; from: number; until: number } | { ok: false; reason: "expired" | "cannot" | "error" };
export type ResumeResult = { ok: true } | { ok: false; reason: "expired" | "cannot" | "declined" | "error" };

async function memberSub(store: Store, token: string, subscription: string): Promise<{ sub: SubRow & PauseSub; account: string; customer: string } | "expired" | null> {
  if (!SUB_PATTERN.test(subscription)) return null;
  const grant = await grantOf(store, token);
  if (!grant) return "expired";
  const sub = (await subsOf(store, grant)).find((s) => s.id === subscription);
  return sub ? { sub: sub as SubRow & PauseSub, account: grant.a, customer: grant.c } : null;
}

/** The date a member reads, in the store's language. */
function day(store: Store, seconds: number): string {
  return speech(store).date(seconds * 1000);
}

/** Pauses one membership for `months`, from the end of the period already paid for. */
export async function pauseMembership(store: Store, token: string, subscription: string, months: number, now = Math.floor(Date.now() / 1000)): Promise<PauseResult> {
  if (!Number.isInteger(months) || months < 1 || months > store.pause) return { ok: false, reason: "cannot" };
  const done = await underLock(subscription, "pausing a membership", async () => {
    let found: Awaited<ReturnType<typeof memberSub>>;
    try {
      found = await memberSub(store, token, subscription);
    } catch (error) {
      console.error("reading a membership to pause failed", error);
      return { ok: false as const, reason: "error" as const };
    }
    if (found === "expired") return { ok: false as const, reason: "expired" as const };
    if (!found || cannotPause(found.sub, store.pause, now) !== null) return { ok: false as const, reason: "cannot" as const };
    const from = periodEndOf(found.sub);
    const until = addMonths(from, months);
    try {
      await onAccount(
        "POST",
        found.account,
        `/subscriptions/${encodeURIComponent(subscription)}`,
        new URLSearchParams({
          "pause_collection[behavior]": "void",
          "pause_collection[resumes_at]": String(until),
          "metadata[pause_from]": String(from),
          "metadata[paused_at]": String(now),
        }),
        undefined,
        `nimbus-pause:${subscription}:${from}`,
      );
    } catch (error) {
      console.error("pausing a membership failed", error);
      return { ok: false as const, reason: "error" as const };
    }
    return { ok: true as const, found, from, until };
  });
  if (!done.ok) return done;
  const { found, from, until } = done;
  await forgetStatus(found.account, subscription).catch(() => null);
  await tellPaused(store, found.account, found.customer, found.sub, from, until).catch((error) => console.error("telling a member of their pause failed", error));
  return { ok: true, from, until };
}

/**
 * Ends a pause early. Before it has started, that only takes it off: the
 * member is still inside what they paid for. Once it has, the membership
 * starts a new period today with a payment, and Stripe is asked to refuse the
 * change if that payment fails, so nobody is let back in on a declined card.
 */
export async function resumeMembership(store: Store, token: string, subscription: string, now = Math.floor(Date.now() / 1000)): Promise<ResumeResult> {
  // Read and changed under the membership's lock: a second press reads it after the first's change, no longer paused.
  const done = await underLock(subscription, "resuming a membership", async (): Promise<Extract<ResumeResult, { ok: false }> | { ok: true; account: string }> => {
    let found: Awaited<ReturnType<typeof memberSub>>;
    try {
      found = await memberSub(store, token, subscription);
    } catch (error) {
      console.error("reading a membership to resume failed", error);
      return { ok: false, reason: "error" };
    }
    if (found === "expired") return { ok: false, reason: "expired" };
    const pause = found ? pauseOf(found.sub) : null;
    if (!found || !pause) return { ok: false, reason: "cannot" };
    const body = new URLSearchParams({ pause_collection: "", "metadata[pause_from]": "" });
    if (now >= pause.from) {
      body.set("billing_cycle_anchor", "now");
      body.set("proration_behavior", "none");
      body.set("payment_behavior", "error_if_incomplete");
    }
    try {
      await onAccount("POST", found.account, `/subscriptions/${encodeURIComponent(subscription)}`, body);
    } catch (error) {
      if (error instanceof StripeError && error.status === 402) return { ok: false, reason: "declined" };
      console.error("resuming a membership failed", error);
      return { ok: false, reason: "error" };
    }
    return { ok: true, account: found.account };
  });
  if (!done.ok) return done;
  await forgetStatus(done.account, subscription).catch(() => null);
  return { ok: true };
}

/** The member's note of their pause, from the store, in its language, with the dates. */
async function tellPaused(store: Store, account: string, customer: string, sub: SubRow, from: number, until: number): Promise<void> {
  const person = (await onAccount("GET", account, `/customers/${encodeURIComponent(customer)}`)) as { email?: unknown };
  if (typeof person.email !== "string" || !person.email.includes("@")) return;
  const m = membershipWords(store.language);
  const product = productOfSub(sub);
  const title = (product ? (await readListings(store, [product]).catch(() => []))[0]?.title : "") || store.name;
  await sendEmail({ meter: { by: "store", store: store, kind: "email" },
    from: fromCreator(store),
    to: person.email,
    replyTo: store.email,
    subject: m.pause.emailSubject(title).slice(0, 200),
    text: `${m.pause.emailBody(title, store.name, day(store, from), day(store, until))}\n\n${storeBase(store)}/manage`,
    idempotencyKey: `nimbus-paused:${sub.id}:${from}`,
  });
}
