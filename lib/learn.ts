/**
 * Who may open a course, and what they have done in it.
 *
 * Nobody makes a password. A student is someone whose email address paid for
 * the course, proved in one of two ways:
 *
 *   - in the browser that paid: the checkout left a secret cookie in it and
 *     only its fingerprint travelled with the charge, so the thanks page can
 *     open the course there and then, for that course only;
 *   - anywhere else: a link sent to the address, which only whoever reads
 *     that inbox can use.
 *
 * Either way the browser is given a pass for this one store. What the pass
 * opens is asked of the creator's own Stripe account — the payments are the
 * record of who bought what — and kept for ten minutes so a lesson does not
 * wait on Stripe every time.
 *
 * A course sold as a membership is open while the membership is: active, in
 * its free trial, or with a payment being retried. Once Stripe says it has
 * ended, the course closes for that student within those ten minutes, on
 * every page and every download of it, and the course page says the
 * membership ended and how to renew rather than asking them to buy it as if
 * they never had.
 *
 * Progress is kept per course and per student: which lessons they marked done
 * and when they last came back. That is all, and the creator sees it.
 */
import { windowCount, windowCountOf } from "@/lib/window-count";
import { currentMeta } from "@/lib/tier-rules";
import { ensureStatsId, saleHandles, storeRef } from "@/lib/store";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { createHash, randomBytes } from "node:crypto";
import { fileUrl } from "@/lib/file-store";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, SESSION_COOKIE, emailForSession, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, sendEmail, serviceMailKnownUnavailable } from "@/lib/email";
import { coursesWords } from "@/lib/buyer-words/courses";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { HDEL_IF_EQUAL, UnknownReplyError, countOf, listSlots, repliesFor, scanPage, stringList } from "@/lib/redis-reply";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { type DataChange, type DataStore, giveData, needData, noteData, takeData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { orderWrite } from "@/lib/order-data";
import { earnedCourses } from "@/lib/community-points";
import { onAccount } from "@/lib/stripe-account";
import { StripeListUnreadable, readStripePage } from "@/lib/stripe-list";
import { isSettled } from "@/lib/instant-pay";
import { isLiveSub } from "@/lib/membership-access";
import { purchaseRefunded } from "@/lib/refunds";
import { folderFromPathname, freeDeliveryPause, recordDelivery } from "@/lib/delivery";
import { playerFor } from "@/lib/stream";
import { isStreamPath } from "@/lib/stream-rules";
import { opened, watchedForAdmission } from "@/lib/watch";
import { calendarWindow } from "@/lib/allowance-window";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import type { ProductFile } from "@/lib/product-file";
import type { Listing, Store } from "@/lib/store";
import { readKind, readKindExact, readListing, readListingsExactly } from "@/lib/catalog";
import { type Course, type CourseModule, lessonsInOrder, opensAt, readCourse } from "@/lib/course";
import { BLOCKED_READ_MAX } from "@/lib/api-read-rules";
import { deliveredIds } from "@/lib/bundle-rules";
import { importedFrom, importedRead } from "@/lib/imported-purchases";

/** The secret a course checkout leaves in the buyer's browser. */
export const BUYER_COOKIE = "nl_buyer";
export const BUYER_COOKIE_SECONDS = 24 * 60 * 60;
/** How long a browser stays let in. */
export const PASS_SECONDS = 90 * 24 * 60 * 60;
/** How long an emailed link works, and how many times it opens. */
export const LINK_SECONDS = 60 * 60;
const MAX_LINK_OPENS = 10;
/** How long an answer from Stripe about who bought what is reused. */
const PAID_SECONDS = 10 * 60;
const IP_LIMIT = 10;
const ADDRESS_LIMIT = 5;
const RATE_WINDOW_SECONDS = 60 * 60;
/** How long a signed video link plays for: one long sitting. */
export const VIDEO_URL_SECONDS = 4 * 60 * 60;

export const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** The same address, however it was typed, as a key. */
export function emailKey(email: string): string {
  return sha(`nimbus-learner:${normaliseEmail(email)}`).slice(0, 32);
}

/** A key that stays with the store through a change of address. */
export function storeKey(store: Store): string {
  return store.statsId ?? sha(`nimbus-learn-store:${store.email}`).slice(0, 32);
}

export function passCookieName(store: Store): string {
  return `nl_learn_${storeKey(store).slice(0, 16)}`;
}

export function newBuyerKey(): { secret: string; fingerprint: string } {
  const secret = randomBytes(24).toString("hex");
  return { secret, fingerprint: buyerFingerprint(secret) };
}

export function buyerFingerprint(secret: string): string {
  return sha(`nimbus-buyer:${secret}`).slice(0, 40);
}

// ------------------------------------------------------------------ passes

type Pass = { e: string; k: string; c: string[] | "all" };
const passKey = (token: string) => `nl:learn:pass:${sha(token)}`;
/** A pass's key by the hash a buyer's list of passes keeps of it: for a closed store (lib/closed-store-data.ts). */
export const passKeyOfHash = (hash: string) => `nl:learn:pass:${hash}`;
/**
 * The passes one address holds in one store, by the hash their keys are
 * made from (added 17 October 2026), so deleting the person can find them:
 * a pass is kept under its own token, which nothing else can lead back to.
 */
const passesKey = (store: Store, email: string) => `nl:learn:passes:${storeKey(store)}:${emailKey(email)}`;

/** Lets this browser in: to every course the address bought here, or to some. */
export async function mintPass(store: Store, email: string, scope: string[] | "all"): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const pass: Pass = { e: normaliseEmail(email), k: storeKey(store), c: scope };
  await redisPipeline([
    ["SET", passKey(token), JSON.stringify(pass), "EX", PASS_SECONDS],
    ["SADD", passesKey(store, email), sha(token)],
    ["EXPIRE", passesKey(store, email), PASS_SECONDS],
  ]);
  return token;
}

