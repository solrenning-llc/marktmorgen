/**
 * Two emails during the free trial, to a store that has not sold yet, each
 * with the one thing that would most help it sell (added 11 October 2026).
 *
 * Why. A trial answers "is this worth paying for?" only if something sells
 * inside it (lib/plan.ts, TRIAL_DAYS). The studio already walks a creator to
 * the first sale (components/studio-start.tsx, then lib/store-coach.ts), but
 * only a creator who opens the studio sees it, and the ones who do not are
 * the ones who reach the first charge with nothing sold and cancel. Stan,
 * which writes to no such creator, loses about 13% of its creators a month
 * (Contrary, August 2026).
 *
 * What it is, precisely:
 *
 *   - On NUDGE_DAYS of the trial, counted from its first day: one email each,
 *     never twice for the same subscription, and none once the store has sold
 *     (lib/yearly-offer.ts, its first-sale mark read exactly here; none either
 *     while that is not known) or the trial is set to stop.
 *   - Each names one step, the first that is missing, in the order a store
 *     can sell: something to sell, the creator's Stripe account, then the
 *     store coach's weightiest missing check, and last the address shared.
 *   - Two, and said to be two. A trial that writes every day is a trial that
 *     gets unsubscribed from, and the pre-charge notice (lib/billing-reminders)
 *     is a third email the trial already has.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { holdLock } from "@/lib/redis-lock";
import { listSubscriptions } from "@/lib/billing";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { SITE_URL } from "@/lib/site-url";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { TRIAL_DAYS } from "@/lib/plan";
import { productCount } from "@/lib/catalog";
import { nextChecks, storeChecks } from "@/lib/store-coach";
import { studioPath } from "@/lib/studio-route";
import { SUBSCRIPTION_PATTERN, type Store, storeForHandle } from "@/lib/store";
import { firstSaleKey } from "@/lib/yearly-offer";

const DAY = 86_400;
/** The days of the trial an email goes on: the fourth and the tenth, counted from the first. */
export const NUDGE_DAYS = [3, 9] as const;
const MAX_PAGES = 50;
const sentKey = (subscription: string, dayIndex: number) => `nl:nudge:${subscription}:${dayIndex}`;
/**
 * How long a nudge's mark lasts once it is kept, from just before its send: longer than the whole trial, so no later
 * run can ever see it lapse and post the nudge again. The transports' own once-only windows are shorter than the
 * nudges' daily rhythm (Amazon's nl:ses:once: key lasts a day, lib/email.ts), so they are never what keeps a nudge
 * from going twice (Claude 2 on #3342).
 */
const SENT_SECONDS = 60 * DAY;
/**
 * How long a nudge's mark lasts from its claim to its keep, just before the send: longer than any run can take (the
 * cron's 60 s, and its lock's 300 s), so a run never sees its own mark lapse, and short enough that a run killed
 * before the send leaves it to lapse, and the nudge, never posted, goes on a later run.
 */
const PENDING_SECONDS = 600;
/** The last trial a run that stopped at its deadline handled (a subscription id); the next run starts after it. */
const CURSOR_KEY = "nl:trialnudge:cursor";
const CURSOR_SECONDS = 7 * DAY;
/** How long a run may keep starting nudges when the caller gives no deadline. */
const DEFAULT_RUN_MS = 20_000;

export type NudgeStep = { title: string; how: string; url: string };

/** The one step that would most help this store sell now. Pure. */
export function nextStep(store: Store): NudgeStep {
  const studio = (hash: string, page = "") => `${SITE_URL}${studioPath(store, "", page)}${hash}`;
  if (productCount(store) === 0) {
    return {
      title: "Put up the first thing to sell",
      how: "A file, a course, a call, a membership, or something free for an email address. One is enough to start.",
      url: studio("#products"),
    };
  }
  if (!store.stripeChargesEnabled) {
    return {
      title: "Connect your Stripe account",
      how: "It is where your buyers' money goes: straight to you, never through us. Until it is connected, nobody can pay you.",
      url: studio("#stripe"),
    };
  }
  const [check] = nextChecks(storeChecks(store, { path: (page) => studioPath(store, "", page) }), 1);
  if (check) {
    return {
      title: check.label,
      how: check.why,
      url: check.href.startsWith("#") ? studio(check.href) : `${SITE_URL}${check.href}`,
    };
  }
  return {
    title: "Share your address",
    how: `Put marktmorgen.com/@${store.handle} in your bio, and send it to the people who already follow you. Your store is ready; it needs visitors.`,
    url: `${SITE_URL}/@${store.handle}`,
  };
}

