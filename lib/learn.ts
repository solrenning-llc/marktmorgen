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
import { currentMeta } from "@/lib/tier-rules";
import { saleHandles } from "@/lib/store";
import { createHash, randomBytes } from "node:crypto";
import { fileUrl } from "@/lib/file-store";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, SESSION_COOKIE, emailForSession, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, sendEmail, serviceMailKnownUnavailable } from "@/lib/email";
import { coursesWords } from "@/lib/buyer-words/courses";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { type DataStore, giveData, needData, noteData, takeData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { orderWrite } from "@/lib/order-data";
import { earnedCourses } from "@/lib/community-points";
import { onAccount } from "@/lib/stripe-account";
import { isSettled } from "@/lib/instant-pay";
import { isLiveSub } from "@/lib/membership-access";
import { purchaseRefunded } from "@/lib/refunds";
import { folderFromPathname, recordDelivery } from "@/lib/delivery";
import { playerFor } from "@/lib/stream";
import { isStreamPath } from "@/lib/stream-rules";
import { opened, watchedForAdmission } from "@/lib/watch";
import { calendarWindow } from "@/lib/allowance-window";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import type { ProductFile } from "@/lib/product-file";
import type { Listing, Store } from "@/lib/store";
import { readKind, readListing } from "@/lib/catalog";
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
 * reply it could not read. Running it again is harmless.
 */
export async function dropEnrollment(store: Store, email: string, productId: string): Promise<void> {
  if (!isRedisConfigured()) return;
  const replies = repliesFor(
    await redisPipeline([
      ["HDEL", ledgerKey(store, email), productId],
      ["DEL", paidCacheKey(store, email)],
    ]),
    2,
  );
  if (!replies || !replies.every((reply) => reply === 0 || reply === 1)) throw new UnknownReplyError("taking a course off a ledger");
}

type Listed = { data?: unknown };

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
};

/** Asks the creator's Stripe account what this address paid for here. */
async function paidAtStripe(store: Store, email: string): Promise<Ledger> {
  const found = new Map<string, number>();
  const ended = new Set<string>();
  const refunded = new Set<string>();
  const account = store.stripeAccountId;
  if (!account) return { paid: found, ended, refunded };
  const handles = saleHandles(store);
  const courses = new Map((await readKind(store, "course")).filter((p) => p.course).map((p) => [p.id, p]));
  if (courses.size === 0) return { paid: found, ended, refunded };

  // Stripe keeps the address as it was typed at checkout.
  const variants = [...new Set([email.trim(), normaliseEmail(email)])];
  for (const variant of variants) {
    const query = new URLSearchParams({ "customer_details[email]": variant, status: "complete", limit: "100" });
    query.append("expand[]", "data.subscription");
    query.append("expand[]", "data.subscription.latest_invoice");
    query.append("expand[]", "data.payment_intent.latest_charge");
    const listed = (await onAccount("GET", account, `/checkout/sessions?${query}`)) as Listed;
    const rows = Array.isArray(listed.data) ? (listed.data as Record<string, unknown>[]) : [];
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
    refunded.delete(id);
  }
  return { paid: found, ended, refunded };
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
      };
    }
    return { paid: new Map(Object.entries(value as Record<string, number>)), ended: new Set(), refunded: new Set() };
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