async function readPass(store: Store, token: string | undefined): Promise<Pass | null> {
  if (!token || !TOKEN_PATTERN.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", passKey(token)]]);
  if (typeof raw !== "string") return null;
  try {
    const pass = JSON.parse(raw) as Pass;
    if (pass.k !== storeKey(store) || typeof pass.e !== "string") return null;
    if (pass.c !== "all" && !Array.isArray(pass.c)) return null;
    return pass;
  } catch {
    return null;
  }
}

export function passCookie(store: Store, token: string, secure: boolean): string {
  return `${passCookieName(store)}=${token}; Path=/; Max-Age=${PASS_SECONDS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export type Learner = {
  email: string;
  /** Which courses this browser was let into; "all" once the address is proved. */
  scope: string[] | "all";
  /** The creator, looking at their own course. */
  owner: boolean;
};

type CookieJar = { get(name: string): { value: string } | undefined };

/** Whoever this browser belongs to, as far as this store is concerned. */
export async function learnerFrom(store: Store, cookies: CookieJar): Promise<Learner | null> {
  const signedIn = await emailForSession(cookies.get(SESSION_COOKIE)?.value).catch(() => null);
  if (signedIn && normaliseEmail(signedIn) === normaliseEmail(store.email)) {
    return { email: signedIn, scope: "all", owner: true };
  }
  const pass = await readPass(store, cookies.get(passCookieName(store))?.value);
  if (pass) return { email: pass.e, scope: pass.c, owner: false };
  // Signed in to Marktmorgen with this address: the address is already proved.
  if (signedIn) return { email: signedIn, scope: "all", owner: false };
  return null;
}

// ------------------------------------------------------------ who paid

const ledgerKey = (store: Store, email: string) => `nl:learn:enr:${storeKey(store)}:${emailKey(email)}`;
const paidCacheKey = (store: Store, email: string) => `nl:learn:paid:${storeKey(store)}:${emailKey(email)}`;
const blockedKey = (courseId: string) => `nl:course:${courseId}:blocked`;

/** Written when a purchase is confirmed on the thanks page. */
export async function recordEnrollment(store: Store, email: string, productId: string, startSeconds: number): Promise<void> {
  if (!isRedisConfigured()) return;
  // Counted in the store's room at what it really adds: nothing for a course already there (lib/order-data.ts).
  await orderWrite(store, [
    ["HSETNX", ledgerKey(store, email), productId, String(Math.floor(startSeconds))],
    ["DEL", paidCacheKey(store, email)],
  ]);
}

/** Forgets Stripe's answer for one address, so its next page asks again: a membership switched to another tier (lib/tier-switch.ts). */
export async function forgetPaid(store: Store, email: string): Promise<void> {
  if (!isRedisConfigured()) return;
  await redisPipeline([["DEL", paidCacheKey(store, email)]]);
}

/**
 * Takes a course off an address's ledger: a gift, pre-order, group place or PayPal sale taken back by a refund. Both
 * replies are read exactly (CX-123 rule 24; Codex G on #2781): the HDEL and the DEL each answer 0 or 1, or this
 * throws UnknownReplyError, so the caller keeps the refund to be tried again and never reads "taken away" from a
 * reply it could not read. Running it again is harmless. With `startedAt`, only the course written down as begun then
 * (recordEnrollment's whole seconds) is taken off, so one a later purchase wrote with its own start is kept.
 */
export async function dropEnrollment(store: Store, email: string, productId: string, startedAt?: number): Promise<void> {
  if (!isRedisConfigured()) return;
  const ledger = ledgerKey(store, email);
  const replies = repliesFor(
    await redisPipeline([
      startedAt === undefined ? ["HDEL", ledger, productId] : ["EVAL", HDEL_IF_EQUAL, 1, ledger, productId, String(Math.floor(startedAt))],
      ["DEL", paidCacheKey(store, email)],
    ]),
    2,
  );
  if (!replies || !replies.every((reply) => reply === 0 || reply === 1)) throw new UnknownReplyError("taking a course off a ledger");
}

/**
 * Pages of a hundred checkouts read for one spelling of an address before its list is unknown: far past any buyer of
 * one store, and bounded (each one request to the creator's Stripe account, only for an address with more than a
 * hundred checkouts there, and the answer kept PAID_SECONDS).
 */
const PAID_PAGES = 3;

/** What Stripe says about one address's courses here. */
type Ledger = {
  /** Courses it may open, with when each began. */
  paid: Map<string, number>;
  /** Courses it had as a membership that has since ended. */
  ended: Set<string>;
  /**
   * Courses whose every purchase by this address was refunded in full. A
   * sale written down on the thanks page does not outlive its refund.
   */
  refunded: Set<string>;
  /**
   * Courses with a purchase refunded in full and another that stands: the start written down on the thanks page may
   * be the refunded one's, so the standing purchase's start counts (C7 courses hunt). Absent from a copy cached before.
   */
  again: Set<string>;
};

/** Asks the creator's Stripe account what this address paid for here. */
async function paidAtStripe(store: Store, email: string, exact = false): Promise<Ledger> {
  const found = new Map<string, number>();
  const ended = new Set<string>();
  const refunded = new Set<string>();
  const again = new Set<string>();
  const account = store.stripeAccountId;
  if (!account) return { paid: found, ended, refunded, again };
  const handles = saleHandles(store);
  const courses = new Map((await (exact ? readKindExact : readKind)(store, "course")).filter((p) => p.course).map((p) => [p.id, p]));
  if (courses.size === 0) return { paid: found, ended, refunded, again };

  // Stripe keeps the address as it was typed at checkout.
  const variants = [...new Set([email.trim(), normaliseEmail(email)])];
  for (const variant of variants) {
    const query = new URLSearchParams({ "customer_details[email]": variant, status: "complete", limit: "100" });
    query.append("expand[]", "data.subscription");
    query.append("expand[]", "data.subscription.latest_invoice");
    query.append("expand[]", "data.payment_intent.latest_charge");
    // In Stripe's exact list shape and to its end (CX-123 rules 24 and 30, lib/stripe-list.ts): a list in another
    // shape, a row not readable or more pages than PAID_PAGES is unknown and throws, never "no checkouts" (so never
    // "not refunded": a course written down on the thanks page and refunded since would open again on it).
    const rows: Record<string, unknown>[] = [];
    let after = "";
    for (let page = 0; ; page += 1) {
      if (page === PAID_PAGES) throw new StripeListUnreadable(`more than ${PAID_PAGES} pages of checkouts for one address`);
      if (after) query.set("starting_after", after);
      const listed = readStripePage(await onAccount("GET", account, `/checkout/sessions?${query}`));
      if (listed.unreadable) throw new StripeListUnreadable("a checkout not readable");
      rows.push(...listed.rows);
      if (!listed.hasMore) break;
      if (!listed.lastId) throw new StripeListUnreadable("more checkouts and no readable last one");
      after = listed.lastId;
    }
    for (const session of rows) {
      // A membership switched to another tier hands over what it is on now (lib/tier-rules.ts).
      const meta = currentMeta((session.metadata ?? {}) as Record<string, string>, session);
      if (!handles.has(meta.store ?? "")) continue;
      if (!isSettled(session)) continue;
      // The course bought, or a course in a bundle bought or ticked at
      // checkout (lib/bundle-rules.ts): each opens as if bought on its own.
      const bought = deliveredIds(meta)
        .map((id) => courses.get(id))
        .filter((p): p is Listing => Boolean(p));
      if (bought.length === 0) continue;
      // Refunded in full: the one rule every door uses (lib/refunds.ts).
      if (await purchaseRefunded(account, session)) {
        for (const product of bought) refunded.add(product.id);
        continue;
      }
      for (const product of bought) {
        // A course sold as a membership is open while the membership runs.
        if (product.id === meta.product && product.recurring && session.mode === "subscription" && meta.kind !== "plan") {
          const sub = session.subscription as { status?: unknown } | null;
          // The same rule as every other door a membership opens (lib/membership-access.ts).
          if (!sub || typeof sub !== "object" || !isLiveSub(sub)) {
            ended.add(product.id);
            continue;
          }
        }
        const created = typeof session.created === "number" ? session.created : Math.floor(Date.now() / 1000);
        const before = found.get(product.id);
        if (before === undefined || created < before) found.set(product.id, created);
      }
    }
  }
  // Joined again after it ended, or bought again after a refund: the
  // purchase that stands is what counts.
  for (const id of found.keys()) {
    ended.delete(id);
    if (refunded.delete(id)) again.add(id);
  }
  return { paid: found, ended, refunded, again };
}

/** When a course written down on the thanks page began: whole seconds from zero up, as recordEnrollment writes them; otherwise null. */
function wholeSeconds(value: unknown): number | null {
  if (typeof value === "number") return countOf(value);
  return typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : null;
}

/** The cached answer, in the shape written before ended memberships were kept too. */
function parseLedger(cached: string): Ledger | null {
  try {
    const value = JSON.parse(cached) as Record<string, unknown>;
    if (value && typeof value.p === "object" && value.p !== null) {
      return {
        paid: new Map(Object.entries(value.p as Record<string, number>)),
        ended: new Set(Array.isArray(value.x) ? (value.x as string[]) : []),
        refunded: new Set(Array.isArray(value.r) ? (value.r as string[]) : []),
        again: new Set(Array.isArray(value.a) ? (value.a as string[]) : []),
      };
    }
    return { paid: new Map(Object.entries(value as Record<string, number>)), ended: new Set(), refunded: new Set(), again: new Set() };
  } catch {
    return null;
  }
}

/**
 * The courses of this store this address may open, with when each began.
 * Memberships are always checked with Stripe; a one-off purchase recorded on
 * the thanks page is taken from our own record.
 */
export async function paidCourses(store: Store, email: string): Promise<Map<string, number>> {
  return (await courseLedger(store, email)).paid;
}

/**
 * The same, read exactly: it throws when Stripe, the address's own record, the
 * store's courses or the levels a community hands courses at do not read, so
 * a course that only Stripe knows of is never taken for one not bought (rule 24;
 * review of #3724). The course page keeps paidCourses and its own rule.
 */
export async function paidCoursesExact(store: Store, email: string): Promise<Map<string, number>> {
  return (await courseLedger(store, email, true)).paid;
}

/**
 * The same answer, with the memberships that ended kept apart, and the courses left shut only because Stripe's answer
 * could not be had whole (`undecided`): said to the student as "could not check", never as not bought. `exact` throws
 * where the lenient read goes on.
 */
async function courseLedger(store: Store, email: string, exact = false): Promise<Ledger & { undecided: Set<string>; unknown: boolean }> {
  const result = new Map<string, number>();
  if (!isRedisConfigured()) return { paid: result, ended: new Set(), refunded: new Set(), again: new Set(), undecided: new Set(), unknown: false };
  // A store that brought buyers over from another platform reads theirs in
  // the same round trip (lib/imported-purchases.ts); any other asks nothing more.
  const imported = importedRead(store, email);
  const commands: (string | number)[][] = [
    ["GET", paidCacheKey(store, email)],
    ["HGETALL", ledgerKey(store, email)],
    ...(imported ? [imported] : []),
  ];
  const replies = await redisPipeline(commands);
  if (exact && !repliesFor(replies, commands.length)) throw new UnknownReplyError("an address's course record");
  const [cached, ledger, broughtOver] = replies;
  // The exact read never takes the cached answer: the lenient read keeps it even when readKind left a listing out, so
  // it can lack a course only Stripe knows of (review of #3724). It asks Stripe itself, and keeps what it read whole.
  let asked: Ledger | null = !exact && typeof cached === "string" ? parseLedger(cached) : null;
  // Stripe's answer could not be had whole: which purchases were refunded is unknown, never "none" (CX-123 rule 24).
  // A course whose opening depends on that answer (a membership, or a one-off written down on the thanks page and
  // perhaps refunded since) is not opened on it, as the community and the downloads do; nothing is kept, so the next
  // page asks again. What does not depend on it (brought over from another platform, earned in the community) opens.
  let unknown = false;
  if (!asked) {
    try {
      asked = await paidAtStripe(store, email, exact);
      const kept = JSON.stringify({ p: Object.fromEntries(asked.paid), x: [...asked.ended], r: [...asked.refunded], a: [...asked.again] });
      await redisPipeline([["SET", paidCacheKey(store, email), kept, "EX", PAID_SECONDS]]);
    } catch (error) {
      if (exact) throw error;
      console.error("reading course purchases failed", error);
      asked = { paid: new Map(), ended: new Set(), refunded: new Set(), again: new Set() };
      unknown = true;
    }
  }
  const fromStripe = asked.paid;
  const recorded = new Map<string, number>();
  // Each course written down with when it began, in whole seconds (CX-123 rule 24): a value of another shape, or
  // fields and values that do not pair up, is unknown, never 0 (1970, every drip module open) or "not written down".
  const pairs: [unknown, unknown][] = [];
  if (Array.isArray(ledger)) {
    if (ledger.length % 2 !== 0) throw new UnknownReplyError("the courses written down for an address");
    for (let i = 0; i + 1 < ledger.length; i += 2) pairs.push([ledger[i], ledger[i + 1]]);
  } else if (ledger && typeof ledger === "object") {
    pairs.push(...Object.entries(ledger as Record<string, unknown>));
  } else if (exact && ledger !== null) {
    throw new UnknownReplyError("the courses written down for an address");
  }
  for (const [field, value] of pairs) {
    const began = wholeSeconds(value);
    if (typeof field !== "string" || began === null) throw new UnknownReplyError("the courses written down for an address");
    recorded.set(field, began);
  }

  // Brought over from another platform: the course itself, or a course in a
  // bundle that was. Nothing was paid through Stripe, so nothing there can
  // take it back; the creator can still take a student off (setBlocked).
  const given = new Map<string, number>();
  for (const purchase of importedFrom(broughtOver)) {
    for (const id of [purchase.productId, ...(purchase.items ?? [])]) {
      if (!given.has(id)) given.set(id, purchase.at);
    }
  }

  const courses = await (exact ? readKindExact : readKind)(store, "course");
  for (const product of courses) {
    if (!product.course) continue;
    // A one-off sale written down on the thanks page stands on its own,
    // unless Stripe now says it was refunded in full, or bought again after a
    // refund: then the purchase that stands says when it began.
    const start = unknown
      ? undefined
      : product.recurring || asked.refunded.has(product.id) || asked.again.has(product.id)
        ? fromStripe.get(product.id)
        : recorded.get(product.id) ?? fromStripe.get(product.id);
    const opens = start ?? (product.recurring ? undefined : given.get(product.id));
    if (opens !== undefined && Number.isFinite(opens)) result.set(product.id, opens);
  }

  // A course the creator hands over at a community level (lib/community-points.ts),
  // to a member who reached it. While the community is switched off nothing
  // new is handed over, and what already was stays.
  if (store.community?.id) {
    try {
      const earned = await earnedCourses(store.community.id, emailKey(email), Date.now(), store.community.on, store);
      for (const product of courses) {
        const at = earned.get(product.id);
        if (product.course && !result.has(product.id) && at !== undefined) result.set(product.id, at);
      }
    } catch (error) {
      if (exact) throw error;
      console.error("reading courses earned by level failed", error);
    }
  }

  // Shut only for want of Stripe's answer: Stripe alone might have opened it (a membership, a one-off bought, or written
  // down on the thanks page and perhaps refunded since). Known before anyone is taken off below, which stays "closed".
  const undecided = new Set(unknown ? courses.filter((p) => p.course && !result.has(p.id)).map((p) => p.id) : []);

  // A student the creator took off the course stays off it.
  const withCourse = [...result.keys()]
    .map((id) => courses.find((p) => p.id === id))
    .filter((p): p is Listing => Boolean(p?.course));
  if (withCourse.length) {
    const flags = repliesFor(await redisPipeline(withCourse.map((p) => ["SISMEMBER", blockedKey(p.course!.id), emailKey(email)])), withCourse.length);
    // One 0 or 1 for each course asked (CX-123 rule 24): any other reply is unknown, never "not taken off", so a
    // student the creator removed is never let back in on a reply that could not be read.
    const taken = flags?.map(countOf);
    if (!taken || taken.some((n) => n === null || n > 1)) throw new UnknownReplyError("whether a student was taken off a course");
    withCourse.forEach((p, i) => {
      if (taken[i] === 1) result.delete(p.id);
    });
  }
  return { paid: result, ended: asked.ended, refunded: asked.refunded, again: asked.again, undecided, unknown };
}

export type CourseAccess =
  | { state: "open"; learner: Learner; start: number }
  | { state: "preview"; learner: Learner | null }
  | { state: "closed"; learner: Learner | null }
  /** A membership that gave this course has ended: said as such, with the way back. */
  | { state: "ended"; learner: Learner }
  /**
   * Not open, because whether it opens could not be checked just now (Stripe's answer could not be had whole,
   * CX-123 rule 24): said as such, with a way to load the page again, never as not bought (lib/course-door.ts).
   */
  | { state: "unknown"; learner: Learner };

/** Whether this browser may take this course, and from when. */
export async function courseAccess(store: Store, product: Listing, cookies: CookieJar): Promise<CourseAccess> {
  const learner = await learnerFrom(store, cookies);
  if (!learner || !product.course) return { state: "closed", learner };
  if (learner.owner) return { state: "open", learner, start: Math.floor(Date.now() / 1000) - 400 * 86_400 };
  if (learner.scope !== "all" && !learner.scope.includes(product.course.id)) return { state: "closed", learner };
  const { paid, ended, undecided } = await courseLedger(store, learner.email);
  const start = paid.get(product.id);
  if (start !== undefined) return { state: "open", learner, start };
  if (undecided.has(product.id)) return { state: "unknown", learner };
  return ended.has(product.id) ? { state: "ended", learner } : { state: "closed", learner };
}

// ------------------------------------------------------------ progress

const studentsKey = (courseId: string) => `nl:course:${courseId}:students`;
const doneKey = (courseId: string, email: string) => `nl:course:${courseId}:done:${emailKey(email)}`;

/** Commands answering 1 when this learner (emailKey) has a student row or lessons done in a course: a dropped one's probe (lib/person-erasure.ts). */
export const learnerProbes = (courseId: string, learner: string): (string | number)[][] => [["HEXISTS", studentsKey(courseId), learner], ["EXISTS", `nl:course:${courseId}:done:${learner}`]];

/** A student's row: their address, when they began (`s`) and last came back (`l`); `i` once their drip pairs are in the store's index. */
type StudentRow = { e: string; s: number; l: number; i?: 1 };

/**
 * Notes that a student opened the course, keeping when they began. A new
 * student's row takes its room in the store's data room first
 * (lib/store-data.ts); when there is none it is not written, and the course
 * opens all the same: the row is what the studio shows, not their access.
 *
 * With `drip` (the course's outline and its product, which the course page has), the same write puts the student's
 * pairs in the store's drip index (dueKey, docs/drip-due-index.md): one ZADD of every module that
 * opens over time, scored when it opens for them, in the same pipeline as the row, its bytes taken from the room with
 * the row's (a full room writes neither). Once, marked on the row (`i`), and again when their start moves earlier.
 */
export async function touchStudent(
  courseId: string,
  email: string,
  startSeconds: number,
  room: DataStore,
  drip?: { course: Course; productId: string } | { card: DripCard },
): Promise<void> {
  if (!isRedisConfigured()) return;
  const key = studentsKey(courseId);
  const field = emailKey(email);
  const [raw] = await redisPipeline([["HGET", key, field]]);
  let row: StudentRow = { e: normaliseEmail(email), s: Math.floor(startSeconds), l: 0 };
  let indexed = false;
  if (typeof raw === "string") {
    try {
      const old = JSON.parse(raw) as StudentRow;
      const s = Math.min(old.s || row.s, row.s);
      indexed = old.i === 1 && old.s === s;
      row = { e: old.e || row.e, s, l: 0 };
    } catch {}
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  row.l = nowSeconds;
  // The course page hands the outline; the course start hands the kept card (dripCardFor), never the outline.
  const card = !drip ? null : "card" in drip ? drip.card : drip.course.id === courseId ? dripCardOf(drip.course, drip.productId) : null;
  const index = card && room.statsId && room.handle && !indexed ? { statsId: room.statsId, handle: room.handle, card } : null;
  const pairs = index ? duePairs(courseId, field, row.s, index.card, nowSeconds) : [];
  // Marked once its pairs are written, and kept marked by a visit that writes none (the course start, with no outline).
  if (index || indexed) row.i = 1;
  const json = JSON.stringify(row);
  const changes: DataChange[] = [
    ...(typeof raw !== "string" ? [{ slot: DONE_SLOT(courseId), bytes: dataBytes([field, json, "0000000000"], 1) }] : []),
    ...(index && pairs.length > 0 ? [...pairRoom(pairs), cardRoom(courseId, index.card)] : []),
  ];
  if (changes.length > 0 && !(await takeData(room, changes)).ok) {
    // A new row and its pairs together or neither; a row already kept is written without its pairs, and without its
    // mark, so a later visit tries them again.
    if (typeof raw !== "string") return;
    delete row.i;
    await redisPipeline([["HSET", key, field, JSON.stringify(row)]]);
    return;
  }
  const commands: Cmd[] = [["HSET", key, field, json]];
  if (index && pairs.length > 0) {
    commands.push(
      ["ZADD", dueKey(index.statsId), ...pairs.flatMap(([score, member]) => [score, member])],
      ["SADD", DRIP_STORES, `${index.statsId}|${index.handle}`],
      ["SET", cardKey(courseId), JSON.stringify(index.card), "NX"],
    );
  }
  await redisPipeline(commands);
}

/**
 * When one student began a course and last came back to it, in seconds; null
 * when they never opened it. For the buyer's page in the studio
 * (lib/buyer-profile.ts): one command.
 */
export async function studentDates(courseId: string, email: string): Promise<{ since: number; lastSeen: number } | null> {
  if (!isRedisConfigured()) return null;
  const reply = repliesFor(await redisPipeline([["HGET", studentsKey(courseId), emailKey(email)]]), 1);
  // Null is a student never seen; anything but null or a kept row with whole times is unknown, never "never
  // opened" (CX-123 rule 24).
  if (!reply) throw new UnknownReplyError("a student's course dates");
  if (reply[0] === null) return null;
  const row = studentTimes(reply[0]);
  if (!row) throw new UnknownReplyError("a student's course dates");
  return { since: row.s, lastSeen: row.l };
}

/**
 * Whether `raw` is the row the course keeps for `email`: JSON with both times as whole seconds and that address. Any
 * other value is not this learner's record, read as unknown by whoever asks (lib/student-bulk.ts accessStates; Codex G
 * on #3035, CX-123 rule 24), never as a student.
 */
export function isStudentRowOf(raw: unknown, email: string): boolean {
  const row = studentTimes(raw);
  return row !== null && typeof row.e === "string" && normaliseEmail(row.e) === normaliseEmail(email);
}

/** A kept student row's address (as kept) and times, only when the row is JSON with both times as whole seconds; otherwise null. */
function studentTimes(raw: unknown): { e: unknown; s: number; l: number } | null {
  if (typeof raw !== "string") return null;
  let row: unknown;
  try {
    row = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const { e, s, l } = row as Partial<StudentRow>;
  return countOf(s) === null || countOf(l) === null ? null : { e, s: s as number, l: l as number };
}

/**
 * When each of these students last opened a course (seconds), 0 for one who
 * never did. One command for them all, for the member scores in the studio
 * (lib/member-health.ts).
 */
export async function lastSeenMany(courseId: string, emails: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!emails.length || !isRedisConfigured()) return out;
  const rows = repliesFor(await redisPipeline([["HMGET", studentsKey(courseId), ...emails.map(emailKey)]]), 1)?.[0];
  // One value for each address, null for one never seen (0); a list of another length, or a value that is not a
  // kept row with whole times, is unknown, never "never seen" (CX-123 rule 24).
  if (!Array.isArray(rows) || rows.length !== emails.length) throw new UnknownReplyError("when students last opened a course");
  emails.forEach((email, i) => {
    if (rows[i] === null) return out.set(email, 0);
    const row = studentTimes(rows[i]);
    if (!row) throw new UnknownReplyError("when students last opened a course");
    out.set(email, row.l || row.s);
  });
  return out;
}

/**
 * The lessons one student marked done. An empty list is a student who marked
 * none; any other reply than one list of names is unknown, never "no lesson
 * done": it would refuse a finished student's certificate, show 0% and leave
 * the lessons out of the person's data copy (CX-123 rule 24).
 */
export async function doneLessons(courseId: string, email: string): Promise<Set<string>> {
  if (!isRedisConfigured()) return new Set();
  const names = stringList(repliesFor(await redisPipeline([["SMEMBERS", doneKey(courseId, email)]]), 1)?.[0]);
  if (!names) throw new UnknownReplyError("a student's lessons done");
  return new Set(names);
}

/** For a course page: the lessons done, or null when they could not be read just now, said as such on the page (rule 24). */
export async function doneLessonsOrUnknown(courseId: string, email: string): Promise<Set<string> | null> {
  try {
    return await doneLessons(courseId, email);
  } catch (error) {
    if (error instanceof UnknownReplyError) return null;
    throw error;
  }
}

/**
 * How far one person is in each of these courses, for their list of purchases
 * (560 [AS1]): the lessons done among the lessons each course has now, all in
 * one round trip. Each course asks only about its own lessons (SMISMEMBER),
 * so what comes back is one 0 or 1 a lesson, MAX_LESSONS at the most, however
 * many marks were kept for lessons since taken out. A course with no lessons
 * is left out: there is nothing to count. A reply that is not exactly one 0 or
 * 1 for each lesson asked is null for that course, said as "could not be
 * checked", never as 0 done (CX-123 rule 24).
 */
export async function lessonsDoneIn(courses: Course[], email: string): Promise<Map<string, { done: number; total: number } | null>> {
  const out = new Map<string, { done: number; total: number } | null>();
  const asked = courses.flatMap((course) => {
    const ids = lessonsInOrder(course).map(({ lesson }) => lesson.id);
    return ids.length ? [{ course, ids }] : [];
  });
  if (!asked.length || !isRedisConfigured()) return out;
  const rows = repliesFor(await redisPipeline(asked.map(({ course, ids }) => ["SMISMEMBER", doneKey(course.id, email), ...ids])), asked.length);
  asked.forEach(({ course, ids }, i) => {
    const flags = rows ? repliesFor(rows[i], ids.length) : null;
    if (!flags || flags.some((flag) => flag !== 0 && flag !== 1)) {
      out.set(course.id, null);
      return;
    }
    out.set(course.id, { done: flags.filter((flag) => flag === 1).length, total: ids.length });
  });
  return out;
}

/** Where lessons marked done are counted in the store's data room (lib/store-data.ts). */
const DONE_SLOT = (courseId: string) => `cd:${courseId}`;

/**
 * Marks a lesson done or not done. Done takes room in the store's data room
 * first (DataRoomError when it does not fit), unless `always`: what follows a
 * quiz passed or work handed in, which was taken already.
 */
export async function markLesson(courseId: string, email: string, lessonId: string, done: boolean, room: DataStore, always = false): Promise<void> {
  const bytes = dataBytes([lessonId], 1);
  if (done) {
    const [held] = await redisPipeline([["SISMEMBER", doneKey(courseId, email), lessonId]]);
    if (Number(held) === 1) return;
    if (always) await noteData(room, [{ slot: DONE_SLOT(courseId), bytes }]);
    else await needData(room, [{ slot: DONE_SLOT(courseId), bytes }]);
    await redisPipeline([["SADD", doneKey(courseId, email), lessonId]]);
    return;
  }
  const [removed] = await redisPipeline([["SREM", doneKey(courseId, email), lessonId]]);
  if (Number(removed) === 1) await giveData(room, [{ slot: DONE_SLOT(courseId), bytes }]);
}

/**
 * Where each of these addresses is in the course a product is: whether they
 * opened it, and whether every lesson it has now is marked done. For a
 * sequence's condition on a course (lib/flow-rules.ts): the course is read
 * once, and the whole batch in one round trip. Empty for a product that is
 * not a course.
 */
export async function courseProgress(store: Store, productId: string, emails: string[]): Promise<Map<string, { started: boolean; finished: boolean }>> {
  const out = new Map<string, { started: boolean; finished: boolean }>();
  if (!emails.length || !isRedisConfigured()) return out;
  const listing = await readListing(store, productId);
  const course = listing?.course ? await readCourse(listing.course.id) : null;
  if (!course) return out;
  const lessons = lessonsInOrder(course).map(({ lesson }) => lesson.id);
  const rows = repliesFor(
    await redisPipeline([["HMGET", studentsKey(course.id), ...emails.map(emailKey)], ...emails.map((email) => ["SMEMBERS", doneKey(course.id, email)])]),
    emails.length + 1,
  );
  // One row for each address (null for one who never opened the course) and one list of lessons done for each; any
  // other answer is unknown, never "not started" or "not finished": a workflow would send a student who finished the
  // "hasn't finished" email on a guess (CX-123 rule 24). Thrown, the workflow step is put back for a later run.
  const seen = rows ? repliesFor(rows[0], emails.length) : null;
  if (!rows || !seen) throw new UnknownReplyError("where students are in a course");
  emails.forEach((email, i) => {
    const row = seen[i];
    const names = stringList(rows[i + 1]);
    if ((row !== null && (typeof row !== "string" || !row)) || !names) throw new UnknownReplyError("where students are in a course");
    const done = new Set(names);
    out.set(email, {
      started: row !== null,
      finished: lessons.length > 0 && lessons.every((id) => done.has(id)),
    });
  });
  return out;
}

export type Student = {
  email: string;
  since: number;
  lastSeen: number;
  done: number;
  blocked: boolean;
};

/**
 * Everyone who has opened the course, with how far they got; null when Redis
 * answered in a shape that cannot be read (rule 24), so a page never says
 * "nobody" and the drip schedule never acts on an unknown list of blocked
 * students. Only Redis's own empty answer is none; a row that is itself not
 * JSON is skipped, as before.
 */
export async function studentsOf(course: Course, limit = 500): Promise<{ students: Student[]; total: number } | null> {
  if (!isRedisConfigured()) return { students: [], total: 0 };
  const replies = repliesFor(
    await redisPipeline([
      ["HGETALL", studentsKey(course.id)],
      ["SMEMBERS", blockedKey(course.id)],
    ]),
    2,
  );
  if (!replies) return null;
  const [raw, blockedRaw] = replies;
  const rows: StudentRow[] = [];
  const pairs: [string, string][] = [];
  // HGETALL answers a flat list of strings (the REST client and lib/redis-memory.ts alike); anything else is unknown.
  const flat = stringList(raw);
  if (!flat || flat.length % 2 !== 0) return null;
  for (let i = 0; i + 1 < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
  const blockedList = stringList(blockedRaw);
  if (!blockedList) return null;
  for (const [, value] of pairs) {
    try {
      rows.push(JSON.parse(value) as StudentRow);
    } catch {}
  }
  rows.sort((a, b) => b.l - a.l);
  const shown = rows.slice(0, limit);
  const lessonIds = new Set(lessonsInOrder(course).map(({ lesson }) => lesson.id));
  const done = shown.length ? repliesFor(await redisPipeline(shown.map((row) => ["SMEMBERS", doneKey(course.id, row.e)])), shown.length) : [];
  if (!done) return null;
  const doneLists = done.map(stringList);
  if (doneLists.some((list) => list === null)) return null;
  const blocked = new Set(blockedList);
  return {
    total: rows.length,
    students: shown.map((row, i) => ({
      email: row.e,
      since: row.s,
      lastSeen: row.l,
      done: (doneLists[i] as string[]).filter((id) => lessonIds.has(id)).length,
      blocked: blocked.has(emailKey(row.e)),
    })),
  };
}

/**
 * One page of a course's students, for the API (lib/api-read.ts): about
 * `count` rows from `cursor`, in the order Redis keeps them, and how many
 * there are in all. What each marked done and whether each is blocked is read
 * only after `allow` said yes to the page's size (its rows, and how many are
 * blocked in all), so what that reading costs can be taken first; null when
 * it said no, with nothing more read. The blocked list is read whole up to
 * BLOCKED_READ_MAX, past it one question a student. Null too when the counts
 * did not come back: unknown is never read as small.
 */
export async function studentPage(
  course: Course,
  cursor: string,
  count: number,
  allow: (rows: number, blocked: number) => Promise<boolean>,
): Promise<{ students: Student[]; total: number; next: string } | null> {
  if (!isRedisConfigured()) return { students: [], total: 0, next: "0" };
  const [reply, total, blockedCount] = await redisPipeline([
    ["HSCAN", studentsKey(course.id), cursor, "COUNT", count],
    ["HLEN", studentsKey(course.id)],
    ["SCARD", blockedKey(course.id)],
  ]);
  const blockedAll = countOf(blockedCount);
  // HLEN and SCARD in their exact shape (CX-123 rule 24): an unknown number of students is never 0.
  const students = countOf(total);
  if (!Array.isArray(reply) || reply.length !== 2 || typeof reply[0] !== "string" || blockedAll === null || students === null) return null;
  // The page in its exact shape (Codex G on #2717, CX-123 rule 24): field and row in pairs, each row a kept one with
  // its address and whole times. A page of another shape is unknown, never fewer students.
  const flat = stringList(reply[1]);
  if (!flat || flat.length % 2 !== 0) return null;
  const rows: StudentRow[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const row = studentTimes(flat[i + 1]);
    if (!row || typeof row.e !== "string" || !row.e) return null;
    rows.push({ e: row.e, s: row.s, l: row.l });
  }
  // Accepted race: the blocked list can grow between SCARD and SMEMBERS and be read past what was paid for,
  // bounded by how fast the store blocks students.
  if (!(await allow(rows.length, blockedAll))) return null;
  const whole = blockedAll <= BLOCKED_READ_MAX;
  const blockedReads: (string | number)[][] =
    blockedAll === 0 ? [] : whole ? [["SMEMBERS", blockedKey(course.id)]] : rows.map((row) => ["SISMEMBER", blockedKey(course.id), emailKey(row.e)]);
  const reads = rows.length ? [...rows.map((row) => ["SMEMBERS", doneKey(course.id, row.e)]), ...blockedReads] : [];
  const replies = reads.length ? repliesFor(await redisPipeline(reads), reads.length) : [];
  if (!replies) return null;
  // Each done list a list of lesson ids, the blocked list a list of ids, each answer past it 0 or 1 (CX-123 rule 24):
  // an unknown one is never 0 lessons or "not blocked", it leaves the whole page unknown.
  const done = rows.map((_, i) => stringList(replies[i]));
  if (done.some((list) => list === null)) return null;
  // A page with no rows asked nothing more (Codex G, review 5793946540): nothing is waited on for it.
  const blockedList = rows.length && blockedAll > 0 && whole ? stringList(replies[rows.length]) : [];
  if (!blockedList) return null;
  const answers = blockedAll > 0 && !whole ? rows.map((_, i) => countOf(replies[rows.length + i])) : [];
  if (answers.some((n) => n === null || n > 1)) return null;
  const blockedSet = new Set(blockedList);
  const lessonIds = new Set(lessonsInOrder(course).map(({ lesson }) => lesson.id));
  return {
    total: students,
    next: reply[0],
    students: rows.map((row, i) => ({
      email: row.e,
      since: row.s,
      lastSeen: row.l,
      done: (done[i] as string[]).filter((id) => lessonIds.has(id)).length,
      blocked: blockedAll === 0 ? false : whole ? blockedSet.has(emailKey(row.e)) : answers[i] === 1,
    })),
  };
}

/** Takes a student off a course, or lets them back on. */
export async function setBlocked(store: Store, courseId: string, email: string, blocked: boolean): Promise<void> {
  await redisPipeline([
    [blocked ? "SADD" : "SREM", blockedKey(courseId), emailKey(email)],
    ["DEL", paidCacheKey(store, email)],
  ]);
}

// ------------------------------------------------------------ media

/** A link the browser can play or fetch straight from storage, for a while. */
export async function signedMedia(file: ProductFile, seconds: number): Promise<string | null> {
  try {
    // Played in the page, so not saved under a name: whichever store keeps it.
    const url = await fileUrl(file.pathname, seconds);
    if (!url) return null;
    await recordDelivery(file.pathname, file.bytes);
    return url;
  } catch (error) {
    console.error("signing a lesson video failed", error);
    return null;
  }
}

/**
 * What a lesson page shows for the lesson's video.
 *
 *   file       the file as it was uploaded, from the private store
 *   stream     the video service's player, in the video's own shape
 *   preparing  the service has the file and no size of it is ready yet
 *   failed     the service could make nothing of the file
 *   paused     the store has no plan an hour of video can be charged to, and
 *              has been watched for all the hours it may be this month
 */
export type LessonVideo =
  | { kind: "file"; src: string }
  | { kind: "stream"; src: string; width: number; height: number }
  | { kind: "preparing" }
  | { kind: "failed" }
  | { kind: "paused" }
  // A preview played free, paused with the store's other free copies (lib/serve-file.ts freeDeliveryPause),
  // whatever the plan: never told as the no-plan hours being used up.
  | { kind: "free_paused" };

/**
 * The video of a lesson, for somebody who may watch it; null when it cannot
 * be reached just now.
 *
 * One kept by the video service (lib/stream.ts) is framed with a token for
 * a few hours, and its store is put in line to have its watching measured
 * (lib/watch.ts): what a plan covers of video is the time it was watched,
 * by the service's own count, and never how often a page was opened. Any
 * other is the signed link it has always been.
 *
 * Stream playback requires a finite explicit monthly watched-time threshold,
 * including for paid plans. Missing, invalid or unreadable limits never mint
 * a player token. This meter does not bound provider bytes, replay or buffering.
 */
export async function lessonVideo(file: ProductFile, limit: number | null = null, window: string | null = calendarWindow().id, store?: Store, { free = false }: { free?: boolean } = {}): Promise<LessonVideo | null> {
  // The creator contract funds each new media admission before signing a URL or querying a player.
  if (store?.period?.funded === true && !(await reservePaidResourceWindow(store))) return null;
  if (!isStreamPath(file.pathname)) {
    // A preview played to somebody who does not hold the course is a free copy of the file: it pauses with the
    // store's other free downloads (lib/serve-file.ts), and a count that cannot be read signs nothing (rule 24).
    if (free) {
      const folder = folderFromPathname(file.pathname);
      const pause = folder ? await freeDeliveryPause(folder) : "open";
      if (pause === "over") return { kind: "free_paused" };
      if (pause === "unknown") return null;
    }
    const src = await signedMedia(file, VIDEO_URL_SECONDS);
    return src ? { kind: "file", src } : null;
  }
  try {
    const folder = folderFromPathname(file.pathname);
    // Counted in the store's window (lib/allowance-window.ts): none known, no player.
    if (limit === null || !Number.isSafeInteger(limit) || limit < 0 || !folder || !window) return null;
    const watched = await watchedForAdmission(folder, window);
    if (watched === null) return null;
    if (watched >= limit) return { kind: "paused" };
    const player = await playerFor(file.pathname);
    if (!player) return null;
    if (player.state === "failed") return { kind: "failed" };
    if (!player.src) return { kind: "preparing" };
    if (folder) await opened(folder);
    return { kind: "stream", src: player.src, width: player.width, height: player.height };
  } catch (error) {
    console.error("reading a lesson's video failed", error);
    return null;
  }
}

// ------------------------------------------------------------ emailed links

type LinkGrant = { e: string; k: string; h: string; p: string };
const linkKey = (token: string) => `nl:learn:link:${sha(token)}`;
const opensKey = (token: string) => `nl:learn:link:${sha(token)}:opens`;

function displayName(name: string): string {
  return name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 60) || "A store";
}

/** The From line of every email sent for a store's courses. */
export function courseSender(store: Store): string {
  return `"${displayName(store.name)} via Marktmorgen" <${senderAddress()}>`;
}

/** A student's own address, as they gave it, by the key of it; null if they never opened the course. */
export async function studentEmail(courseId: string, key: string): Promise<string | null> {
  if (!isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["HGET", studentsKey(courseId), key]]);
  if (typeof raw !== "string") return null;
  try {
    const row = JSON.parse(raw) as StudentRow;
    return typeof row.e === "string" && row.e ? row.e : null;
  } catch {
    return null;
  }
}

function senderAddress(): string {
  const match = NIMBUS_FROM.match(/<([^>]+)>/);
  return (match ? match[1] : NIMBUS_FROM).trim();
}

async function within(key: string, limit: number): Promise<boolean> {
  // A count in any other shape is unknown (CX-123 rule 24): no course link is emailed on it.
  const count = windowCountOf(await redisPipeline(windowCount(key, RATE_WINDOW_SECONDS)));
  return count !== null && count <= limit;
}

export type LinkRequest = "sent" | "email" | "limited" | "error";

/**
 * Emails a way into the course, when the address bought it. "sent" either
 * way: only whoever reads the inbox learns whether it had.
 */
export async function requestCourseLink(input: {
  store: Store;
  product: Listing;
  email: string;
  ip: string;
  origin: string;
}): Promise<LinkRequest> {
  const { store, product, ip, origin } = input;
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  if (!isRedisConfigured() || !product.course) return "error";
  if (!(await within(`nl:learn:rate:ip:${sha(`${ip}|${store.handle}`).slice(0, 32)}`, IP_LIMIT))) return "limited";
  if (!(await within(`nl:learn:rate:addr:${emailKey(raw)}`, ADDRESS_LIMIT))) return "limited";
  // A global known refusal must not reveal course ownership or consume a link.
  // False is unknown; the original rights and final sender checks still apply.
  if (serviceMailKnownUnavailable()) return "error";

  const { paid, unknown } = await courseLedger(store, raw);
  // Stripe's answer could not be had whole (courseLedger): whether this address bought the course is unknown, so the
  // request is said as not sent, never "sent" with no link sent, which would leave a buyer who paid waiting for an
  // email that never comes. "error" for every address, whatever it bought, so it says nothing about who bought what.
  if (unknown) return "error";
  if (!paid.has(product.id)) return "sent";
  return (await sendCourseLink(store, product, raw, origin)) ? "sent" : "error";
}

/** Sends the link itself. Also used when a buyer pays in another browser. */
export async function sendCourseLink(store: Store, product: Listing, email: string, origin: string): Promise<boolean> {
  if (serviceMailKnownUnavailable()) return false;
  const token = randomBytes(32).toString("hex");
  const grant: LinkGrant = { e: normaliseEmail(email), k: storeKey(store), h: store.handle, p: product.id };
  await redisPipeline([["SET", linkKey(token), JSON.stringify(grant), "EX", LINK_SECONDS]]);
  const link = `${origin}/api/store/course/open?token=${token}`;
  // In the store's language (lib/buyer-words/courses.ts).
  const w = coursesWords(store.language);
  return sendEmail({ meter: { by: "store", store: store, kind: "transactional" },
    from: `"${displayName(store.name)} via Marktmorgen" <${senderAddress()}>`,
    to: email,
    subject: w.courseSubject(product.title).slice(0, 200),
    text: [w.courseLead(product.title), "", link, "", w.courseDevice, "", w.courseHour, "", w.sentBy(store.name)].join("\n"),
  });
}

/** Spends one open of an emailed link, and says who and what it was for. */
export async function openCourseLink(token: string): Promise<LinkGrant | null> {
  if (!TOKEN_PATTERN.test(token) || !isRedisConfigured()) return null;
  const replies = await redisPipeline([["GET", linkKey(token)], ...windowCount(opensKey(token), LINK_SECONDS)]);
  const raw = repliesFor(replies, 3)?.[0];
  // The opens in their exact shape (CX-123 rule 24): an unknown count opens nothing.
  const opens = windowCountOf(replies, 1, 3);
  if (typeof raw !== "string" || opens === null || opens > MAX_LINK_OPENS) return null;
  try {
    const grant = JSON.parse(raw) as LinkGrant;
    return typeof grant.e === "string" && typeof grant.h === "string" && typeof grant.p === "string" ? grant : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ drip emails

/**
 * The old global set of drip courses (`course|handle|product`), read only to move each course into its store's pending
 * set (the migration; docs/drip-due-index.md). Nothing adds to it any more.
 */
const DRIP_SET = "nl:courses:drip";
/** The stores with a drip index (`statsId|handle`): the run's only global read besides the old set and its cursor. */
const DRIP_STORES = "nl:drip:stores";
/**
 * Where the next run starts when a run's deadline stopped it: the store it stopped at (`{ s }`), so the stores after it
 * are not always the ones left for later. Gone after a run that reached every store, and in thirty days by itself.
 */
const DRIP_CURSOR = "nl:drip:cursor";
const DRIP_CURSOR_SECONDS = 30 * 86_400;
/** A store's sorted set of the pairs that fall due: member `course|emailKey|module`, score when the module opens for them. */
const dueKey = (statsId: string) => `nl:drip:due:${statsId}`;
/** A course's drip card: its product, its cohort start and the modules that open over time (id, title, days, lessons). */
const cardKey = (courseId: string) => `nl:drip:card:${courseId}`;
/** A store's courses waiting to be walked into its index (`course|handle|product`): a new schedule, or the migration. */
const pendingKey = (statsId: string) => `nl:drip:pending:${statsId}`;
/** Where each pending course's walk stopped, a field a course: the next page of its students. */
const walkKey = (statsId: string) => `nl:drip:walk:${statsId}`;
/** A course's card in the store's data room. */
const CARD_SLOT = (courseId: string) => `dc:${courseId}`;
/** Students read at a time (HSCAN COUNT, a hint): every one of them is read, page after page, never a first few thousand. */
const DRIP_PAGE = 200;
/** How long a run goes on when its caller gives no deadline; the route gives its own (app/api/cron/courses). */
const DRIP_RUN_MS = 40_000;
/** A pair's window: a module that opened more than three days ago is never emailed about, so a new module does not email about months gone by. */
const DRIP_WINDOW_SECONDS = 3 * 86_400;
/**
 * The ceiling on a run's marks before they are spent (the MR rule; found under Claude 7's MÉDIO on #3344): a mark is a
 * SET NX for each pair due, and a send that does not go lets it go. A run stops trying a course's pairs after
 * DRIP_REFUSALS_PER_COURSE sends that did not go, and a store's after DRIP_REFUSALS_PER_STORE, until the next run: the
 * rest wait in the index inside the same three-day window, never sent twice.
 */
export const DRIP_REFUSALS_PER_COURSE = 3;
/**
 * The same ceiling for a whole store in a run: five sends that did not go in a day already say the store's sends are
 * not going (its email figure spent, or the provider refusing). A course with refusals does not hold back the store's
 * other courses: the per-course ceiling stops that course and the run goes on to the next pair of another course; only
 * this one stops the store, for this run.
 */
export const DRIP_REFUSALS_PER_STORE = 5;
/**
 * The pages of students a store's walk into its index reads a run (a course whose schedule changed, or one of the old
 * set): a page is DRIP_PAGE students, read once and written as their pairs. A course larger than this many pages a run
 * is walked over several runs from where it stopped; the store's other courses wait their turn. Its cost is a line of
 * every plan (tests/plan-cost-registry.ts, course-drip-run).
 */
export const DRIP_INDEX_PAGES_PER_RUN = 8;
/** The pairs a store's walk writes a run before it stops at the next page (a page itself is written whole). */
export const DRIP_INDEX_PAIRS_PER_RUN = 4_000;
/** The runs inside a pair's window: what a store's email figure is spread over (dripIndexEntriesPerRun). */
export const DRIP_WINDOW_RUNS = 3;

/**
 * The pairs due that a store's run reads at most: a third of the store's email figure a month (lib/store-allowance-
 * rules.ts), so a whole month's emails fit inside one pair's three-day window. Each costs its row, its blocked check
 * and its mark (tests/plan-cost-registry.ts, course-drip-run); what is due past it waits for the next run.
 */
export function dripIndexEntriesPerRun(store: Parameters<typeof allowanceFor>[0], nowSeconds = Date.now() / 1000): number {
  return Math.max(0, Math.ceil(allowanceFor(store, "email", nowSeconds) / DRIP_WINDOW_RUNS));
}

type Cmd = (string | number)[];
const dripMailKey = (courseId: string, email: string, moduleId: string) =>
  `nl:course:${courseId}:dripmail:${emailKey(email)}:${moduleId}`;

/** A course's drip card as kept: product `p`, cohort start `s`, modules `m` ([id, title, days, lessons]), schedule `g`. */
export type DripCard = { p: string; s: number | null; m: [string, string, number, number][]; g: string };

/** The card of a course, or null when nothing in it opens over time. */
function dripCardOf(course: Course, productId: string): DripCard | null {
  const dripping = course.modules.filter((m) => m.dripDays > 0);
  if (dripping.length === 0) return null;
  // The schedule alone: what moves a pair's score. A new title or lesson does not walk the course again.
  const g = JSON.stringify([course.startsAt, dripping.map((m) => [m.id, m.dripDays])]);
  return { p: productId, s: course.startsAt, m: dripping.map((m) => [m.id, m.title, m.dripDays, m.lessons.length]), g };
}

/** A kept card, exactly: null for none, "unknown" for anything that is not one this code writes (rule 24). */
function readCard(reply: unknown): DripCard | null | "unknown" {
  if (reply === null) return null;
  if (typeof reply !== "string") return "unknown";
  try {
    const card = JSON.parse(reply) as Partial<DripCard>;
    const modules = Array.isArray(card.m) ? card.m : null;
    const ok =
      typeof card.p === "string" && (card.s === null || countOf(card.s) !== null) && typeof card.g === "string" && modules !== null &&
      modules.every((m) => Array.isArray(m) && m.length === 4 && typeof m[0] === "string" && typeof m[1] === "string" && countOf(m[2]) !== null && countOf(m[3]) !== null);
    return ok ? (card as DripCard) : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * A course's kept drip card, read on its own (one GET of a few KB, never the outline), for the course start
 * (app/api/store/course/start): a student who starts there and never loads the course page still gets their pairs.
 * Null when the course has none; "unknown" for a reply it cannot read (rule 24), which writes no pair.
 */
export async function dripCardFor(courseId: string): Promise<DripCard | null | "unknown"> {
  if (!isRedisConfigured()) return null;
  const replies = repliesFor(await redisPipeline([["GET", cardKey(courseId)]]).catch(() => null), 1);
  return replies ? readCard(replies[0]) : "unknown";
}

/** A module of a card as the outline's, for opensAt and the email. */
function cardModule(row: [string, string, number, number]): CourseModule {
  return { id: row[0], title: row[1], dripDays: row[2], lessons: Array.from({ length: row[3] }, () => null as never) };
}

/** A student's pairs not yet past their window, [score, member], one a module of the card. */
function duePairs(courseId: string, field: string, start: number, card: DripCard, nowSeconds: number): [number, string][] {
  return card.m
    .map((row): [number, string] => [opensAt({ startsAt: card.s }, cardModule(row), start), `${courseId}|${field}|${row[0]}`])
    .filter(([score]) => score >= nowSeconds - DRIP_WINDOW_SECONDS);
}

/**
 * The room a list of pairs takes, each counted until its window is over (lib/store-data.ts, `until`): one change a
 * month, so the run that removes them is never needed to give the room back.
 */
function pairRoom(pairs: [number, string][]): DataChange[] {
  const months = new Map<string, { until: number; bytes: number }>();
  for (const [score, member] of pairs) {
    const until = (score + DRIP_WINDOW_SECONDS + 86_400) * 1000;
    const month = new Date(until).toISOString().slice(0, 7);
    const held = months.get(month) ?? { until, bytes: 0 };
    held.until = Math.max(held.until, until);
    held.bytes += dataBytes([member, String(score)], 1);
    months.set(month, held);
  }
  return [...months.values()];
}

/** A course's card in the room, its slot set to the card's bytes. */
function cardRoom(courseId: string, card: DripCard): DataChange {
  return { slot: CARD_SLOT(courseId), bytes: dataBytes([cardKey(courseId), JSON.stringify(card)], 1), set: true };
}

/**
 * Keeps this course's drip card for the daily job, and when its schedule changed (a module that opens over time added,
 * removed or moved, its cohort's start set or moved), puts it in its store's pending set: the next runs walk its
 * students into the index again. A course with nothing that opens over time has no card and no pairs read.
 */
export async function registerDrip(store: Store, product: Listing, course: Course): Promise<void> {
  if (!isRedisConfigured()) return;
  const member = `${course.id}|${store.handle}|${product.id}`;
  const card = dripCardOf(course, product.id);
  if (!card) {
    // Nothing opens over time: no card (its pairs left in the index are dropped as the run reads them), nothing pending.
    const commands: Cmd[] = [["DEL", cardKey(course.id)], ["SREM", DRIP_SET, member]];
    if (store.statsId) commands.push(["SREM", pendingKey(store.statsId), member], ["HDEL", walkKey(store.statsId), course.id]);
    await redisPipeline(commands);
    await giveData(store, [{ slot: CARD_SLOT(course.id), bytes: 0, set: true }]);
    return;
  }
  // The store's index is kept under its statsId: a store written before there was one is given it here, from its studio.
  const statsId = store.statsId ?? (await ensureStatsId(storeRef(store)))?.statsId ?? null;
  if (!statsId) throw new Error("the store's drip index could not be named");
  const json = JSON.stringify(card);
  const before = readCard(repliesFor(await redisPipeline([["GET", cardKey(course.id)]]), 1)?.[0]);
  const changed = before === null || before === "unknown" || before.g !== card.g || before.p !== card.p;
  await noteData(store, [cardRoom(course.id, card)]);
  await redisPipeline([
    ["SET", cardKey(course.id), json],
    ["SREM", DRIP_SET, member],
    ...(changed ? [["SADD", pendingKey(statsId), member], ["SADD", DRIP_STORES, `${statsId}|${store.handle}`], ["HDEL", walkKey(statsId), course.id]] : []),
  ] as Cmd[]);
}

/**
 * What a run did: `sent` emails; `courses` walked into their store's index to their last student; `failed` stores or
 * courses that could not be read or threw, logged and tried again the next run (never taken out); `pending` stores the
 * deadline left for the next run, which starts with them; `unreadStudents` rows of a student that are not a student's
 * record, logged, never read as "nobody to email"; `held` stores whose pairs due a ceiling of refused sends or the
 * deadline left for the next run;
 * `indexed` pairs written by the walk; `dropped` pairs taken out of the index unsent (past their window, a module or a
 * course gone, a student blocked or gone).
 */
export type DripCounts = { sent: number; courses: number; failed: number; pending: number; unreadStudents: number; held: number; indexed: number; dropped: number };

/** The cursor as kept: our own `{ s }`, null when there is none. A reply of another shape is unknown (rule 24). */
function dripCursor(reply: unknown): string | null {
  if (reply === null) return null;
  if (typeof reply !== "string") throw new UnknownReplyError("where the drip emails' last run stopped");
  try {
    const kept = JSON.parse(reply) as { s?: unknown };
    if (typeof kept.s === "string") return kept.s;
  } catch {}
  // Our own text, not in our shape: only where to start is lost, never an email; it starts at the first store.
  console.error("the drip emails' cursor is not one this job writes; this run starts at the first store");
  return null;
}

/**
 * Tells each student when a module opens for them. Once per student and module, and only for modules that opened in
 * the last three days.
 *
 * From each store's index (docs/drip-due-index.md): the run reads only the pairs due now, at most
 * dripIndexEntriesPerRun(store) a store, so its cost follows the store's email figure, never its courses or students.
 * Courses whose schedule changed, and the courses of the old global set, are walked into the index first,
 * DRIP_INDEX_PAGES_PER_RUN pages a store a run.
 *
 * Bounded and fair: nothing new starts after `deadline`, and the next run starts at the store this one stopped at. A
 * store or a course that throws is counted and logged and the rest go on; it is tried again the next run. `load` and
 * `loadCourse` answer null only for a store or a course confirmed absent, and throw when they cannot tell (the route
 * passes the exact readers): only a confirmed absence takes anything out.
 */
export async function sendDripEmails(
  load: (handle: string) => Promise<Store | null>,
  loadCourse: (id: string) => Promise<Course | null>,
  origin: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  deadline = Date.now() + DRIP_RUN_MS,
  loadCourses?: (ids: string[]) => Promise<Map<string, Course | null | "unknown">>,
): Promise<DripCounts> {
  const counts: DripCounts = { sent: 0, courses: 0, failed: 0, pending: 0, unreadStudents: 0, held: 0, indexed: 0, dropped: 0 };
  if (!isRedisConfigured()) return counts;
  // A store read once a run: its record is read whole (lib/store-exact.ts).
  const stores = new Map<string, Promise<Store | null>>();
  const loadOnce = (handle: string) => {
    if (!stores.has(handle)) stores.set(handle, load(handle));
    return stores.get(handle)!;
  };
  // Each set in its exact shape (CX-123 rule 24): a reply of another shape is unknown, never "no course", "no store".
  const replies = repliesFor(await redisPipeline([["SMEMBERS", DRIP_SET], ["SMEMBERS", DRIP_STORES], ["GET", DRIP_CURSOR]]), 3);
  const old = stringList(replies?.[0]);
  const listed = stringList(replies?.[1]);
  if (!replies || !old || !listed) throw new UnknownReplyError("the stores with drip emails");
  const cursor = dripCursor(replies[2]);
  const members = new Set(listed);
  // The migration: each course of the old set into its store's pending set, then out of the old set.
  if (old.length > 0) for (const member of await migrateDrip(old, loadOnce, counts)) members.add(member);
  const order = [...members].sort();
  const first = cursor ? Math.max(0, order.findIndex((member) => member >= cursor)) : 0;
  let stopped: string | null = null;
  for (let i = 0; i < order.length; i += 1) {
    const member = order[(first + i) % order.length];
    if (Date.now() >= deadline) {
      stopped = member;
      counts.pending = order.length - i;
      break;
    }
    try {
      await dripStore(member, { load: loadOnce, loadCourse, loadCourses, origin, nowSeconds, deadline, counts });
    } catch (error) {
      // Rule 24: unknown is never "gone": the store keeps its index and is read again tomorrow.
      counts.failed += 1;
      console.error("a store's drip emails failed; it is tried again the next run", member.split("|")[0], error);
    }
  }
  // Only where to start next is written: a write that does not land starts the next run where this one started.
  const write: Cmd | null = stopped ? ["SET", DRIP_CURSOR, JSON.stringify({ s: stopped }), "EX", DRIP_CURSOR_SECONDS] : cursor ? ["DEL", DRIP_CURSOR] : null;
  if (write) {
    const kept = await redisPipeline([write]).then((r) => repliesFor(r, 1), () => null);
    if (!kept || (stopped ? kept[0] !== "OK" : countOf(kept[0]) === null)) console.error("where the drip emails' run stopped could not be confirmed kept");
  }
  return counts;
}

/**
 * Moves the old set's courses (`course|handle|product`) into their stores' pending sets: a store confirmed gone takes
 * its courses out; one that cannot be read keeps them in the old set for the next run. Answers the stores' members.
 */
async function migrateDrip(old: string[], load: (handle: string) => Promise<Store | null>, counts: DripCounts): Promise<string[]> {
  const byHandle = new Map<string, string[]>();
  for (const member of old) {
    const handle = member.split("|")[1] ?? "";
    byHandle.set(handle, [...(byHandle.get(handle) ?? []), member]);
  }
  const added: string[] = [];
  for (const [handle, courses] of byHandle) {
    try {
      const store = handle ? await load(handle) : null;
      if (!store) {
        await redisPipeline([["SREM", DRIP_SET, ...courses]]);
        continue;
      }
      const statsId = store.statsId ?? (await ensureStatsId(storeRef(store)))?.statsId ?? null;
      if (!statsId) throw new UnknownReplyError("a drip store's statsId");
      const storeMember = `${statsId}|${store.handle}`;
      const done = repliesFor(await redisPipeline([["SADD", pendingKey(statsId), ...courses], ["SADD", DRIP_STORES, storeMember]]), 2);
      if (!done || done.some((reply) => countOf(reply) === null)) throw new UnknownReplyError("a drip store's pending courses");
      // Out of the old set only once they are confirmed in the pending one.
      await redisPipeline([["SREM", DRIP_SET, ...courses]]);
      added.push(storeMember);
    } catch (error) {
      counts.failed += 1;
      console.error("a store's drip courses could not be moved to its index; they stay for the next run", handle, error);
    }
  }
  return added;
}

type DripRun = {
  load: (handle: string) => Promise<Store | null>;
  loadCourse: (id: string) => Promise<Course | null>;
  loadCourses?: (ids: string[]) => Promise<Map<string, Course | null | "unknown">>;
  origin: string;
  nowSeconds: number;
  deadline: number;
  counts: DripCounts;
};

/** One store's run: its pending courses walked into its index, then its pairs due read and emailed. */
async function dripStore(storeMember: string, run: DripRun): Promise<void> {
  const [statsId, handle] = storeMember.split("|");
  const store = statsId && handle ? await run.load(handle) : null;
  if (!store || store.statsId !== statsId) {
    // Confirmed: no store under this address, or another store's now. Its index stays with its statsId, read again
    // under the store's new address once a student or a course puts it back.
    await redisPipeline([["SREM", DRIP_STORES, storeMember]]);
    return;
  }
  const pending = stringList(repliesFor(await redisPipeline([["SMEMBERS", pendingKey(statsId)]]), 1)?.[0]);
  if (!pending) throw new UnknownReplyError("a drip store's pending courses");
  let left = pending.length;
  if (pending.length > 0) left = await walkPending(store, statsId, [...pending].sort(), run);
  await sendDue(store, statsId, storeMember, left, run);
}

/**
 * Walks a store's pending courses into its index, DRIP_INDEX_PAGES_PER_RUN pages of students a run at the most, each
 * course from where its walk stopped. A course is taken out of the pending set once read to its last student; one
 * whose room cannot take its pairs, or that cannot be read, stays for the next run. Answers the courses still pending.
 */
async function walkPending(store: Store, statsId: string, pending: string[], run: DripRun): Promise<number> {
  const { counts } = run;
  let budget = DRIP_INDEX_PAGES_PER_RUN;
  let pairsWritten = 0;
  let left = pending.length;
  const some = pending.slice(0, budget);
  const ids = some.map((member) => member.split("|")[0]);
  const read = repliesFor(await redisPipeline([["MGET", ...ids.map(cardKey)], ["HMGET", walkKey(statsId), ...ids]]), 2);
  const cards = listSlots(read?.[0]);
  const walks = listSlots(read?.[1]);
  if (!read || !cards || !walks || cards.length !== ids.length || walks.length !== ids.length) throw new UnknownReplyError("a drip store's pending cards");
  // The outlines of the courses with no card yet (the old set's), a hundred at a command when the caller can
  // (readCoursesEach): an entry missing, or a read that fails whole, is unknown for this run, never "gone".
  const cardless = ids.filter((_, n) => cards[n] === null);
  const outlines = new Map<string, Promise<Course | null | "unknown">>();
  if (cardless.length > 0 && run.loadCourses) {
    const batch = run.loadCourses(cardless).catch(() => null);
    for (const id of cardless) outlines.set(id, batch.then((map) => (map && map.has(id) ? (map.get(id) as Course | null | "unknown") : "unknown")));
  }
  for (let n = 0; n < some.length && budget > 0; n += 1) {
    if (Date.now() >= run.deadline) break;
    const member = some[n];
    const [courseId, , productId] = member.split("|");
    try {
      let card = readCard(cards[n]);
      if (card === "unknown") throw new UnknownReplyError("a drip course's card");
      if (card === null) {
        // A course of the old set, with no card yet: its outline read once, its card written (a page of the budget).
        budget -= 1;
        const course = await (outlines.get(courseId) ?? run.loadCourse(courseId));
        if (course === "unknown") throw new UnknownReplyError("a drip course's outline");
        card = course && course.id === courseId && productId ? dripCardOf(course, productId) : null;
        if (!card) {
          // Confirmed gone, or nothing in it opens over time: out of the pending set, nothing to walk.
          await redisPipeline([["SREM", pendingKey(statsId), member], ["HDEL", walkKey(statsId), courseId]]);
          left -= 1;
          continue;
        }
        await noteData(store, [cardRoom(courseId, card)]);
        await redisPipeline([["SET", cardKey(courseId), JSON.stringify(card), "NX"]]);
      }
      const from = walks[n];
      if (from !== null && (typeof from !== "string" || !/^[0-9]+$/.test(from))) throw new UnknownReplyError("where a drip course's walk stopped");
      let page = from ?? "0";
      let finished = false;
      while (budget > 0 && pairsWritten < DRIP_INDEX_PAIRS_PER_RUN && Date.now() < run.deadline) {
        budget -= 1;
        // Every student, a page at a time (rules 24 and 30): a page that does not read is unknown, never the end.
        const scanned = scanPage(await redisPipeline([["HSCAN", studentsKey(courseId), page, "COUNT", DRIP_PAGE]]));
        if (!scanned || scanned.items.length % 2 !== 0) throw new UnknownReplyError("a page of a drip course's students");
        const pairs: [number, string][] = [];
        for (let i = 0; i < scanned.items.length; i += 2) {
          const row = studentTimes(scanned.items[i + 1]);
          if (!row || typeof row.e !== "string" || !row.e) {
            // Not a student's record: said and counted, never read as "nobody to email".
            counts.unreadStudents += 1;
            console.error("a student's record in a drip course could not be read; not indexed", courseId);
            continue;
          }
          pairs.push(...duePairs(courseId, scanned.items[i], row.s, card, run.nowSeconds));
        }
        if (pairs.length > 0) {
          // The page's pairs take their room first: a full room writes none, and the course waits where it is.
          if (!(await takeData(store, pairRoom(pairs))).ok) throw new Error("the store's data room cannot take a drip course's pairs");
          const added = repliesFor(await redisPipeline([["ZADD", dueKey(statsId), ...pairs.flatMap(([score, m]) => [score, m])]]), 1);
          if (!added || countOf(added[0]) === null) throw new UnknownReplyError("a drip course's pairs written");
          pairsWritten += pairs.length;
          counts.indexed += pairs.length;
        }
        page = scanned.next;
        if (page === "0") {
          finished = true;
          break;
        }
        await redisPipeline([["HSET", walkKey(statsId), courseId, page]]);
      }
      if (!finished) continue;
      await redisPipeline([["SREM", pendingKey(statsId), member], ["HDEL", walkKey(statsId), courseId]]);
      left -= 1;
      counts.courses += 1;
    } catch (error) {
      // Not this course's turn to stop the others: it stays pending, walked again the next run from where it stopped.
      counts.failed += 1;
      console.error("a course's drip emails failed; it stays and is tried again the next run", courseId, error);
    }
  }
  return left;
}

/**
 * A store's pairs due now: the ones past their window taken out unsent, at most dripIndexEntriesPerRun(store) read,
 * each checked against its course's card, its student's row, the blocked list and its product, then claimed and sent.
 * What is sent, or will never be, leaves the index in one ZREM; what was refused stays for the next run.
 */
async function sendDue(store: Store, statsId: string, storeMember: string, pending: number, run: DripRun): Promise<void> {
  const { counts, nowSeconds } = run;
  const due = dueKey(statsId);
  const cut = nowSeconds - DRIP_WINDOW_SECONDS;
  const limit = dripIndexEntriesPerRun(store, nowSeconds);
  const replies = repliesFor(await redisPipeline([["ZREMRANGEBYSCORE", due, "-inf", cut - 1], ["ZRANGEBYSCORE", due, cut, nowSeconds, "LIMIT", 0, limit], ["ZCARD", due]]), 3);
  const list = stringList(replies?.[1]);
  const total = countOf(replies?.[2]);
  if (!replies || countOf(replies[0]) === null || !list || total === null) throw new UnknownReplyError("a drip store's pairs due");
  counts.dropped += replies[0] as number;
  if (list.length === 0) {
    // Nothing left in the index and nothing pending: out of the stores' set until a student or a course puts it back.
    if (total === 0 && pending === 0) await redisPipeline([["SREM", DRIP_STORES, storeMember]]);
    return;
  }
  const pairs = list.map((member) => {
    const [courseId, field, moduleId] = member.split("|");
    return { member, courseId, field, moduleId, ok: /^[0-9a-f]{32}$/.test(field ?? "") && Boolean(courseId) && Boolean(moduleId) };
  });
  const drop: string[] = [];
  const later: [number, string][] = [];
  // One pair of each course in turn (Claude 2 on #3344): a course whose sends are slow and refused never holds back the
  // store's other courses, which come before its next pair.
  const byCourse = new Map<string, typeof pairs>();
  for (const pair of pairs.filter((one) => one.ok || (drop.push(one.member), false))) byCourse.set(pair.courseId, [...(byCourse.get(pair.courseId) ?? []), pair]);
  const valid: typeof pairs = [];
  for (let round = 0; valid.length < pairs.length - drop.length; round += 1) for (const group of byCourse.values()) if (group[round]) valid.push(group[round]);
  const courseIds = [...new Set(valid.map((pair) => pair.courseId))];
  // The cards a hundred at a command (MGET), and each pair's row and blocked check, in one pipeline.
  const cards = new Map<string, DripCard | null | "unknown">();
  for (let i = 0; i < courseIds.length; i += 100) {
    const ids = courseIds.slice(i, i + 100);
    const rows = listSlots(repliesFor(await redisPipeline([["MGET", ...ids.map(cardKey)]]), 1)?.[0]);
    ids.forEach((id, n) => cards.set(id, rows && rows.length === ids.length ? readCard(rows[n]) : "unknown"));
  }
  const checks = valid.length > 0 ? repliesFor(await redisPipeline(valid.flatMap((pair): Cmd[] => [["HGET", studentsKey(pair.courseId), pair.field], ["SISMEMBER", blockedKey(pair.courseId), pair.field]])), valid.length * 2) : [];
  if (!checks) throw new UnknownReplyError("a drip store's students due");
  const products = [...new Set([...cards.values()].flatMap((card) => (card && card !== "unknown" ? [card.p] : [])))];
  const listings = products.length > 0 ? await readListingsExactly(store, products).catch(() => null) : new Map<string, Listing | null | "unknown">();
  const refused = new Map<string, number>();
  let refusedStore = 0;
  let sentHere = 0;
  let unknown = 0;
  let waiting = false;
  for (let n = 0; n < valid.length; n += 1) {
    const pair = valid[n];
    const card = cards.get(pair.courseId);
    // A course with no card has nothing that opens over time any more, or is gone: its pairs leave unsent.
    if (card === null) { drop.push(pair.member); continue; }
    if (card === "unknown" || card === undefined) { unknown += 1; continue; }
    const row = card.m.find((m) => m[0] === pair.moduleId);
    if (!row || row[3] === 0) { drop.push(pair.member); continue; }
    const raw = checks[n * 2];
    if (raw === null) { drop.push(pair.member); continue; }
    if (typeof raw !== "string") { unknown += 1; continue; }
    const student = studentTimes(raw);
    if (!student || typeof student.e !== "string" || !student.e || emailKey(student.e) !== pair.field) {
      // Not a student's record: said and counted, never read as "nobody to email"; the pair stays until its window ends.
      counts.unreadStudents += 1;
      console.error("a student's record in a drip course could not be read; not emailed", pair.courseId);
      continue;
    }
    // When it opens for them now, from the card as it is: a schedule moved since the pair was written is honored.
    const unit = cardModule(row);
    const at = opensAt({ startsAt: card.s }, unit, student.s);
    if (at > nowSeconds) { later.push([at, pair.member]); continue; }
    if (at < cut) { drop.push(pair.member); continue; }
    const blocked = checks[n * 2 + 1];
    if (blocked === 1) { drop.push(pair.member); continue; }
    if (blocked !== 0) { unknown += 1; continue; }
    const product = listings ? listings.get(card.p) ?? "unknown" : "unknown";
    if (product === "unknown") { unknown += 1; continue; }
    if (!product || product.course?.id !== pair.courseId) { drop.push(pair.member); continue; }
    if ((refused.get(pair.courseId) ?? 0) >= DRIP_REFUSALS_PER_COURSE) { waiting = true; continue; }
    // The rest of the pairs wait for the next run, inside the same window: what is sent is never sent again.
    if (Date.now() >= run.deadline) { waiting = true; break; }
    // Sent only on a mark that is ours (lib/claim-mark.ts, CX-123 rule 24): "taken" is an email already sent.
    // "unknown" sends nothing this pass and lets go of the mark if it holds our own value (it may have landed;
    // nothing was sent on it), so a later pass tries again (Claude 2 on #3276).
    const mark = dripMailKey(pair.courseId, student.e, pair.moduleId);
    const value = claimValue();
    const claimed = await claimMark(mark, 400 * 86_400, value);
    if (claimed === "taken") { drop.push(pair.member); continue; }
    let sent = false;
    if (claimed === "unknown") {
      console.error("a drip email's mark could not be confirmed; not sent this run", pair.courseId, pair.moduleId);
      await releaseMark(mark, value);
    } else {
      sent = await sendDripEmail(store, product, unit, student.e, run.origin);
      // Not sent: its own mark let go (compare-and-delete, never another's; never throws), and a later pass sends it; a
      // mark that cannot be let go stays. Not yet told apart (Claude 2 on #3276, finding 2, open): sendEmail's false is
      // also an SES answer lost after the POST, which a later pass may send again.
      if (!sent) await releaseMark(mark, value);
    }
    if (sent) {
      counts.sent += 1;
      sentHere += 1;
      drop.push(pair.member);
      continue;
    }
    // A send that did not go (refused, or its mark not confirmed): counted against both ceilings; the pair stays.
    refused.set(pair.courseId, (refused.get(pair.courseId) ?? 0) + 1);
    refusedStore += 1;
    if (refusedStore >= DRIP_REFUSALS_PER_STORE) {
      console.error("a store's drip sends were refused; its other pairs wait for the next run", statsId);
      waiting = true;
      break;
    }
  }
  // Pairs due left for the next run by a ceiling or the deadline: said, never silently.
  if (waiting) counts.held += 1;
  const tidy: Cmd[] = [];
  if (drop.length > 0) tidy.push(["ZREM", due, ...drop]);
  if (later.length > 0) tidy.push(["ZADD", due, "XX", ...later.flatMap(([score, member]) => [score, member])]);
  if (tidy.length > 0) {
    const done = await redisPipeline(tidy).then((r) => repliesFor(r, tidy.length), () => null);
    // What could not be confirmed taken out is read again the next run: a pair sent is "taken" then, never sent twice.
    if (!done || done.some((reply) => countOf(reply) === null)) console.error("a drip store's handled pairs could not be confirmed taken out", statsId);
    else counts.dropped += drop.length - sentHere;
  }
  if (unknown > 0) throw new UnknownReplyError("a drip store's cards, students or products");
}

async function sendDripEmail(store: Store, product: Listing, unit: CourseModule, email: string, origin: string): Promise<boolean> {
  // In the store's language (lib/buyer-words/courses.ts); the button it
  // names is the course page's own.
  const w = coursesWords(store.language);
  return sendEmail({ meter: { by: "store", store: store, kind: "email" },
    from: `"${displayName(store.name)} via Marktmorgen" <${senderAddress()}>`,
    to: email,
    subject: w.dripSubject(product.title, unit.title).slice(0, 200),
    text: [
      w.dripLead(unit.title, product.title, unit.lessons.length),
      "",
      `${origin}/@${store.handle}/course/${product.id}`,
      "",
      w.dripHow(w.sendLink),
      "",
      w.dripSentBy(store.name),
    ].join("\n"),
  });
}

// ------------------------------------------------------------ deleting a person

/**
 * Deletes one person from this store's courses (lib/person-erasure.ts): the
 * courses written down for them on a thanks page, Stripe's answer kept for
 * ten minutes, each course's record of when they began and came back, the
 * lessons they marked done, the drip emails sent them, and every browser
 * pass let in with their address. What they paid for stays on the
 * creator's Stripe account, so a buyer who comes back proves it again by
 * the emailed link, as on any new device.
 */
export async function forgetLearnerPerson(
  store: Store,
  rawEmail: string,
  courses: { courseId: string; moduleIds: string[] }[],
): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const email = normaliseEmail(rawEmail);
  // The passes in their exact shape (CX-123 rules 24 and 28): read as none, their records would stay after the person.
  const held = stringList(repliesFor(await redisPipeline([["SMEMBERS", passesKey(store, email)]]), 1)?.[0]);
  if (held === null) throw new UnknownReplyError("the passes of a person being deleted");
  const passes = held.filter((h) => /^[0-9a-f]{64}$/.test(h));
  const keys = [
    ledgerKey(store, email),
    paidCacheKey(store, email),
    passesKey(store, email),
    ...passes.map((hash) => `nl:learn:pass:${hash}`),
    ...courses.flatMap((c) => [doneKey(c.courseId, email), ...c.moduleIds.map((m) => dripMailKey(c.courseId, email, m))]),
  ];
  const commands: (string | number)[][] = [["DEL", ...keys], ...courses.map((c) => ["HDEL", studentsKey(c.courseId), emailKey(email)])];
  // Their pairs in the store's drip index (docs/drip-due-index.md), one ZREM of every course and module, counted as the rest.
  const pairs = courses.flatMap((c) => c.moduleIds.map((m) => `${c.courseId}|${emailKey(email)}|${m}`));
  if (store.statsId && pairs.length > 0) commands.push(["ZREM", dueKey(store.statsId), ...pairs]);
  const replies = repliesFor(await redisPipeline(commands), commands.length);
  // One whole count for each DEL, HDEL and ZREM (CX-123 rule 24): never 0 removed on another shape; thrown, so the
  // erasure says this part did not finish (lib/person-erasure.ts).
  const counts = replies?.map(countOf);
  if (!counts || counts.some((n) => n === null)) throw new UnknownReplyError("the deletion of a person's course records");
  return (counts as number[]).reduce((sum, n) => sum + n, 0);
}