/** The email, plain text. `left` is the days of the trial still to run. */
export function nudgeEmail(store: Store, step: NudgeStep, left: number, which: 0 | 1): { subject: string; text: string } {
  const days = left === 1 ? "1 day" : `${left} days`;
  return {
    subject: which === 0 ? `One step to your first sale: ${step.title.toLowerCase()}` : `${days} of your trial left: one thing that helps you sell`,
    text: [
      "Hello,",
      "",
      which === 0
        ? `Your store ${store.name} has not made its first sale yet. Here is the one step that would help most right now:`
        : `${days} of your free trial are left, and your store ${store.name} has not sold yet. This is the step that would help most:`,
      "",
      step.title,
      step.how,
      step.url,
      "",
      which === 0
        ? "We write about this twice during your trial, and this is the first."
        : "This is the last email like this. Your first charge is only taken when the trial ends, and you can cancel before then in your studio.",
      "",
      `Questions, or stuck on a step: reply to this email, or write to ${SUPPORT_EMAIL}.`,
      "",
      "Marktmorgen",
    ].join("\n"),
  };
}

/** Which nudge a trialing subscription is due today, if any: 0 for the first, 1 for the second. */
export function dueNudge(subscription: Record<string, unknown>, nowSeconds: number): { which: 0 | 1; left: number } | null {
  if (subscription.status !== "trialing") return null;
  if (subscription.cancel_at_period_end === true || (typeof subscription.cancel_at === "number" && subscription.cancel_at > 0)) return null;
  const trialEnd = typeof subscription.trial_end === "number" ? subscription.trial_end : 0;
  const trialStart = typeof subscription.trial_start === "number" ? subscription.trial_start : trialEnd - TRIAL_DAYS * DAY;
  if (!trialEnd || nowSeconds >= trialEnd) return null;
  const dayIndex = Math.floor((nowSeconds - trialStart) / DAY);
  const left = Math.max(1, Math.ceil((trialEnd - nowSeconds) / DAY));
  // The latest nudge whose day has come; a daily run that missed a day still sends it, once.
  for (let which = NUDGE_DAYS.length - 1; which >= 0; which -= 1) {
    if (dayIndex >= NUDGE_DAYS[which]) return { which: which as 0 | 1, left };
  }
  return null;
}

/**
 * When the store first sold, read exactly (CX-123 rule 24; Claude 6 audit on #2898): its seconds, 0 only when GET
 * answers that nothing is kept, null when the read failed or the reply is in any other shape. lib/yearly-offer.ts
 * writes the seconds, or (since Claude 5 on #2722) the milliseconds of claimValue with a point and a random part; any
 * positive whole number before the point is a sale. firstSaleAt there reads an unknown as 0, which here would tell a
 * store that sold that it has not, so it is not used.
 */
async function firstSaleKnown(store: Pick<Store, "sid" | "handle">): Promise<number | null> {
  let replies: unknown[] | null;
  try {
    replies = repliesFor(await redisPipeline([["GET", firstSaleKey(store)]]), 1);
  } catch {
    return null;
  }
  if (!replies) return null;
  const [raw] = replies;
  if (raw === null) return 0;
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,15}(\.[0-9]+)?$/.test(raw)) return null;
  return Math.floor(Number(raw));
}

