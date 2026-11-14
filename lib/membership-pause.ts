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
import { redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { grantOf, ownedSub, type SubRow } from "@/lib/membership-manage";
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
 * lib/yearly-fallback.ts), from reading the membership to Stripe's answer. Resuming inside a pause starts a new
 * period with a payment (`billing_cycle_anchor=now`), and Stripe charges for every such request it carries out, so
 * two presses that both read the membership as paused must not both send it: the second waits, then reads it as it
 * is. A lock that cannot be taken, or Redis that cannot be asked, changes nothing and answers "error".
 *
 * The lock is a lease (MEMBERSHIP_LOCK_SECONDS), let go when the first press returns, so on its own it cannot stop
 * a request whose answer never came, or a press held past the lease, from being sent a second time while Stripe
 * still reads the membership as paused (Codex G and Codex T on #3090). What does is the resume's idempotency key
 * (resumeKeyOf): every try of the same resume of the same pause carries the same key, and Stripe answers a repeat
 * with the first result, or 409 while it is still working on it, instead of charging again. Which key a press sends
 * is written down before it is sent (the resume's record, resumeSentKey) and every later press of that pause reuses
 * it, whatever the membership then reads; and once Stripe may have let that key go, nothing is sent again.
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

type PauseSpan = { from: number; until: number };

/**
 * When the pause a resume ends was asked for (`paused_at`, written by pauseMembership), so a pause taken off and
 * asked for again (same start and end) is a resume of its own, never answered with the earlier one's result. A field
 * that is there but not ten-or-so digits is "unreadable": unknown, never another pause (CX-123 rule 24, Codex G on
 * #3090). "missing" is a pause older than that field, which pauseMembership has written on every pause since.
 */
type Asked = { known: string } | "missing" | "unreadable";
function askedOf(sub: PauseSub): Asked {
  const metadata: unknown = sub.metadata;
  if (!metadata || typeof metadata !== "object") return "unreadable";
  if (!Object.prototype.hasOwnProperty.call(metadata, "paused_at")) return "missing";
  const asked: unknown = (metadata as Record<string, unknown>).paused_at;
  if (asked === undefined) return "missing";
  return typeof asked === "string" && /^\d{9,11}$/.test(asked) ? { known: asked } : "unreadable";
}

/** Which pause a resume ends: the membership, when the pause starts and ends, and when it was asked for ("0": missing). */
const pauseIdOf = (subscription: string, pause: PauseSpan, asked: string) => `${subscription}:${pause.from}:${pause.until}:${asked}`;

/**
 * The try of one resume of one pause, which its idempotency key carries. It moves on only after Stripe said for
 * certain that nothing was done (refusedForCertain): Stripe keeps a declined card's 402 under its key for a day and
 * answers every repeat with it, so a member who fixes their card needs a new key. After no answer, a 409 or Stripe's
 * own failure it stays, so the next press repeats the same request and Stripe never carries out a second one (CX-123
 * rule 24: an unknown outcome is never read as declined). The key is the same whether the resume charges or only
 * takes off a pause not yet started: a try that crosses the pause's start sends other parameters under the same key,
 * which Stripe refuses (an idempotency error) rather than carrying out both.
 */
const resumeTryKey = (pauseId: string) => `nl:tier:resume:${pauseId}`;
/** Renewed at every try, and longer than the day Stripe keeps a key's result. */
const RESUME_TRY_SECONDS = 2 * 86_400;
const resumeKeyOf = (pauseId: string, attempt: number) => `nimbus-resume:${pauseId}:${attempt}`;

/** The current try, read exactly (with its lifetime renewed): null when Redis cannot be asked or answers in another shape. */
async function resumeTry(pauseId: string): Promise<number | null> {
  const key = resumeTryKey(pauseId);
  try {
    const replies = repliesFor(await redisPipeline([["GET", key], ["EXPIRE", key, RESUME_TRY_SECONDS]]), 2);
    if (!replies) return null;
    const [count, renewed] = replies;
    if (renewed !== 0 && renewed !== 1) return null;
    if (count === null) return 0;
    return typeof count === "string" && /^(?:0|[1-9]\d{0,8})$/.test(count) ? Number(count) : null;
  } catch (error) {
    console.error("reading a resume's try failed", error);
    return null;
  }
}

/**
 * The resume's record: the exact key a press sent for this pause (by the membership and the pause's start and end
 * only, never by what `paused_at` reads), when it was first sent, and which time of asking it was for. It is written
 * before the request goes out, and while it is there every press of this pause sends that key again, whatever the
 * membership reads the next time (Codex G on #3090: a later read of `paused_at` that is unreadable or missing must not
 * make another key and a second charge). Only a valid `paused_at` other than the record's is another pause (taking a
 * new one needs the membership read as not paused, so the earlier resume has landed), and only Stripe refusing for
 * certain takes the record off (nextResumeTry). A record that cannot be read exactly sends nothing.
 */
const resumeSentKey = (subscription: string, pause: PauseSpan) => `nl:tier:resume:${subscription}:${pause.from}:${pause.until}:sent`;
type Sent = { key: string; asked: string; at: number };
/**
 * Kept until the pause has ended, with two days' room: past that there is nothing to resume. Every pause this file
 * takes ends within 123 days of being asked for (from the end of a monthly period, at most a month away, for at most
 * PAUSE_CHOICES' 3 months), so 128 days covers it; a pause changed outside this file to run longer keeps its record 128 days.
 */
const RESUME_SENT_MAX_SECONDS = 128 * 86_400;
const sentSeconds = (pause: PauseSpan, now: number) => Math.min(Math.max(pause.until - now, 0) + RESUME_TRY_SECONDS, RESUME_SENT_MAX_SECONDS);
/**
 * How long after a key was first sent a press may send it again. Stripe keeps a key's result at least 24 hours and
 * may let it go after that, and a key sent again once it has gone is a new request (docs.stripe.com/api/idempotent_requests),
 * which could carry out a second resume and charge again (Codex G on #3090). The time is taken before the first send,
 * so it is never later than the moment Stripe saved the key, and an hour is left before the 24.
 *
 * A record whose time reads later than now proves nothing about that window (CX-123 rule 24; Codex G on #3090): its
 * age would read negative, as recent, and keep a press repeating the key well past the day Stripe keeps it. It is
 * unknown, and nothing is sent. No room is left for clocks: the time is written by this code's own clock just before
 * the send and read back by a later press, so a later time means a clock that went back or a record that is not what
 * was written; any room would also come out of the hour left before Stripe's 24. Refusing it only while it is in the
 * future would not do: once the clock passed that time its age would read small again, and the key would be repeated
 * past Stripe's day. So the record is marked unknown (markSentUnknown) and every later press of that pause is refused
 * as a record that cannot be read, until it expires with the pause, like any other unreadable record.
 */
const RESUME_REPEAT_MS = 23 * 3_600_000;
/** Whether a press may send the record's key again: only from a first send that is not in the future and at most RESUME_REPEAT_MS ago. */
const insideRepeatWindow = (sentAt: number, now: number) => sentAt <= now && now - sentAt <= RESUME_REPEAT_MS;

/** The resume's record, read exactly: null when there is none, undefined when Redis cannot be asked or answers in another shape. */
async function sentResume(subscription: string, pause: PauseSpan): Promise<Sent | null | undefined> {
  try {
    const replies = repliesFor(await redisPipeline([["GET", resumeSentKey(subscription, pause)]]), 1);
    if (!replies) return undefined;
    const [raw] = replies;
    if (raw === null) return null;
    if (typeof raw !== "string") return undefined;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const { k, p, s, ...rest } = value as Record<string, unknown>;
    if (Object.keys(rest).length > 0) return undefined;
    if (typeof p !== "string" || !/^(?:0|\d{9,11})$/.test(p)) return undefined;
    if (typeof k !== "string" || !k.startsWith(`nimbus-resume:${pauseIdOf(subscription, pause, p)}:`) || !/^nimbus-resume:[A-Za-z0-9_:]{1,200}$/.test(k)) return undefined;
    if (typeof s !== "number" || !Number.isSafeInteger(s) || s <= 0) return undefined;
    return { key: k, asked: p, at: s };
  } catch (error) {
    console.error("reading a resume's record failed", error);
    return undefined;
  }
}

/**
 * Writes the resume's record before its request is sent; true only when Redis said it is written. A record that
 * was not there is written only if it still is not (NX), so two presses that both found none cannot both send.
 */
async function markSent(subscription: string, pause: PauseSpan, sent: Sent, fresh: boolean, now: number): Promise<boolean> {
  const command: (string | number)[] = ["SET", resumeSentKey(subscription, pause), JSON.stringify({ k: sent.key, p: sent.asked, s: sent.at }), "EX", sentSeconds(pause, now)];
  if (fresh) command.push("NX");
  try {
    const replies = repliesFor(await redisPipeline([command]), 1);
    return replies !== null && replies[0] === "OK";
  } catch (error) {
    console.error("writing a resume's record failed", error);
    return false;
  }
}

/**
 * Marks a resume's record unknown (its time 0, which sentResume never reads as a send), keeping its key and pause and
 * only if it is still there (XX). A write that fails is logged; that press still sends nothing.
 */
async function markSentUnknown(subscription: string, pause: PauseSpan, sent: Sent, now: number): Promise<void> {
  const command: (string | number)[] = ["SET", resumeSentKey(subscription, pause), JSON.stringify({ k: sent.key, p: sent.asked, s: 0 }), "EX", sentSeconds(pause, now), "XX"];
  try {
    const replies = repliesFor(await redisPipeline([command]), 1);
    if (replies === null || (replies[0] !== "OK" && replies[0] !== null)) console.error("marking a resume's record unknown got an answer in another shape");
  } catch (error) {
    console.error("marking a resume's record unknown failed", error);
  }
}

/**
 * The next try, after Stripe refused this one for certain, and the record taken off so the next press sends its new
 * key. A write that fails leaves the record as it was: the next press repeats the key and gets Stripe's saved refusal
 * once more (never a second charge), and moves it on then.
 */
async function nextResumeTry(subscription: string, pause: PauseSpan, pauseId: string): Promise<void> {
  const key = resumeTryKey(pauseId);
  try {
    await redisPipeline([["INCR", key], ["EXPIRE", key, RESUME_TRY_SECONDS], ["DEL", resumeSentKey(subscription, pause)]]);
  } catch (error) {
    console.error("moving a resume to its next try failed; the next press repeats this one", error);
  }
}

/**
 * Stripe's answer that it refused the resume and did nothing: a 4xx, but never a 409, which Stripe also answers while
 * a request under the same key is still being worked on, nor an idempotency error (the key met other parameters),
 * which says nothing of what the first request under it did. lib/yearly-fallback.ts reads refused the same way,
 * there without the idempotency error.
 */
const refusedForCertain = (error: unknown) =>
  error instanceof StripeError && error.status >= 400 && error.status < 500 && error.status !== 409 && error.code !== "idempotency_error";

export type PauseResult = { ok: true; from: number; until: number } | { ok: false; reason: "expired" | "cannot" | "error" };
export type ResumeResult = { ok: true } | { ok: false; reason: "expired" | "cannot" | "declined" | "error" };

async function memberSub(store: Store, token: string, subscription: string): Promise<{ sub: SubRow & PauseSub; account: string; customer: string } | "expired" | null> {
  if (!SUB_PATTERN.test(subscription)) return null;
  const grant = await grantOf(store, token);
  if (!grant) return "expired";
  // Among every customer the link manages, with the one who holds it (R43 F1 on #2985).
  const owned = await ownedSub(store, grant, subscription);
  return owned ? { sub: owned.sub as SubRow & PauseSub, account: owned.grant.a, customer: owned.grant.c } : null;
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
    // A record or a try that cannot be read is never guessed: guessing a new key could charge again for a resume still pending.
    const sent = await sentResume(subscription, pause);
    if (sent === undefined) return { ok: false, reason: "error" };
    const asked = askedOf(found.sub);
    let pauseId: string;
    let idempotencyKey: string;
    if (sent && (typeof asked !== "object" || asked.known === sent.asked)) {
      // A press of this pause already sent its key, and the read says nothing of another pause: the same key again.
      const clock = Date.now();
      if (sent.at > clock) {
        // A first send in the future is unknown, never proof of being inside the window: nothing is sent, now or once the clock passes it.
        console.error(`resuming a membership whose resume record reads a send time in the future; nothing is sent (${subscription}, ${sent.key})`);
        await markSentUnknown(subscription, pause, sent, now);
        return { ok: false, reason: "error" };
      }
      if (!insideRepeatWindow(sent.at, clock)) {
        // Stripe may have let the key go, so sending it now could be carried out as a new resume and charge again.
        console.error(
          `SEVERE: a resume sent more than 23 hours ago never got a known answer and the membership still reads as paused; nothing is sent again, so it needs a person to check the membership's invoices in Stripe (${subscription}, ${sent.key})`,
        );
        return { ok: false, reason: "error" };
      }
      pauseId = pauseIdOf(subscription, pause, sent.asked);
      idempotencyKey = sent.key;
    } else {
      // No record, or a record of an earlier pause (a valid paused_at other than its own): a new resume of this pause.
      if (asked === "unreadable") {
        console.error(`resuming a membership whose paused_at cannot be read, with no resume of it sent before; nothing is sent (${subscription})`);
        return { ok: false, reason: "error" };
      }
      pauseId = pauseIdOf(subscription, pause, asked === "missing" ? "0" : asked.known);
      const attempt = await resumeTry(pauseId);
      if (attempt === null) return { ok: false, reason: "error" };
      idempotencyKey = resumeKeyOf(pauseId, attempt);
      const record: Sent = { key: idempotencyKey, asked: asked === "missing" ? "0" : asked.known, at: Date.now() };
      if (!(await markSent(subscription, pause, record, sent === null, now))) return { ok: false, reason: "error" };
    }
    try {
      await onAccount("POST", found.account, `/subscriptions/${encodeURIComponent(subscription)}`, body, undefined, idempotencyKey);
    } catch (error) {
      if (refusedForCertain(error)) await nextResumeTry(subscription, pause, pauseId);
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
