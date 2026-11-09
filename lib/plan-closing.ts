import { claimHeldRecheck, heldStoreKnown, heldStoresDue, noteHeldClosing, recordHeldMonth, type HeldFunding } from "@/lib/held-stores";
/**
 * A store whose plan has ended, and what it still keeps.
 *
 * lib/plan-standing.ts gives a store with no plan room for five gigabytes.
 * A store whose plan ends may be keeping far more than that, put there
 * while it paid, and it goes on costing us to keep for as long as it is
 * kept: up to four dollars a month, for ever, for a store that pays
 * nothing. Nothing else here costs anything once a plan has ended.
 *
 * So what such a store keeps past the room of a store with no plan has a
 * date on it, and the date is said three times before it comes. Since 18
 * October 2026 that room is none for a plan that ends from that day on
 * (lib/plan-closing-rules.ts, keptRoomFor): everything such a store keeps
 * has the date, students' hand-ins and community pictures included, so no
 * store goes on costing us for ever once nobody pays for it.
 *
 *   - Nothing happens to a store that keeps no more than its room: none
 *     for a plan ended from 18 October 2026, a store with no plan's before.
 *   - One that keeps more has CLOSING_DAYS from the day its plan ended. Its
 *     owner is written to when the plan ends, WARN_MONTH_DAYS before the
 *     date and WARN_WEEK_DAYS before it, each time with the figures, the
 *     date, and the two ways out: start a plan again, or delete enough to
 *     fit.
 *   - On the date, what it keeps is removed (removeStored): the files its
 *     products hand over, its lessons' videos and downloads, its podcast's
 *     episodes. The store itself is not touched: its page, its products and
 *     prices, its lessons' text and quizzes, its contacts and its orders
 *     all stay, and a file can be put back on a product the day a plan is
 *     started again.
 *
 * This is the one thing in this codebase that deletes what a creator put
 * here without being asked to, so it is hedged every way it can be:
 *
 *   - never before the last notice has been out for a full week. A notice
 *     that could not be sent moves the date; it is not skipped;
 *   - never on our own note that the plan is over. Stripe is asked, that
 *     day, whether the store has a subscription in good standing, and if it
 *     has, the note is put right and nothing is removed;
 *   - never when the store cannot be measured, emailed or checked: each of
 *     those is a reason to do nothing that day, and try the next;
 *   - one store at a time, by the daily job, with what it did written down.
 *
 * Since 18 October 2026 a plan that ends closes the whole store on that
 * day (lib/plan-closing-rules.ts, closesStore), whether it keeps files or
 * not: the same three notices, the same week after the last and the same
 * check with Stripe, and then, that day, its files are removed, the
 * renewals of what it sold are stopped at Stripe (lib/closed-store-data.ts,
 * stopRenewals), and it is put in line for the walk that deletes every
 * record it keeps in the database (lib/closed-store-data.ts), which runs
 * within the hour. Nothing of its sales is copied anywhere: they are on the
 * creator's own Stripe account, which is where a seller's records of them
 * are (docs/tax-uncertainty.md, question 13). A plan that ended before that
 * day keeps the rule above.
 *
 *   nl:plan:ended            the stores whose plan has ended, by the day
 *   nl:plan:closing:<key>    what a store was told and when; when removed,
 *                            and when its records were deleted
 *   nl:plan:closing:after    where a run that ran out of time stopped
 *
 * A store with no plan cannot add to what it keeps past its room
 * (lib/storage-quota.ts, fits), so one that was found to fit is not measured
 * again for RECHECK_DAYS: measuring is the dear part of a look, and nearly
 * every store whose plan ended fits.
 */