/**
 * Whether this run sends nudge `which`, and its mark's own value if so: none of it or a later one sent (EXISTS
 * answering exactly 0 each), and its mark taken here (lib/claim-mark.ts). A SET NX that landed with its reply lost is
 * read back as ours, so the nudge goes once and is never lost (Codex Q and Claude 5 on #2898); null when one was sent
 * (EXISTS 1, or the mark holding another value, the "1" of marks from before included). Any other answer is unknown:
 * the mark is let go only while it holds this run's value, and it throws (CX-123 rule 24), so a nudge is never sent
 * twice, nor sent without knowing, and goes on the next run.
 */
async function claimNudge(keys: string[], which: number): Promise<string | null> {
  const seen = repliesFor(await redisPipeline(keys.map((key) => ["EXISTS", key])), keys.length);
  const counts = seen?.map(countOf);
  if (!counts || counts.some((count) => count !== 0 && count !== 1)) throw new UnknownReplyError("the trial nudges sent");
  if (counts.slice(which).some((count) => count === 1)) return null;
  const mine = claimValue();
  // Pending until it is kept just before the send (keepNudge): a run killed before then does not lose the nudge.
  const claimed = await claimMark(keys[which], PENDING_SECONDS, mine);
  if (claimed === "ours") return mine;
  if (claimed === "taken") return null;
  await releaseMark(keys[which], mine);
  throw new UnknownReplyError("a trial nudge's mark");
}

/**
 * Just before the send, the mark is kept SENT_SECONDS, only while it still holds this run's value (lib/redis-lock.ts,
 * one script), so it outlives every window in which the nudge could be posted again. Tried twice; when neither
 * answers exactly 1 nothing is sent: the mark lapses at PENDING_SECONDS and a later run sends the nudge, or, when a
 * hold landed with its reply lost, it stands and the nudge goes at most once (CX-123 rule 24).
 */
async function keepNudge(key: string, mine: string): Promise<boolean> {
  const held = { key, token: mine, ttlSeconds: SENT_SECONDS };
  return (await holdLock(held)) || (await holdLock(held));
}

/**
 * Where the last run stopped, read exactly (CX-123 rule 24): a subscription id, or undefined when GET answers that
 * nothing is kept. Any other answer is not known, and the walk starts from the first page: every trial is reached
 * again, and the marks keep any nudge from going twice, so nothing is skipped on an unreadable cursor.
 */
async function savedCursor(): Promise<string | undefined> {
  try {
    const replies = repliesFor(await redisPipeline([["GET", CURSOR_KEY]]), 1);
    const raw = replies?.[0];
    if (raw === null) return undefined;
    if (typeof raw === "string" && SUBSCRIPTION_PATTERN.test(raw)) return raw;
  } catch {
    // Not known: from the first page, below.
  }
  console.error("reading where the trial nudges stopped failed; starting from the first trial");
  return undefined;
}

/** Keeps where this run stopped, or lets it go once the walk reached the end. An unknown answer is said, never thrown. */
async function saveCursor(after: string | undefined): Promise<void> {
  const command = after ? ["SET", CURSOR_KEY, after, "EX", CURSOR_SECONDS] : ["DEL", CURSOR_KEY];
  try {
    const reply = repliesFor(await redisPipeline([command]), 1)?.[0];
    if (after ? reply === "OK" : reply === 0 || reply === 1) return;
  } catch {
    // Said below.
  }
  // A cursor not kept starts the next walk from the first trial; one not let go starts it after a trial handled:
  // a day late for the ones before it, never lost, since a late nudge still goes (dueNudge).
  console.error("keeping where the trial nudges stopped failed", after ?? "the end");
}

/**
 * The daily pass over every trial. Safe to run as often as it is called. No nudge is started at or after `deadline`
 * (epoch ms): the walk stops there, keeps the last trial it handled, and the next run carries on after it, so a run
 * the clock cuts short never leaves a nudge marked and not sent, nor the jobs after it without their time.
 */