/** The same answer, with the memberships that ended kept apart. */
async function courseLedger(store: Store, email: string): Promise<Ledger> {
  const result = new Map<string, number>();
  if (!isRedisConfigured()) return { paid: result, ended: new Set(), refunded: new Set() };
  // A store that brought buyers over from another platform reads theirs in
  // the same round trip (lib/imported-purchases.ts); any other asks nothing more.
  const imported = importedRead(store, email);
  const [cached, ledger, broughtOver] = await redisPipeline([
    ["GET", paidCacheKey(store, email)],
    ["HGETALL", ledgerKey(store, email)],
    ...(imported ? [imported] : []),
  ]);
  let asked: Ledger | null = typeof cached === "string" ? parseLedger(cached) : null;
  if (!asked) {
    try {
      asked = await paidAtStripe(store, email);
      const kept = JSON.stringify({ p: Object.fromEntries(asked.paid), x: [...asked.ended], r: [...asked.refunded] });
      await redisPipeline([["SET", paidCacheKey(store, email), kept, "EX", PAID_SECONDS]]);
    } catch (error) {
      console.error("reading course purchases failed", error);
      asked = { paid: new Map(), ended: new Set(), refunded: new Set() };
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

  const courses = await readKind(store, "course");
  for (const product of courses) {
    if (!product.course) continue;
    // A one-off sale written down on the thanks page stands on its own,
    // unless Stripe now says it was refunded in full.
    const start = product.recurring || asked.refunded.has(product.id)
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
      console.error("reading courses earned by level failed", error);
    }
  }

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
  return { paid: result, ended: asked.ended, refunded: asked.refunded };
}

export type CourseAccess =
  | { state: "open"; learner: Learner; start: number }
  | { state: "preview"; learner: Learner | null }
  | { state: "closed"; learner: Learner | null }
  /** A membership that gave this course has ended: said as such, with the way back. */
  | { state: "ended"; learner: Learner };

/** Whether this browser may take this course, and from when. */
export async function courseAccess(store: Store, product: Listing, cookies: CookieJar): Promise<CourseAccess> {
  const learner = await learnerFrom(store, cookies);
  if (!learner || !product.course) return { state: "closed", learner };
  if (learner.owner) return { state: "open", learner, start: Math.floor(Date.now() / 1000) - 400 * 86_400 };
  if (learner.scope !== "all" && !learner.scope.includes(product.course.id)) return { state: "closed", learner };
  const { paid, ended } = await courseLedger(store, learner.email);
  const start = paid.get(product.id);
  if (start !== undefined) return { state: "open", learner, start };
  return ended.has(product.id) ? { state: "ended", learner } : { state: "closed", learner };
}

// ------------------------------------------------------------ progress

const studentsKey = (courseId: string) => `nl:course:${courseId}:students`;
const doneKey = (courseId: string, email: string) => `nl:course:${courseId}:done:${emailKey(email)}`;

type StudentRow = { e: string; s: number; l: number };

/**
 * Notes that a student opened the course, keeping when they began. A new
 * student's row takes its room in the store's data room first
 * (lib/store-data.ts); when there is none it is not written, and the course
 * opens all the same: the row is what the studio shows, not their access.
 */
export async function touchStudent(courseId: string, email: string, startSeconds: number, room: DataStore): Promise<void> {
  if (!isRedisConfigured()) return;
  const key = studentsKey(courseId);
  const field = emailKey(email);
  const [raw] = await redisPipeline([["HGET", key, field]]);
  let row: StudentRow = { e: normaliseEmail(email), s: Math.floor(startSeconds), l: 0 };
  if (typeof raw === "string") {
    try {
      const old = JSON.parse(raw) as StudentRow;
      row = { e: old.e || row.e, s: Math.min(old.s || row.s, row.s), l: 0 };
    } catch {}
  }
  row.l = Math.floor(Date.now() / 1000);
  const json = JSON.stringify(row);
  if (typeof raw !== "string" && !(await takeData(room, [{ slot: DONE_SLOT(courseId), bytes: dataBytes([field, json, "0000000000"], 1) }])).ok) return;
  await redisPipeline([["HSET", key, field, json]]);
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
  | { kind: "paused" };

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
export async function lessonVideo(file: ProductFile, limit: number | null = null, window: string | null = calendarWindow().id, store?: Store): Promise<LessonVideo | null> {
  // The creator contract funds each new media admission before signing a URL or querying a player.
  if (store?.period?.funded === true && !(await reservePaidResourceWindow(store))) return null;
  if (!isStreamPath(file.pathname)) {
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
  const replies = repliesFor(await redisPipeline([
    ["SET", key, "0", "EX", RATE_WINDOW_SECONDS, "NX"],
    ["INCR", key],
  ]), 2);
  // A count in any other shape is unknown (CX-123 rule 24): no course link is emailed on it.
  const count = countOf(replies?.[1]);
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

  const paid = await paidCourses(store, raw);
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
  const replies = repliesFor(await redisPipeline([
    ["GET", linkKey(token)],
    ["SET", opensKey(token), "0", "EX", LINK_SECONDS, "NX"],
    ["INCR", opensKey(token)],
  ]), 3);
  const raw = replies?.[0];
  // The opens in their exact shape (CX-123 rule 24): an unknown count opens nothing.
  const opens = countOf(replies?.[2]);
  if (typeof raw !== "string" || opens === null || opens > MAX_LINK_OPENS) return null;
  try {
    const grant = JSON.parse(raw) as LinkGrant;
    return typeof grant.e === "string" && typeof grant.h === "string" && typeof grant.p === "string" ? grant : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ drip emails

const DRIP_SET = "nl:courses:drip";
const dripMailKey = (courseId: string, email: string, moduleId: string) =>
  `nl:course:${courseId}:dripmail:${emailKey(email)}:${moduleId}`;

/** Remembers that this course opens modules over time, for the daily job. */
export async function registerDrip(store: Store, product: Listing, course: Course): Promise<void> {
  const member = `${course.id}|${store.handle}|${product.id}`;
  const drips = course.modules.some((m) => m.dripDays > 0);
  await redisPipeline([[drips ? "SADD" : "SREM", DRIP_SET, member]]);
}

/**
 * Tells each student when a module opens for them. Once per student and
 * unit, and only for modules that opened in the last three days, so a
 * course that gains a drip module does not email about months gone by.
 */
export async function sendDripEmails(
  load: (handle: string) => Promise<Store | null>,
  loadCourse: (id: string) => Promise<Course | null>,
  origin: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ sent: number; courses: number }> {
  const counts = { sent: 0, courses: 0 };
  if (!isRedisConfigured()) return counts;
  const [raw] = await redisPipeline([["SMEMBERS", DRIP_SET]]);
  const members = Array.isArray(raw) ? (raw as string[]) : [];
  for (const member of members) {
    const [courseId, handle, productId] = member.split("|");
    const store = await load(handle);
    const product = store ? await readListing(store, productId) : null;
    const course = product?.course?.id === courseId ? await loadCourse(courseId) : null;
    if (!store || !product || !course) {
      await redisPipeline([["SREM", DRIP_SET, member]]);
      continue;
    }
    const dripping = course.modules.filter((m) => m.dripDays > 0 && m.lessons.length > 0);
    if (dripping.length === 0) continue;
    const read = await studentsOf(course, 5000);
    if (!read) {
      // Unknown, not none: this course waits for the next run, which reads it again.
      console.error("reading a course's students for its drip emails failed", course.id);
      continue;
    }
    counts.courses += 1;
    const { students } = read;
    for (const student of students) {
      if (student.blocked) continue;
      for (const unit of dripping) {
        const at = opensAt(course, unit, student.since);
        if (at > nowSeconds || at < nowSeconds - 3 * 86_400) continue;
        // Sent only on a mark that is ours (lib/claim-mark.ts, CX-123 rule 24): "taken" is an email already sent.
        // "unknown" sends nothing this pass and lets go of the mark if it holds our own value (it may have landed;
        // nothing was sent on it), so a later pass tries again (Claude 2 on #3276).
        const mark = dripMailKey(course.id, student.email, unit.id);
        const value = claimValue();
        const claimed = await claimMark(mark, 400 * 86_400, value);
        if (claimed === "unknown") {
          console.error("a drip email's mark could not be confirmed; not sent this run", course.id, unit.id);
          await releaseMark(mark, value);
        }
        if (claimed !== "ours") continue;
        const ok = await sendDripEmail(store, product, unit, student.email, origin);
        if (ok) counts.sent += 1;
        // Not sent: its own mark let go (compare-and-delete, never another's; never throws, so the pass goes on), and
        // a later pass sends it; a mark that cannot be let go stays. Not yet told apart (Claude 2 on #3276, finding
        // 2, open): sendEmail's false is also an SES answer lost after the POST, which a later pass may send again.
        else await releaseMark(mark, value);
      }
    }
  }
  return counts;
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
  const replies = repliesFor(await redisPipeline(commands), commands.length);
  // One whole count for each DEL and HDEL (CX-123 rule 24): never 0 removed on another shape; thrown, so the
  // erasure says this part did not finish (lib/person-erasure.ts).
  const counts = replies?.map(countOf);
  if (!counts || counts.some((n) => n === null)) throw new UnknownReplyError("the deletion of a person's course records");
  return (counts as number[]).reduce((sum, n) => sum + n, 0);
}