import { createHash } from "node:crypto";
import { observeStoreSubscriptions, isBillingConfigured, readSubscription } from "@/lib/billing";
import { readAllListings } from "@/lib/catalog";
import { editCourse, filesInCourse, readCourse, saveCourse } from "@/lib/course";
import { bytesWords } from "@/lib/delivery";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { deleteFile, listFiles } from "@/lib/file-store";
import { CLOSING_DAYS, ENDED_STORE_EXPORTS, ERASE_WITHIN_DAYS, RECHECK_DAYS, WARN_MONTH_DAYS, WARN_WEEK_DAYS, closesStore, keptRoomFor } from "@/lib/plan-closing-rules";
import { type Batched, deleteSalesTraces, markDue, stopRenewals, unmarkDue } from "@/lib/closed-store-data";
import { communityFolder } from "@/lib/community-image";
import { forgetPictures, picturesKept } from "@/lib/community-files";
import { PICTURE_BYTES } from "@/lib/community-picture-rules";
import { ENDED_INDEX, SETUP_STORAGE_BYTES, standingOf } from "@/lib/plan-standing";
import { editPodcast, readPodcast, savePodcast } from "@/lib/podcast";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, listSlots, repliesFor } from "@/lib/redis-reply";
import { onBreak, pauseView } from "@/lib/plan-pause";
import { withLock } from "@/lib/redis-lock";
import { SITE_URL } from "@/lib/site-url";
import { storageUsed, storageWords } from "@/lib/storage-quota";
import { type Store, setPodcastEpisodes, setProductFile, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { dropAllStreams, dropStream } from "@/lib/stream";
import { readStreamPath } from "@/lib/stream-rules";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { BUYER_NOTICE_DAYS, BUYER_NOTICE_FROM, EMAILS_PER_BUYER_PER_ENDING, STRIPE_CALLS_PER_MEMBER, afterBuyersTold, buyerNoticeCap, buyersStartOn, paidBefore } from "@/lib/closing-buyers-rules";
import { forgetCredit, startClosingCredit } from "@/lib/closing-credit";
import { FINAL_INDEX, HELD_INDEX, finalScoreOf, forgetHeld, holdCharges, holdCounts, paidPeriods, retryHolds, savePaidPeriod, startCallBudget } from "@/lib/closing-holds";
import { buyerPagesCap, forgetTold, tellBuyers, tellRefundShort } from "@/lib/closing-buyers";
import { giveBackUnused, unusedRows, unusedSummary } from "@/lib/closing-refunds";
import { stillToGive, unusedOf, type PaidPeriod } from "@/lib/closing-buyers-rules";
import { formatMoney } from "@/lib/money";
import { CLOSING_CHECKOUT_SECONDS, expirePlanCheckouts, lastPlanMoment, markShut, refusePlanIfClosing } from "@/lib/closing-plan-guard";

export { CLOSING_DAYS, RECHECK_DAYS, WARN_MONTH_DAYS, WARN_WEEK_DAYS };

const DAY_MS = 24 * 60 * 60 * 1000;
const stateKey = (key: string) => `nl:plan:closing:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;

/**
 * What a store was told, and when (ms); `removed` once what it kept is gone.
 * `of` is the day the plan ended that all of it is about: a plan that was
 * started again and ended again begins from nothing, with every notice
 * still to come.
 */
type State = {
  of?: number;
  ended?: number;
  month?: number;
  week?: number;
  removed?: number;
  said?: number;
  fit?: number;
  /** A closing store's renewals stopped at Stripe, its line for the walk, its records deleted (ms). */
  renewals?: number;
  due?: number;
  erased?: number;
  /**
   * Queue item 307 [EC1]: when its members' charges were held (the day its
   * plan ended); when its buyers' notices started and when the last went
   * out, where in its checkouts they stopped, and how many addresses its
   * closing emails did not cover; when what members paid for past the day
   * was settled on the closing day.
   */
  hold?: number;
  holdFrom?: number;
  /** The closing day, once it began (ms). */
  day?: number;
  buyersFrom?: number;
  buyersDone?: number;
  buyersAfter?: string;
  /** Pages of payments read for its buyers, and whether that stopped at the closing's cap (buyerPagesCap). */
  buyersPages?: number;
  buyersCapped?: number;
  untold?: number;
  refunds?: number;
};

/** Whether a plan that ended at `endedAt` has its buyers told before its store closes (lib/closing-buyers-rules.ts). */
export function tellsBuyers(endedAt: number): boolean {
  return closesStore(endedAt) && endedAt >= BUYER_NOTICE_FROM;
}

function parseState(raw: unknown): State {
  if (typeof raw !== "string") return {};
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const out: State = {};
    for (const name of ["of", "ended", "month", "week", "removed", "said", "fit", "renewals", "due", "erased", "hold", "holdFrom", "day", "buyersFrom", "buyersDone", "buyersPages", "buyersCapped", "untold", "refunds"] as const) {
      if (typeof value[name] === "number" && Number.isFinite(value[name] as number)) out[name] = value[name] as number;
    }
    if (typeof value.buyersAfter === "string" && /^(start|\d{1,3}\|[!-~]{0,800})$/.test(value.buyersAfter)) out.buyersAfter = value.buyersAfter;
    return out;
  } catch {
    return {};
  }
}

/**
 * A closing state as Redis answered it, read only in its exact shape (CX-123
 * rule 24): null is no record yet, {}; anything else must be the text of a
 * JSON object whose every field is a finite number, buyersAfter a string, as
 * State is written. A reply of another shape (cut short, a number, an object
 * not its text, a list, a field of another type, a missing reply) throws
 * UnknownReplyError: it is never "nothing written down yet", so no closing
 * day, notice, refund, access or deletion is decided on it.
 */
function readState(raw: unknown): State {
  if (raw === null) return {};
  let value: unknown;
  try {
    if (typeof raw !== "string") throw new Error("not text");
    value = JSON.parse(raw);
  } catch {
    throw new UnknownReplyError("a store's closing state");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UnknownReplyError("a store's closing state");
  for (const [name, field] of Object.entries(value)) {
    if (name === "buyersAfter" ? typeof field !== "string" : typeof field !== "number" || !Number.isFinite(field)) throw new UnknownReplyError("a store's closing state");
  }
  return parseState(raw);
}

/** A pipeline's replies, exactly one for each command sent, or UnknownReplyError. */
function exactly(replies: unknown, count: number, what: string): unknown[] {
  const list = repliesFor(replies, count);
  if (!list) throw new UnknownReplyError(what);
  return list;
}

/** The day what a store keeps is removed, from the day its plan ended: both in ms. */
export function removalDay(endedAt: number): number {
  return endedAt + CLOSING_DAYS * DAY_MS;
}

/**
 * Whether a break the creator chose holds the closing, as onBreak
 * (lib/plan-pause.ts) answers it, except that a break that cannot be read,
 * or is read in a shape we do not expect, throws. onBreak answers true then,
 * which is right for the daily walk (nothing is removed on an unknown) but
 * would have closingOf say the store is "not closing" about a store it could
 * not check: its callers refuse or say they could not check instead.
 */
async function breakHolds(store: Store, nowSeconds: number): Promise<boolean> {
  const view = await pauseView(store);
  if (view.kind === "unknown") throw new Error("plan-closing: the store's break could not be read");
  if (view.kind === "missing") return false;
  return Boolean(view.record.funding) || view.record.until > nowSeconds;
}

/**
 * For the studio: the day what a store keeps would be removed, counted the
 * way the job counts it. Null when the store's plan has not ended, or when
 * what it kept has been removed already. Whether the store keeps more than
 * its room, which is what makes the day matter, is for the caller to measure.
 * Throws when its record or its place in the final line is not answered in
 * its exact shape (UnknownReplyError): the refunds and the checkout refuse
 * then, never acting on a day made up from an unknown.
 */
export async function closingOf(store: Store, now = Date.now()): Promise<{ endedAt: number; day: number; today?: boolean; buyers?: { by: number; done: boolean; untold: number } } | null> {
  // Its closing day has begun (queue item 307 [EC1]): it closes today, whatever the plan says.
  if (isRedisConfigured()) {
    const [finalScore, rawFinal] = exactly(await redisPipeline([["ZSCORE", FINAL_INDEX, storeRef(store)], ["GET", stateKey(storeRef(store))]]), 2, "a store's closing");
    // Its score, as one ZSCORE's reply, read by the one reader of the final line (lib/closing-holds.ts).
    const finalEnded = finalScoreOf([finalScore]);
    if (finalEnded !== null) {
      const kept = readState(rawFinal);
      // Removed already, and waiting for the walk that deletes its records.
      if (kept.removed) return null;
      return { endedAt: finalEnded, day: kept.day ?? now, today: true };
    }
  }
  const endedAt = Date.parse(store.planEndedAt);
  if (standingOf(store, now / 1000) !== "ended" || !Number.isFinite(endedAt) || !isRedisConfigured()) return null;
  // A break the creator chose keeps everything until it ends (lib/plan-pause.ts).
  if (await breakHolds(store, now / 1000)) return null;
  const [raw] = exactly(await redisPipeline([["GET", stateKey(storeRef(store))]]), 1, "a store's closing state");
  const read = readState(raw);
  const state: State = read.of === endedAt ? read : {};
  if (state.removed) return null;
  // Never sooner than a week after the last notice, which, where it has not
  // gone out yet, is today at the soonest; nor sooner than BUYER_NOTICE_DAYS
  // after the last buyer was told.
  const day = Math.max(removalDay(endedAt), (state.week ?? now) + WARN_WEEK_DAYS * DAY_MS);
  if (!tellsBuyers(endedAt)) return { endedAt, day };
  const closes = afterBuyersTold(day, state.buyersDone);
  return { endedAt, day: closes, buyers: { by: state.buyersDone ?? closes - BUYER_NOTICE_DAYS * DAY_MS, done: Boolean(state.buyersDone), untold: state.untold ?? 0 } };
}

/** Which notice is the one for today: the first, the one two weeks before, or the last. */
export function noticeFor(endedAt: number, now: number): "ended" | "month" | "week" {
  const day = removalDay(endedAt);
  if (now >= day - WARN_WEEK_DAYS * DAY_MS) return "week";
  if (now >= day - WARN_MONTH_DAYS * DAY_MS) return "month";
  return "ended";
}

/** A moment to the minute, in UTC, said so: as the studio shows the last moment a plan can be started (app/studio/page.tsx). */
const momentWords = (ms: number) => `${new Date(ms).toLocaleString("en-US", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC`;

const dateWords = (ms: number) => new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

/** The three notices before, and the one after. */
function letter(kind: "ended" | "month" | "week" | "removed", store: Store, held: number, endedAt: number, day: number, now: number): { subject: string; text: string } {
  const roomBytes = keptRoomFor(endedAt);
  const room = storageWords(roomBytes);
  // Written the way the room is, so the two can be told apart at a glance;
  // a store a hair over its room is not said to keep exactly its room.
  const kept = storageWords(held) === room ? `a little over ${room}` : storageWords(held);
  const what = [
    "What is removed: the files your products hand over, your lessons' videos and",
    "downloads, your podcast's episodes, the files your students handed in and the",
    "pictures in your community's posts. After that day your buyers can no longer",
    "download those files or watch those videos.",
    "",
    "What stays: your store and its page, your products and their prices, your",
    "lessons' text and quizzes, your contacts and your orders. A product whose",
    "file was removed is off sale until you give it one again.",
  ];
  const ways = roomBytes > 0
    ? [
        "Two things stop it, either one:",
        "",
        `  - start a plan again, and everything stays exactly as it is; or`,
        `  - delete files or lessons you no longer need until your store keeps ${room} or less.`,
      ]
    : [
        "Starting a plan again stops it, and everything stays exactly as it is. If you",
        "would rather not, download from your studio what you want to keep before then.",
      ];
  const over = roomBytes > 0 ? `keeping more than the ${room} a store with no plan may keep` : "keeping files";
  if (kind === "removed") {
    return {
      subject: `The files ${store.name} kept have been removed`,
      text: [
        `Your Marktmorgen plan for ${store.name} ended on ${dateWords(endedAt)}, and your store was`,
        `${over}. As our notices said`,
        "they would be, the files and lesson videos it kept have now been removed.",
        "",
        "Your store is still yours: its page, your products and their prices, your",
        "lessons' text and quizzes, your contacts and your orders are all there. Start",
        "a plan again and you can put a file back on each product and a video back on",
        "each lesson.",
        "",
        `${SITE_URL}/studio`,
        "",
        `If any of this is not what you expected, reply to this email or write to ${SUPPORT_EMAIL}.`,
      ].join("\n"),
    };
  }
  const days = Math.max(1, Math.ceil((day - now) / DAY_MS));
  const head =
    kind === "ended"
      ? [
          `Your Marktmorgen plan for ${store.name} ended on ${dateWords(endedAt)}.`,
          "",
          "Your store is still there and nothing has been removed. Your buyers can",
          "still download what they bought.",
          "",
          "One thing has a date on it.",
        ]
      : [
          `Your Marktmorgen plan for ${store.name} ended on ${dateWords(endedAt)}. Nothing has been removed`,
          "yet, and your buyers can still download what they bought.",
        ];
  return {
    subject: kind === "ended" ? `${store.name}: what happens to your files now that your plan has ended` : `${days} days until the files ${store.name} keeps are removed`,
    text: [
      ...head,
      "",
      ...(roomBytes > 0
        ? [`A store with no plan may keep ${room} of files and lesson videos. Yours keeps`, `${kept}. On ${dateWords(day)}, ${CLOSING_DAYS} days after your plan ended, what your store`]
        : [`A store whose plan has ended keeps its files until a set day. Yours keeps`, `${storageWords(held)}. On ${dateWords(day)}, ${CLOSING_DAYS} days after your plan ended, what your store`]),
      "keeps will be removed.",
      "",
      ...ways,
      "",
      ...what,
      "",
      kind === "ended"
        ? `We will write to you again ${WARN_MONTH_DAYS} days before that day and ${WARN_WEEK_DAYS} days before it. Nothing is removed without a notice at least a week old.`
        : kind === "month"
          ? `We will write to you once more, ${WARN_WEEK_DAYS} days before that day. Nothing is removed without a notice at least a week old.`
          : "This is the last notice before that day.",
      "",
      `${SITE_URL}/studio`,
      "",
      `Questions: reply to this email or write to ${SUPPORT_EMAIL}.`,
    ].join("\n"),
  };
}

/**
 * What a closing store's notices say about its buyers and members (queue
 * item 307 [EC1], parts 4 and 6): when its buyers are told, how many members
 * paid for time past the day and what that time is in all, already written
 * as money. Left out, the notices say nothing of either.
 */
export type ClosingNews = {
  /** The day every buyer is emailed by at the latest (ms), or null when they are not (a plan ended before BUYER_NOTICE_FROM). */
  buyersBy: number | null;
  /** Addresses the store's closing emails did not cover: the creator is asked to tell them. */
  untold: number;
  /** Members who paid for time past the day, or null when that could not be read (the notice then says so, never "none"). */
  members: number | null;
  /** "$120 and €40", or "" for none or for a count that could not be read. */
  unused: string;
  /**
   * Members whose charges could not be paused yet (tried again every day), and those past the closing's limit (not paused).
   * Null when the hold could not be read: the notice then says it could not be checked, never that every one is paused.
   */
  notHeld?: number | null;
  overLimit?: number | null;
  /** Its payments were not all read within the closing's cap: some buyers may not be told. */
  capped?: boolean;
};

/**
 * The notices of a store that closes (plans that end from 18 October 2026):
 * the three before its day. What they say is what lib/closed-store-data.ts
 * does, and the download they point to is the studio's (app/api/store/export,
 * what=store), which a store whose plan has ended has ENDED_STORE_EXPORTS of,
 * its own, never refused for want of room.
 */
export function closingLetter(kind: "ended" | "month" | "week", name: string, endedAt: number, day: number, now: number, news?: ClosingNews): { subject: string; text: string } {
  const studio = `${SITE_URL}/studio#closing`;
  const days = Math.max(1, Math.ceil((day - now) / DAY_MS));
  const buyers = news?.buyersBy
    ? [
        `By ${dateWords(Math.min(news.buyersBy, day - BUYER_NOTICE_DAYS * DAY_MS))}, at least ${BUYER_NOTICE_DAYS} days before your store closes, we email everyone who bought from it,`,
        "once, from Marktmorgen: the day it closes, and to download what they can before then.",
        ...(news.untold > 0
          ? [`${news.untold} ${news.untold === 1 ? "address was" : "addresses were"} not covered by your store's closing emails: please tell ${news.untold === 1 ? "that buyer" : "those buyers"} yourself.`]
          : []),
        ...(news.capped ? ["Your store has more payments than this closing can read, so some of your buyers may not get our email: please tell them yourself."] : []),
        "",
      ]
    : [];
  const unpaused = (news?.notHeld ?? 0) + (news?.overLimit ?? 0);
  // Both counts read, and both none: the only case the notice may say nobody is charged again.
  const allPaused = news?.notHeld === 0 && news?.overLimit === 0;
  // What the closing day refunds is giveBackUnused (lib/closing-refunds.ts):
  // only the members whose last payment was written down when their payments
  // were paused, from the creator's own balance, within the closing's limit.
  // A member whose payments were not paused may never be in it, so the
  // creator is asked to refund that time; and the notice never says a refund
  // is made that the code may not make.
  // Not a list of reasons: the balance, the closing's limit, a disputed payment
  // or one Stripe names no payment for each stop one (lib/closing-refunds.ts).
  const notMade = "Some refunds may not go through (for example, when your Stripe balance is too low): after that day, please check your Stripe account and refund what is left yourself.";
  const holds = news && (news.notHeld === null || news.overLimit === null)
    ? [
        "We could not check just now whether every membership's payments are paused.",
        `Every membership ends on ${dateWords(day)}. If a member is charged before then, please refund them from Stripe.`,
        `For a member whose payments were not paused, what they paid for after ${dateWords(day)} may not be refunded for you: after that day, please check your members in Stripe and refund that time yourself.`,
        "",
      ]
    : unpaused > 0
    ? [
        `${unpaused} ${unpaused === 1 ? "membership's payments are" : "memberships' payments are"} not paused${news?.notHeld ? " yet: we try again every day" : ""}${news?.overLimit ? `${news?.notHeld ? ", and some are" : ":"} past this closing's limit` : ""}.`,
        `Every one of them ends on ${dateWords(day)}. If a member is charged before then, please refund them from Stripe.`,
        unpaused === 1
          ? `What this member paid for after ${dateWords(day)} may not be refunded for you: after that day, please check their membership in Stripe and refund that time yourself.`
          : `What these members paid for after ${dateWords(day)} may not be refunded for you: after that day, please check each of them in Stripe and refund that time yourself.`,
        "",
      ]
    : [];
  const members = news && news.members === null
    ? [
        `We could not check just now which members paid for time after ${dateWords(day)}.`,
        `On ${dateWords(day)} we try to refund, from your own Stripe account, the unused part of the last payment of each member whose payments we paused.`,
        notMade,
        "Marktmorgen never pays it and never takes it.",
        "",
      ]
    : news && news.members !== null && news.members > 0 && news.unused
    ? [
        `${news.members} ${news.members === 1 ? "member has" : "members have"} paid for time after ${dateWords(day)}: ${news.unused} in all.`,
        `On ${dateWords(day)} we try to refund the unused part of each member's last payment, from your own Stripe account.`,
        notMade,
        "You can refund it sooner, after checking each amount, from your studio. Marktmorgen never pays it and never takes it.",
        "",
      ]
    : [];
  return {
    subject: kind === "ended" ? `${name}: your plan has ended, and your store closes on ${dateWords(day)}` : `${days} days until ${name} closes`,
    text: [
      `Your Marktmorgen plan for ${name} ended on ${dateWords(endedAt)}.`,
      "",
      kind === "ended" ? "Your store is still there and nothing has been removed." : "Nothing has been removed yet.",
      // Said only once every membership's payments are known to be paused
      // (lib/closing-holds.ts): a member the hold did not reach, or could not
      // pause, can still be charged, and the notice says so below.
      allPaused ? "Since your plan ended, none of your members is charged again, and they keep their access." : "Your members keep their access until your store closes.",
      `On ${dateWords(day)}, ${CLOSING_DAYS} days after your plan ended, your store closes:`,
      "",
      "  - its files are removed: the files your products hand over, your lessons' videos and",
      "    downloads, your podcast's episodes, the files your students handed in and the",
      "    pictures in your community's posts;",
      "  - every membership and payment plan you sold through it ends that day, on your own",
      "    Stripe account, and nobody is charged for it again;",
      `  - within ${ERASE_WITHIN_DAYS} days, and usually the same day, everything else it keeps with us is`,
      "    deleted: its page, products and prices, pages and posts, courses and the certificates",
      "    they gave, community, contacts, forms and their answers, numbers, and your buyers'",
      "    access to what they bought from it.",
      "",
      ...holds,
      ...buyers,
      ...members,
      "We keep no copy of your sales: every sale, refund and payout is on your own Stripe",
      "account, and stays there. Your Marktmorgen account and your sign-in stay.",
      "",
      "Before then:",
      "",
      "  - download your store's main data as one file, from your studio: your contacts,",
      "    your orders as a spreadsheet, your store's address, name, bio, links, currency and the date it was created, your products",
      "    and their pages, thank-you notes, your posts, your courses",
      `    and your forms' answers. Now that your plan has ended you can download it ${ENDED_STORE_EXPORTS === 1 ? "once" : `${ENDED_STORE_EXPORTS} times`},`,
      "    whatever your store's size, so download it when you are ready to keep it. Nothing else is in it.",
      "    For example, files, videos, community posts, email sequences and broadcasts, reviews, coupons,",
      "    affiliates, the times of booked calls (their payments are in your orders), funnels and CRM deals",
      "    and tasks are not in it, and are deleted after your store closes, within the time above;",
      "  - tell your students to download their course certificates: they can until that day,",
      "    and not after;",
      "  - give your buyers another way to what they bought if you sell elsewhere.",
      "",
      studio,
      "",
      `Starting a plan again before ${momentWords(lastPlanMoment(day))} keeps your store: everything stays exactly as it is, your members' payments go on as they were (nothing is charged for the days in between, and invoices we voided when your plan ended do not come back), and nothing is refunded. After that moment a plan can no longer be started for it: a plan's checkout lasts ${CLOSING_CHECKOUT_SECONDS / 60} minutes, and it must end before the closing day begins.`,
      "",
      kind === "ended"
        ? `We will write to you again ${WARN_MONTH_DAYS} days before that day and ${WARN_WEEK_DAYS} days before it. Nothing is removed without a notice at least a week old.`
        : kind === "month"
          ? `We will write to you once more, ${WARN_WEEK_DAYS} days before that day. Nothing is removed without a notice at least a week old.`
          : "This is the last notice before that day.",
      "",
      `Questions: reply to this email or write to ${SUPPORT_EMAIL}.`,
    ].join("\n"),
  };
}

/** A count as written down: a whole number, never below zero. */
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * The hold's counts as `holdCounts` answers them, or null when the answer is
 * not two counts. Null is said as "could not be checked", never as nothing
 * left unpaused.
 */
export function readHoldCounts(value: unknown): { failed: number; over: number } | null {
  if (!value || typeof value !== "object") return null;
  const { failed, over } = value as { failed?: unknown; over?: unknown };
  return isCount(failed) && isCount(over) ? { failed, over } : null;
}

/**
 * What members paid for past the day, as `unusedSummary` answers it, with its
 * totals written as money; null when the answer is not a count with one
 * total per currency to go with it (members but no total, a total but no
 * members, more currencies than members, a currency twice in any case, an
 * amount that is not money). Null is said as "could not be checked", never
 * as no member at all.
 */
export function readUnusedSummary(value: unknown): { members: number; unused: string } | null {
  if (!value || typeof value !== "object") return null;
  const { members, totals } = value as { members?: unknown; totals?: unknown };
  if (!isCount(members) || !Array.isArray(totals)) return null;
  const money = totals.every((t) => t && typeof t === "object" && typeof (t as { cur?: unknown }).cur === "string" && /^[a-z]{3}$/i.test((t as { cur: string }).cur) && isCount((t as { amount?: unknown }).amount) && (t as { amount: number }).amount > 0);
  if (!money || (members > 0) !== (totals.length > 0) || totals.length > members) return null;
  // One total per currency, whatever its case: a currency twice is not a summary we wrote.
  if (new Set((totals as { cur: string }[]).map((t) => t.cur.toLowerCase())).size !== totals.length) return null;
  try {
    return { members, unused: (totals as { cur: string; amount: number }[]).map((t) => formatMoney(t.amount, t.cur)).join(" and ") };
  } catch {
    return null;
  }
}

/**
 * What a closing store's notice says of its buyers and members today, read
 * from what was written down (no call to Stripe). A read that fails or
 * answers in a shape we do not expect is carried as null, which the notice
 * says it could not check: an unknown is never written as none.
 */
export async function closingNews(store: Store, endedAt: number, day: number, untold: number, capped = false): Promise<ClosingNews> {
  const summary = await unusedSummary(store, day).then(readUnusedSummary, (error) => {
    console.error("plan-closing: the members who paid past a closing store's day could not be read for its notice", error);
    return null;
  });
  const counts = await storeFolder(storeRef(store))
    .then(holdCounts)
    .then(readHoldCounts, (error) => {
      console.error("plan-closing: a closing store's paused memberships could not be read for its notice", error);
      return null;
    });
  return {
    notHeld: counts ? counts.failed : null,
    overLimit: counts ? counts.over : null,
    capped,
    buyersBy: tellsBuyers(endedAt) ? day - BUYER_NOTICE_DAYS * DAY_MS : null,
    untold,
    members: summary ? summary.members : null,
    unused: summary ? summary.unused : "",
  };
}

/**
 * The three things a look at a store does outside this file's own records,
 * named so that a test can stand in for the one that has no stand-in (the
 * host's file store, whose library does not ask through `fetch`).
 */
export type Hands = {
  /**
   * How many bytes a store keeps, by the stores' own counts. What cannot be
   * read is counted as nothing (lib/storage-quota.ts), which is the safe way
   * round here too: a store is never moved toward removal on a figure we do
   * not have.
   */
  measure: (folder: string) => Promise<number>;
  /** Every path kept under a prefix. Throws when it cannot be read. */
  list: (prefix: string) => Promise<string[]>;
  /** Deletes files. Throws when one could not be. */
  remove: (pathnames: string[]) => Promise<void>;
  /** The bytes a community's pictures are counted at (lib/community-files.ts), which sit outside the store's folders. */
  pictures?: (communityId: string) => Promise<number>;
};

const HANDS: Hands = {
  measure: async (folder) => (await storageUsed(folder, SETUP_STORAGE_BYTES)).bytes,
  pictures: async (community) => (await picturesKept(communityFolder(community))) * PICTURE_BYTES,
  list: listFiles,
  remove: deleteFile,
};

/**
 * Removes what a store keeps: every file on a product, a price option or a
 * lesson, every lesson video, every podcast episode, and whatever else sits
 * in the store's folders (the copies stamped for buyers, an upload that was
 * never attached). Each record is written without its file before the file
 * is deleted, the order every removal here is done in, so nothing is ever
 * left pointing at a file that is gone because a write failed halfway.
 *
 * `clean` is whether all of it was seen through: every record written, every
 * folder read to its end, every file deleted. Anything short of that and the
 * store is not written down as done, and this is run again the next day.
 * Safe to run again: what is already gone is passed over.
 *
 * A store that keeps thousands of files is more than one run can delete.
 * Past `until` this stops where it is and says it was not seen through, and
 * the next day's run carries on from what is left in the folders.
 */
export async function removeStored(key: string, hands: Pick<Hands, "list" | "remove"> = HANDS, until = Number.POSITIVE_INFINITY): Promise<{ files: number; clean: boolean }> {
  const store = await storeForEmail(key);
  if (!store) return { files: 0, clean: true };
  const folder = await storeFolder(key);
  const gone: string[] = [];
  let clean = true;
  const failed = (what: string, error: unknown) => {
    clean = false;
    console.error(`removing what a store kept: ${what}`, error);
  };

  // Every product the store has, read whole: each may carry a file, and
  // this runs once for a store, from a daily job, never when a page opens.
  for (const listing of await readAllListings(store)) {
    try {
      for (const id of [...(listing.file ? [listing.id] : []), ...listing.options.filter((option) => option.file).map((option) => option.id)]) {
        const done = await setProductFile(key, id, null);
        if (done.ok && done.removed) gone.push(done.removed.pathname);
        else if (!done.ok) failed(`could not take the file off ${id}`, done.reason);
      }
      if (listing.course) {
        const courseId = listing.course.id;
        await withLock(`nl:course:${courseId}:lock`, 60, 15_000, async () => {
          let course = await readCourse(courseId);
          if (!course) return;
          const files = filesInCourse(course);
          for (const file of files) {
            const lesson = course.modules.flatMap((unit) => unit.lessons).find((l) => l.video?.pathname === file.pathname || l.files.some((f) => f.pathname === file.pathname));
            if (!lesson) continue;
            const edited = editCourse(course, { op: "media-remove", lessonId: lesson.id, pathname: file.pathname });
            if (edited.ok) course = edited.course;
          }
          if (files.length) {
            await saveCourse(course, store, true);
            const left = new Set(filesInCourse(course).map((f) => f.pathname));
            gone.push(...files.map((f) => f.pathname).filter((path) => !left.has(path)));
            if (left.size) failed(`a course kept ${left.size} of its files`, courseId);
          }
        });
      }
      if (listing.podcast) {
        const podcastId = listing.podcast.id;
        const productId = listing.id;
        await withLock(`nl:pod:${podcastId}:lock`, 60, 15_000, async () => {
          let podcast = await readPodcast(podcastId);
          if (!podcast || podcast.episodes.length === 0) return;
          for (const episode of [...podcast.episodes]) {
            const edited = editPodcast(podcast, { op: "remove", id: episode.id });
            if (edited.ok) {
              podcast = edited.podcast;
              gone.push(episode.pathname);
            }
          }
          await savePodcast(podcast);
          await setPodcastEpisodes(key, productId, podcast.episodes.length);
        });
      }
    } catch (error) {
      failed(`one product's records (${listing.id})`, error);
    }
  }

  // The bytes, now that nothing points at them. A lesson's video kept by the
  // video service is taken away there (and kept in line there if it cannot
  // be just now: lib/stream.ts); everything else, from the file store.
  const late = () => Date.now() > until;
  /** Deletes files a few at a time, several at once: one after another, a large store would take hours. */
  const removeAll = async (paths: string[]): Promise<void> => {
    let at = 0;
    const work = async () => {
      while (at < paths.length && !late()) {
        const some = paths.slice(at, at + 20);
        at += some.length;
        await hands.remove(some);
      }
    };
    await Promise.all(Array.from({ length: 6 }, work));
    if (at < paths.length) throw new Error("out of time");
  };
  try {
    for (const path of gone.filter((path) => readStreamPath(path) !== null)) {
      if (late()) throw new Error("out of time");
      await dropStream(path);
    }
    await removeAll(gone.filter((path) => readStreamPath(path) === null));
  } catch (error) {
    failed("what its records named could not all be deleted", error);
  }
  // And whatever else is in the store's own folders, in either file store,
  // and its community's pictures (since 18 October 2026), which the
  // community's posts then show without.
  const pictures = store.community ? `community/${communityFolder(store.community.id)}/` : "";
  for (const prefix of [`vault/${folder}/`, `stores/${folder}/`, ...(pictures ? [pictures] : [])]) {
    try {
      await removeAll(await hands.list(prefix));
      if (prefix === pictures && store.community) await forgetPictures(communityFolder(store.community.id));
    } catch (error) {
      failed(`what was left under ${prefix.split("/")[0]}/`, error);
    }
  }
  if ((await dropAllStreams(folder, until).catch(() => null)) === null) failed("the video service could not be read to its end", folder);
  return { files: gone.length, clean };
}

/** What a member whose refund could not be made is told it was: the unused part, less what was given back already. */
function unusedOfRow(row: PaidPeriod, day: number): number {
  return row.want ?? stillToGive(unusedOf(row, day), row.back ?? 0);
}

export type Closing = {
  key: string;
  /**
   *   fits       keeps no more than a store with no plan may: nothing to do
   *   running    a plan runs again (or Stripe says one does): out of line
   *   told       a notice was sent today
   *   waiting    told already, and the day has not come
   *   removed    what it kept was removed today
   *   held       something could not be done or checked: tried again tomorrow
   *   gone       the store is not there any more
   */
  state: "fits" | "running" | "told" | "waiting" | "removed" | "held" | "gone";
  note?: string;
  /** Only unknown platform billing coverage enters the funded retry index. */
  coverage?: "unknown";
};

/** One store whose plan has ended, looked at for today. */
export async function closeOne(key: string, now = Date.now(), hands: Hands = HANDS, until = Number.POSITIVE_INFINITY, mayObserve?: () => Promise<boolean>): Promise<Closing> {
  const store = await storeForEmail(key);
  if (!store) {
    await redisPipeline([["ZREM", ENDED_INDEX, key], ["ZREM", FINAL_INDEX, key], ["DEL", stateKey(key)]]);
    return { key, state: "gone" };
  }
  // A closing day that has begun (its memberships ended at Stripe) is seen
  // through, whatever happens to the plan since: its buyers have lost what
  // they paid for, so it can no longer "stay open" (queue item 307 [EC1]).
  const was = finalScoreOf(await redisPipeline([["ZSCORE", FINAL_INDEX, key]]));
  if (was !== null) {
    const [rawFinal] = exactly(await redisPipeline([["GET", stateKey(key)]]), 1, "a store's closing state");
    const kept = readState(rawFinal);
    const final: State = kept.of === was ? kept : { of: was, renewals: now };
    // A plan paid for it since its day began (a checkout opened before and
    // finished on it) is ended and returned in full (lib/closing-plan-guard.ts).
    await markShut(store, final.day ?? now, was);
    // The durable final index survives a late active snapshot, which clears
    // planEndedAt. Keep the original closing proof for the refund guard.
    const closingStore = store.planEndedAt ? store : { ...store, planEndedAt: new Date(was).toISOString() };
    if (mayObserve && !(await mayObserve())) return { key, state: "held", coverage: "unknown", note: "daily-recheck-budget" };
    const latePlansChecked = await refuseLatePlans(closingStore).catch(error => {
      console.error("checking a closing store platform coverage failed", error);
      return false;
    });
    if (!latePlansChecked) return { key, state: "held", coverage: "unknown", note: "its plan subscriptions could not all be checked" };
    if (final.removed) {
      if (!final.due) {
        await markDue(key, now);
        await redisPipeline([["SET", stateKey(key), JSON.stringify({ ...final, due: now })]]);
      }
      return { key, state: "removed", note: "its records are deleted by the next walk" };
    }
    const folderFinal = await storeFolder(storeRef(store));
    return closingDay(store, key, final, was, final.day ?? now, folderFinal, now, hands, until, (next) => redisPipeline([["SET", stateKey(key), JSON.stringify(next)]]));
  }
  const endedAt = Date.parse(store.planEndedAt);
  if (standingOf(store, now / 1000) !== "ended" || !Number.isFinite(endedAt)) {
    // A plan runs again: a store in line for the walk is taken out of it.
    await unmarkDue(key).catch(() => {});
    await redisPipeline([["ZREM", ENDED_INDEX, key], ["DEL", stateKey(key)]]);
    return { key, state: "running" };
  }
  // On a break the creator chose (lib/plan-pause.ts): everything is kept and
  // nobody is written to until it ends. Nothing is written down either, so
  // the day after it ends this store is looked at as if for the first time.
  if (await onBreak(key, now / 1000)) return { key, state: "held", note: "on a break" };
  const [raw] = exactly(await redisPipeline([["GET", stateKey(key)]]), 1, "a store's closing state");
  const read = readState(raw);
  // Notices about an earlier ending say nothing about this one.
  const state: State = read.of === endedAt ? read : { of: endedAt };
  const save = (next: State) => redisPipeline([["SET", stateKey(key), JSON.stringify(next)]]);
  const closes = closesStore(endedAt);
  const send = async (kind: "ended" | "month" | "week" | "removed", day: number, held: number): Promise<boolean> => {
    const { subject, text } =
      closes && kind !== "removed" ? closingLetter(kind, store.name, endedAt, day, now, await closingNews(store, endedAt, day, state.untold ?? 0, Boolean(state.buyersCapped))) : letter(kind, store, held, endedAt, day, now);
    // The same notice asked for twice in a day is sent once (a record that
    // could not be written after it went out).
    const idempotencyKey = `${stateKey(key)}:${endedAt}:${kind}`;
    const sent = await sendEmail({ meter: { by: "company" }, from: NIMBUS_FROM, to: store.email, replyTo: SUPPORT_EMAIL, subject, text, idempotencyKey }).catch((error) => {
      console.error("sending a notice about an ended plan's files failed", error);
      return false;
    });
    return sent !== false;
  };

  if (state.removed) {
    // A closing store, after its day: in line for the walk, which deletes its records.
    if (closes) {
      if (!state.due) {
        await markDue(key, now);
        await save({ ...state, due: now });
      }
      return { key, state: "removed", note: "its records are deleted by the next walk" };
    }
    // Done. All that can be left is the letter saying so, if it could not
    // be sent on the day.
    if (!state.said && isSenderConfigured() && (await send("removed", now, 0))) await save({ ...state, said: now });
    return { key, state: "fits" };
  }
  if (!closes && state.fit && now - state.fit < RECHECK_DAYS * DAY_MS) return { key, state: "fits" };

  const folder = await storeFolder(storeRef(store));
  const held = (await hands.measure(folder)) + (store.community && hands.pictures ? await hands.pictures(store.community.id) : 0);
  if (!closes && held <= keptRoomFor(endedAt)) {
    // It fits, so whatever it was told no longer stands. Should it ever keep
    // more again (a copy stamped for a buyer is kept in its folder too), it
    // is told from the start, and has its week from that notice.
    await save({ of: endedAt, fit: now });
    return { key, state: "fits" };
  }

  // Queue item 307 [EC1]: from the day the plan ended no member is charged
  // again (lib/closing-holds.ts); the creator's first notice says what that
  // means for them, so it waits on it, and the hold is tried again each day.
  if (closes && !state.holdFrom) {
    // The addresses told about an earlier ending say nothing about this one;
    // this one's emails and calls to Stripe are capped before any is spent
    // (lib/closing-credit.ts, lib/closing-holds.ts).
    const cap = buyerNoticeCap(store.tier, paidBefore(store));
    await forgetTold(folder);
    await startClosingCredit(folder, cap * EMAILS_PER_BUYER_PER_ENDING);
    await startCallBudget(folder, cap * STRIPE_CALLS_PER_MEMBER);
    Object.assign(state, { holdFrom: now });
    await save(state);
  }
  if (closes && !state.hold) {
    const hold = await holdCharges(store, endedAt, until).catch((error) => {
      console.error("holding a closing store's members' charges failed", error);
      return null;
    });
    // Every page of its memberships is read first (a part a day for a store
    // with more than one run can read); a member that could not be held does
    // not hold up the notices: it is tried again every day, and counted.
    if (!hold?.done) return { key, state: "held", note: "its members are not all reached yet" };
    Object.assign(state, { hold: now });
    await save(state);
  } else if (closes && !state.renewals) {
    await retryHolds(store, endedAt, until).catch((error) => console.error("trying a closing store's members again failed", error));
  }

  if (!isSenderConfigured()) return { key, state: "held", note: "no way to write to the creator" };

  // The day is never sooner than a week after the last notice went out, nor
  // sooner than BUYER_NOTICE_DAYS after the last buyer was told.
  const buyersApply = tellsBuyers(endedAt);
  let day = Math.max(removalDay(endedAt), state.week ? state.week + WARN_WEEK_DAYS * DAY_MS : 0);
  if (buyersApply) day = afterBuyersTold(day, state.buyersDone);
  if (buyersApply && !state.buyersDone && now >= buyersStartOn(day)) {
    const cap = buyerNoticeCap(store.tier, paidBefore(store));
    const told = await tellBuyers(store, endedAt, day, state.buyersAfter ?? "", until, state.buyersPages ?? 0, buyerPagesCap(cap)).catch((error) => {
      console.error("telling a closing store's buyers failed", error);
      return null;
    });
    if (!told) return { key, state: "held", note: "its buyers could not all be read or told yet" };
    if (told.blocked === "postal") {
      console.error("plan-closing: a store's buyers cannot be told: Marktmorgen has no postal address (lib/company-postal.ts); it does not close until they are");
      return { key, state: "held", note: "no company postal address for its buyers' notice" };
    }
    if (told.capped) console.error("plan-closing: a store's payments were not all read within its closing's cap; the rest are counted as not told");
    Object.assign(state, { buyersFrom: state.buyersFrom ?? now, buyersAfter: told.after, buyersPages: told.pages, untold: (state.untold ?? 0) + told.untold, ...(told.capped ? { buyersCapped: 1 } : {}), ...(told.done ? { buyersDone: now } : {}) });
    await save(state);
    if (told.done) day = afterBuyersTold(day, now);
    else return { key, state: "told", note: "buyers, in part" };
  }
  const due = noticeFor(endedAt, now);
  if (!state[due]) {
    // The last notice names the day it makes true: a week from today, when
    // it goes out later than a week before the day first given.
    const named = due === "week" ? Math.max(removalDay(endedAt), now + WARN_WEEK_DAYS * DAY_MS) : removalDay(endedAt);
    if (!(await send(due, named, held))) return { key, state: "held", note: "the notice could not be sent" };
    await save({ ...state, [due]: now });
    return { key, state: "told", note: due };
  }
  if (!state.week || now < day || (buyersApply && !state.buyersDone)) return { key, state: "waiting" };

  // The day has come. Stripe is asked, today, before anything is touched:
  // about the subscription this store has written down, and then for any
  // other in good standing that names it.
  if (mayObserve && !(await mayObserve())) return { key, state: "held", coverage: "unknown", note: "daily-recheck-budget" };
  if (!isBillingConfigured()) return { key, state: "held", coverage: "unknown", note: "Stripe could not be asked" };
  let live;
  try {
    if (store.subscriptionId) {
      const own = await readSubscription(store.subscriptionId);
      if (own.state === "unknown") return { key, state: "held", coverage: "unknown", note: "Stripe could not be asked" };
      if (own.state === "active") {
        await setSubscription(key, { active: true, tier: own.tier, cycle: own.cycle, trialEnds: own.trialing ? own.until : 0, shared: own.shared, period: own.period });
        await redisPipeline([["DEL", stateKey(key)]]);
        return { key, state: "running", note: "Stripe says the plan runs" };
      }
    }
    // Stripe's search can lag about a minute; its list by the store's customer does not, so a plan paid just
    // before this check still keeps the store (the owner's decision: a plan started in time saves it).
    const observation = await observeStoreSubscriptions(store);
    let searchKnown = true;
    try { live = (await observation.find()).live; }
    catch (error) {
      searchKnown = false;
      console.error("searching for an ended store's plan failed", error);
    }
    // A positive, independent customer observation can still save the store
    // when search is unavailable; an empty list cannot prove unknown absence.
    live ??= await observation.customerLive();
    if (!live && !searchKnown) return { key, state: "held", coverage: "unknown", note: "Stripe could not be asked" };
  } catch (error) {
    console.error("asking Stripe about an ended plan failed", error);
    return { key, state: "held", coverage: "unknown", note: "Stripe could not be asked" };
  }
  if (live) {
    // Our note was wrong, or the plan was started again a moment ago: put right.
    await setSubscription(key, { customerId: live.customerId, subscriptionId: live.subscriptionId, active: true, tier: live.tier, cycle: live.cycle, trialEnds: live.trialEnds, shared: live.shared, period: live.period });
    await redisPipeline([["DEL", stateKey(key)]]);
    return { key, state: "running", note: "Stripe says the plan runs" };
  }

  if (closes) return closingDay(store, key, state, endedAt, day, folder, now, hands, until, save);

  const done = await removeStored(key, hands, until);
  if (!done.clean) return { key, state: "held", note: `removed ${done.files}, and something could not be removed` };
  const after = (await hands.measure(folder)) + (store.community && hands.pictures ? await hands.pictures(store.community.id) : 0);
  if (after > keptRoomFor(endedAt)) return { key, state: "held", note: `removed ${done.files} and it still keeps ${bytesWords(after)}` };
  await save({ ...state, removed: now });
  if (await send("removed", now, 0)) await save({ ...state, removed: now, said: now });
  return { key, state: "removed", note: `${done.files} files` };
}

/**
 * A closing store's day, once Stripe has said it has no plan. In order, each
 * step written down as it is done so a day that stops half-way carries on
 * the next: the renewals of what it sold stopped at Stripe (nothing it sold
 * is charged again once it is closed); what its files left under their own
 * names deleted, which only its products can find (lib/closed-store-data.ts,
 * deleteSalesTraces); its files removed; and its line for the walk that
 * deletes its records.
 */
async function closingDay(store: Store, key: string, state: State, endedAt: number, day: number, folder: string, now: number, hands: Hands, until: number, save: (next: State) => Promise<unknown>): Promise<Closing> {
  let next: State = state;
  if (!next.renewals) {
    // From here the closing is seen through (FINAL_INDEX): no release, no "it stays open".
    await redisPipeline([["ZADD", FINAL_INDEX, endedAt, key], ["ZREM", HELD_INDEX, key]]);
    if (!next.day) {
      next = { ...next, day };
      await save(next);
    }
    // No plan can be paid for it from here: its open plan checkouts are
    // expired, and its address is marked for after its records are gone.
    await markShut(store, next.day ?? day, endedAt);
    // Not known in full: an open plan checkout could still be paid. Its members' renewals are still stopped
    // below on this run (a renewal is a charge whose card fee never comes back); then the day is held, its
    // `renewals` mark not written, so the next run reads the checkouts again (stopRenewals skips what is ended).
    const checkoutsRead = await expirePlanCheckouts(store, store.stripeCustomerId ? [store.stripeCustomerId] : []).then(
      () => true,
      (error) => {
        console.error("reading a closing store's open plan checkouts failed", error);
        return false;
      },
    );
    try {
      const stopped = await stopRenewals(store, until);
      if (!stopped.done) return { key, state: "held", note: "the renewals it sold are not all stopped yet" };
    } catch (error) {
      console.error("stopping a closing store's renewals failed", error);
      return { key, state: "held", note: "Stripe could not be asked to stop its renewals" };
    }
    if (!checkoutsRead) return { key, state: "held", note: "its open plan checkouts could not all be read" };
    next = { ...next, renewals: now };
    await save(next);
  }
  // Queue item 307 [EC1], part 4: what members paid for past this day and the
  // creator did not give back, given back now from the creator's own
  // account, once (lib/closing-refunds.ts); a member whose refund the balance
  // did not cover is told so, with the creator's contact.
  if (!next.refunds) {
    const settled = await giveBackUnused(store, next.day ?? day, { until, final: true }).catch((error) => {
      console.error("giving back a closing store's members' unused time failed", error);
      return null;
    });
    if (settled === null || settled === "busy") return { key, state: "held", note: "its members' unused time is not settled yet" };
    // Told for what happened: the balance did not cover it, or the closing's limit of calls did not reach it.
    for (const [why, r] of [["balance", "short"], ["limit", "over"]] as const) {
      const left = [...(await paidPeriods(store))].filter(([, row]) => row.r === r && row.f === 1 && !row.m);
      if (!left.length) continue;
      const told = await tellRefundShort(store, left.map(([, row]) => ({ email: row.e, amount: unusedOfRow(row, next.day ?? day), cur: row.cur })), endedAt, why);
      if (!told.ok) return { key, state: "held", note: "its members whose refund could not be made are not all told yet" };
      for (const [sub, row] of left) await savePaidPeriod(store, sub, { ...row, m: 1 });
      if (told.untold) console.error(`plan-closing: ${told.untold} members whose refund could not be made were not covered by the store's closing emails`);
    }
    const left = (await unusedRows(store, next.day ?? day)).filter((row) => row.paid.r !== "pending");
    if (settled !== "changed" && settled !== "unavailable" && (settled.failed > 0 || left.length > 0)) return { key, state: "held", note: "its members' unused time is not all settled yet" };
    next = { ...next, refunds: now };
    await save(next);
  }
  try {
    await deleteSalesTraces(store);
  } catch (error) {
    console.error("deleting what a closing store's files left failed", error);
    return { key, state: "held", note: "what its files left could not be deleted" };
  }
  const done = await removeStored(key, hands, until);
  if (!done.clean) return { key, state: "held", note: `removed ${done.files}, and something could not be removed` };
  const after = (await hands.measure(folder)) + (store.community && hands.pictures ? await hands.pictures(store.community.id) : 0);
  if (after > keptRoomFor(endedAt)) return { key, state: "held", note: `removed ${done.files} and it still keeps ${bytesWords(after)}` };
  // Its members' last payments and the addresses told, kept only for the closing.
  await forgetHeld(store, folder);
  await forgetTold(folder);
  await forgetCredit(folder);
  await markDue(key, now);
  // Kept in FINAL_INDEX until its records are gone (closeOne, "gone"), so a
  // plan checkout is refused, and a plan paid for it returned, until then.
  await save({ ...next, removed: now, due: now });
  return { key, state: "removed", note: `closed, ${done.files} files: its records are deleted by the next walk` };
}

/**
 * Any plan subscription Stripe has for a store in its closing day, in good
 * standing or still able to charge, is ended and its payment since the day
 * began returned (lib/closing-plan-guard.ts). Stripe not answering is tried
 * again on the next run; the daily sync and the way back check it too.
 */
async function refuseLatePlans(store: Store): Promise<boolean> {
  if (!isBillingConfigured()) return false;
  let complete = true;
  const ids = new Map<string, string>();
  const observation = await observeStoreSubscriptions(store);
  try {
    const found = await observation.find();
    if (found.live) ids.set(found.live.subscriptionId, found.live.customerId);
    for (const id of found.lapsed) ids.set(id, found.customerId ?? "");
  } catch (error) {
    complete = false;
    console.error("searching for a plan paid for a closing store failed", error);
  }
  // This observation is independent: a rejected address search must never
  // prevent us from finding and stopping a late charge by customer.
  try {
    for (const row of observation.customerPlans()) {
      if (row.status === "canceled" || row.status === "incomplete_expired") continue;
      if (!ids.has(row.id)) ids.set(row.id, row.customerId);
    }
  } catch (error) {
    complete = false;
    console.error("listing plans paid for a closing store failed", error);
  }
  for (const [id, customerId] of ids) {
    try {
      let stopped = false;
      const result = await refusePlanIfClosing({ store, handle: store.handle, subscriptionId: id, customerId, onStopped: () => { stopped = true; } });
      // A pending refund is self-contained in UNDO_KEY and retried after the
      // store is gone. Only a proved cancellation may hand it over: merely
      // returning "returning" can also mean an unreadable queue or live plan.
      if (result !== "returned" && result !== "returned-early" && !(result === "returning" && stopped)) complete = false;
    } catch (error) {
      complete = false;
      console.error("refusing a plan paid for a closing store failed", error);
    }
  }
  return complete;
}

/**
 * What the walk does last for each store it deleted (lib/closed-store-data.ts,
 * eraseClosed): writes down that it is done, kept a while so a late look at
 * the store knows. Its owner was told the day in three notices, and is not
 * written to again.
 */
export async function finishClosed(entry: Batched, now = Date.now()): Promise<void> {
  const key = stateKey(entry.ref);
  const [raw] = exactly(await redisPipeline([["GET", key]]), 1, "a closed store's closing state");
  await redisPipeline([["SET", key, JSON.stringify({ ...readState(raw), erased: now }), "EX", ERASED_KEPT_DAYS * 86_400]]);
}

/** How long the closing record of a deleted store is kept: dates only, the company's. */
export const ERASED_KEPT_DAYS = 400;

const AFTER = "nl:plan:closing:after";
const FINAL_AFTER = "nl:held:walk";
const PAGE = 200;

/**
 * A page of the ended line (ZRANGEBYSCORE ... WITHSCORES), read exactly (CX-123 rules 24 and 30): member and score
 * pairs, each member a text and each score a number or its text, at most PAGE pairs. Anything else is
 * UnknownReplyError: never an empty page, which ended the walk, deleted its cursor and left the stores on that page
 * and after it unlooked at that day.
 */
function endedPageOf(replies: unknown): { key: string; score: string }[] {
  const flat = listSlots(repliesFor(replies, 1)?.[0]);
  if (!flat || flat.length % 2 !== 0 || flat.length > 2 * PAGE) throw new UnknownReplyError("a page of the ended closing line");
  const rows: { key: string; score: string }[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const [key, score] = [flat[i], flat[i + 1]];
    const value = typeof score === "number" ? score : typeof score === "string" && /^-?(0|[1-9][0-9]*)(\.[0-9]+)?(e[+-]?[0-9]+)?$/i.test(score) ? Number(score) : Number.NaN;
    if (typeof key !== "string" || !Number.isFinite(value)) throw new UnknownReplyError("a page of the ended closing line");
    rows.push({ key, score: String(score) });
  }
  return rows;
}

/**
 * The daily run: every store whose plan has ended, the longest ended first.
 *
 * Stops at `deadline`, and writes down the day the store it stopped at lost
 * its plan; the next run begins there, so a line longer than one run can
 * look at is still walked to its end, a part a day. A store is looked at
 * once in a run however many share the moment their plans ended.
 */
export async function closeEnded(deadline: number, now = Date.now(), hands: Hands = HANDS, funding?: HeldFunding): Promise<Closing[]> {
  if (!isRedisConfigured()) return [];
  const finals: Closing[] = [];
  const seen = new Set<string>();
  const incomplete = async () => { await recordHeldMonth(now, false); return finals; };
  const visit = async (ref: string, retry = false) => {
    if (seen.has(ref)) return;
    seen.add(ref);
    // Earlier versions indexed every held reason. Local pause/notice/member
    // progress must run before a daily platform-coverage claim is needed.
    const wasCoverageHeld = await heldStoreKnown(ref);
    let result: Closing, attempted = false;
    try {
      const mayObserve = wasCoverageHeld ? async () => {
        if (!retry) return false;
        attempted = await claimHeldRecheck(ref, now);
        return attempted;
      } : undefined;
      result = await closeOne(ref, now, hands, deadline, mayObserve);
    } catch (error) {
      console.error("seeing a closing store through failed", error);
      result = { key: ref, state: "held", note: "failed" };
    }
    const coverageHeld = result.state === "held" && result.coverage === "unknown";
    // A store not actually attempted keeps its older due score; otherwise the
    // ordinary final walk would reset every score and starve stores after50.
    if (!(wasCoverageHeld && coverageHeld && !attempted) && (wasCoverageHeld || coverageHeld)) await noteHeldClosing(ref, coverageHeld, now, funding);
    finals.push(result);
  };
  // Oldest due first; each processed entry moves to tomorrow. The atomic
  // daily claim precedes either provider read, including concurrent runs.
  for (const ref of await heldStoresDue(now)) {
    if (Date.now() > deadline) return incomplete();
    await visit(ref, true);
  }
  const [savedFinal, finalCount] = await redisPipeline([["GET", FINAL_AFTER], ["ZCARD", FINAL_INDEX]]);
  if (savedFinal !== null && (typeof savedFinal !== "string" || !/^(0|[1-9][0-9]*)$/.test(savedFinal) || !Number.isSafeInteger(Number(savedFinal)))) throw new Error("final closing cursor is unknown");
  let finalOffset = savedFinal === null ? 0 : Number(savedFinal);
  let finalWalkComplete = finalOffset === 0;
  for (;;) {
    const [finalRefs] = await redisPipeline([["ZRANGEBYSCORE", FINAL_INDEX, "-inf", "+inf", "LIMIT", finalOffset, PAGE]]);
    if (!Array.isArray(finalRefs) || finalRefs.length > PAGE || Array.from({ length: finalRefs.length }, (_, i) => !Object.hasOwn(finalRefs, i) || typeof finalRefs[i] !== "string").some(Boolean)) throw new Error("final closing page is unknown");
    for (let i = 0; i < finalRefs.length; i++) {
      if (Date.now() > deadline) {
        await redisPipeline([["SET", FINAL_AFTER, finalOffset + i, "EX", 30 * 86400]]);
        return incomplete();
      }
      await visit(finalRefs[i]);
    }
    finalOffset += finalRefs.length;
    if (finalRefs.length < PAGE) break;
    await redisPipeline([["SET", FINAL_AFTER, finalOffset, "EX", 30 * 86400]]);
  }
  await redisPipeline([["DEL", FINAL_AFTER]]);
  const [afterFinalCount] = await redisPipeline([["ZCARD", FINAL_INDEX]]);
  // Rank shifts caused by concurrent removals may skip a row until the next
  // cycle. Continue next time, but never certify that partial monthly count.
  finalWalkComplete &&= typeof finalCount === "number" && Number.isSafeInteger(finalCount) && finalCount >= 0 && afterFinalCount === finalCount;
  // Redis's null is no cursor; a cursor that does not read is unknown (rule 24), never "0", which started the walk over.
  const [saved] = exactly(await redisPipeline([["GET", AFTER]]), 1, "the ended closing line's cursor");
  if (saved !== null && (typeof saved !== "string" || !/^\d+$/.test(saved))) throw new UnknownReplyError("the ended closing line's cursor");
  let from: string = typeof saved === "string" ? saved : "0";
  const out = finals;
  for (;;) {
    const rows = endedPageOf(await redisPipeline([["ZRANGEBYSCORE", ENDED_INDEX, from, now, "WITHSCORES", "LIMIT", 0, PAGE]]));
    for (const row of rows) {
      if (seen.has(row.key)) continue;
      if (Date.now() > deadline) {
        await redisPipeline([["SET", AFTER, String(Math.floor(Number(row.score))), "EX", 30 * 24 * 60 * 60]]);
        return incomplete();
      }
      await visit(row.key);
    }
    if (rows.length < PAGE) break;
    // The next page begins at the last moment of this one, which the page
    // was read up to and through: whoever shares it has been looked at.
    const last = String(Math.floor(Number(rows[rows.length - 1].score)));
    from = last === from.replace("(", "") ? `(${last}` : last;
  }
  await redisPipeline([["DEL", AFTER]]);
  await recordHeldMonth(now, finalWalkComplete);
  return out;
}