export async function sendTrialNudges(
  nowSeconds = Math.floor(Date.now() / 1000),
  deadline = Date.now() + DEFAULT_RUN_MS,
): Promise<{ sent: number; failed: number; seen: number; complete: boolean }> {
  const counts = { sent: 0, failed: 0, seen: 0, complete: false };
  if (!isRedisConfigured() || !isSenderConfigured()) return counts;
  if (Date.now() >= deadline) return counts;
  let after = await savedCursor();
  const resumed = after !== undefined;
  const stop = async () => {
    await saveCursor(after);
    return counts;
  };
  for (let page = 0; page < MAX_PAGES; page++) {
    if (Date.now() >= deadline) return stop();
    let listed: Awaited<ReturnType<typeof listSubscriptions>>;
    try {
      listed = await listSubscriptions("trialing", after);
    } catch (error) {
      // Kept where it got to; a first page that would not list after the saved cursor (a trial Stripe no longer
      // pages from) starts the next walk from the first trial instead, so a cursor never holds every run up.
      if (page === 0 && resumed) after = undefined;
      await saveCursor(after);
      throw error;
    }
    const { data, hasMore } = listed;
    for (const subscription of data) {
      if (Date.now() >= deadline) return stop();
      counts.seen += 1;
      const id = typeof subscription.id === "string" ? subscription.id : "";
      // Past the deadline before its mark: not handled, and the cursor stays on the one before it.
      if ((await nudgeOne(subscription, id, nowSeconds, deadline, counts)) === "late") return stop();
      if (id) after = id;
    }
    if (!hasMore || !data.length) {
      after = undefined;
      counts.complete = true;
      return stop();
    }
  }
  return stop();
}

async function nudgeOne(
  subscription: Record<string, unknown>,
  id: string,
  nowSeconds: number,
  deadline: number,
  counts: { sent: number; failed: number },
): Promise<"done" | "late"> {
  const due = id ? dueNudge(subscription, nowSeconds) : null;
  const handle = (subscription.metadata as Record<string, string> | null | undefined)?.store;
  if (!due || !handle) return "done";
  const store = await storeForHandle(handle);
  // Only the store this subscription is written down on, and only one that has not sold.
  if (!store || store.subscriptionId !== id || !store.email) return "done";
  // Not known whether it sold (CX-123 rule 24): no "has not sold yet" email, and the store is said as failed.
  const sold = await firstSaleKnown(store);
  if (sold === null) {
    console.error("reading a trialing store's first sale failed", id);
    counts.failed += 1;
    return "done";
  }
  if (sold > 0) return "done";
  // Past the deadline after the reads: no mark is taken, and the next run, starting at it, sends it.
  if (Date.now() >= deadline) return "late";
  // A later nudge stands for an earlier one that was missed: never two in one day.
  const keys = NUDGE_DAYS.map((_, i) => sentKey(id, i));
  let claimed: string | null;
  try {
    claimed = await claimNudge(keys, due.which);
  } catch (error) {
    // Not known whether it was sent (CX-123 rule 24): nothing is sent, and the store is said as failed.
    console.error("reading whether a trial nudge was sent failed", id, error);
    counts.failed += 1;
    return "done";
  }
  if (!claimed) return "done";
  // Kept long before the send, never after it: a failed keep sends nothing, so a nudge can never go twice.
  if (!(await keepNudge(keys[due.which], claimed))) {
    console.error("keeping a trial nudge's mark failed; nothing sent, a later run sends it once", id);
    counts.failed += 1;
    return "done";
  }
  const { subject, text } = nudgeEmail(store, nextStep(store), due.left, due.which);
  const ok = await sendEmail({
    meter: { by: "company" },
    from: NIMBUS_FROM,
    to: store.email,
    subject,
    text,
    replyTo: SUPPORT_EMAIL,
    idempotencyKey: `nl-trial-nudge:${id}:${due.which}`,
  }).catch(() => false);
  // false is refused or unknown alike (the provider may have taken it and the reply been lost), so the mark, kept
  // before the send, stays: a nudge goes at most once, never twice (CX-123 rule 24; Claude 6 audit on #2898).
  if (ok) counts.sent += 1;
  else counts.failed += 1;
  return "done";
}
