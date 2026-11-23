/**
 * Certificates of completion: a page that says a named person finished a
 * course, at an address anyone can open to check it.
 *
 * A student earns one when every lesson of the course is done and every quiz
 * that has to be passed is passed, on a course whose creator switched
 * certificates on. They type the name it should carry, and it carries that
 * name exactly as typed: nobody here knows how a person spells their own name
 * better than they do. The course title and the creator's name are written
 * into the certificate the moment it is issued, so renaming the course later
 * does not quietly change what was certified.
 *
 * The page at /@handle/certificate/<id> is the proof. It is served from the
 * record kept here, never from anything in the address, so a certificate
 * cannot be forged by editing a URL; and a creator who withdraws one — issued
 * to the wrong name, or to someone who was refunded — leaves the page saying
 * so, rather than making it vanish as if it had never been.
 *
 * One certificate per student per course. Withdrawing it lets the student
 * issue it again, under the name they type then.
 *
 *   nl:cert:<id>                  -> the certificate, as JSON, kept for good
 *   nl:course:<course>:certs      -> hash of student key -> standing certificate id
 *   nl:course:<course>:certs:all  -> set of every certificate id issued, withdrawn ones too
 *   nl:course:<course>:certs:at   -> the same ids by when each was issued (a sorted set), read a page at a time (#4304)
 *   nl:course:<course>:certs:atc  -> where the studio's walk of the older set stands, adding what it lacks (#4304)
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReply, exactReplies, plainList, replyCount } from "@/lib/redis-exact";
import { type DataStore, DataRoomError, giveData, needData, takeData } from "@/lib/store-data";
import { ENTRY_BYTES, dataBytes } from "@/lib/store-data-rules";
import { type Course, lessonsInOrder } from "@/lib/course";
import { requiredQuizLessons } from "@/lib/quiz";
import { emailKey, studentsIndexKey } from "@/lib/learn";
import type { CourseIndexes } from "@/lib/removed-courses";
import { randomLetters } from "@/lib/random-letters";
import { HDEL_IF_EQUAL } from "@/lib/redis-reply";
import { suppressedAmong } from "@/lib/suppression";

export const CERT_ID_PATTERN = /^[a-z0-9]{16}$/;
export const MIN_CERT_NAME = 2;
export const MAX_CERT_NAME = 80;
/** The most certificates the studio lists for one course on one page (#4304): one draw reads this many, never the whole course. */
export const MAX_LISTED_CERTS = 25;
/** The most certificates issued before the by-time list was kept (#4304) that one studio draw adds to it. */
export const CERT_BACKFILL_PER_DRAW = 25;
/**
 * The store's public requests the picture a certificate's shared link unfolds
 * into takes (app/[handle]/certificate/[id]/opengraph-image.tsx): one before
 * the record is read and the rest before anything is drawn, as many as its
 * PDF (CERTIFICATE_PDF_UNITS, lib/certificate-pdf.ts), which weighs more: the
 * heaviest picture measured 153 KB and 0.59 s of CPU cold, inside what
 * CERTIFICATE_PDF_READ prices (tests/plan-cost-registry.ts).
 */
export const CERTIFICATE_CARD_UNITS = 2;

export type Certificate = {
  id: string;
  /** The store it belongs to (lib/learn.ts storeKey), whatever its address. */
  store: string;
  productId: string;
  courseId: string;
  /** The name as the student typed it. */
  name: string;
  /** The course's title and the creator's name when it was issued. */
  title: string;
  creator: string;
  /** The student's address, for the creator's list. Never shown on the page. */
  email: string;
  issuedAt: number;
  /** When the creator withdrew it; 0 while it stands. */
  withdrawnAt: number;
  /**
   * Present only on one withdrawn because the payment that gave its course was
   * given back in full, a refund that succeeded or a dispute lost
   * (lib/certificate-refunds.ts): its page no longer shows the name.
   */
  withdrawnFor?: "refund";
  /**
   * The last moment it is valid, in seconds (639 [GL7](32)), fixed when it is
   * issued from the course's validity then; absent is for good.
   */
  validUntil?: number;
};

/** A moment `months` calendar months after `seconds`, in UTC: the 31st of a short month falls on its last day. */
export function monthsAfter(seconds: number, months: number): number {
  const d = new Date(seconds * 1000);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return Math.floor(target.getTime() / 1000);
}

/** Whether a certificate still certifies now, by its own validity: withdrawn, expired, or standing. */
export function standingOf(c: Pick<Certificate, "withdrawnAt" | "validUntil">, nowSeconds: number): "withdrawn" | "expired" | "valid" {
  if (c.withdrawnAt > 0) return "withdrawn";
  return c.validUntil && nowSeconds > c.validUntil ? "expired" : "valid";
}

export function newCertificateId(): string {
  return randomLetters("abcdefghijklmnopqrstuvwxyz0123456789", 16);
}

/**
 * The name as typed, made safe to keep: control characters and runs of
 * spaces go, and nothing else is touched — no capitals added, no accents
 * taken away. Null when what is left is too short or too long to be a name.
 */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  if ([...name].length < MIN_CERT_NAME || [...name].length > MAX_CERT_NAME) return null;
  return name;
}

/**
 * LinkedIn's own form for adding a certification to a profile, filled in from
 * the record: the course as the certification, the creator as who issued it,
 * the month it was issued, its ID, and this page as the credential LinkedIn
 * links to. The student checks it and saves it there themselves; nothing is
 * posted for them. The parameters are LinkedIn's "Add to Profile" ones.
 */
export function linkedInAddUrl(certificate: Pick<Certificate, "id" | "title" | "creator" | "issuedAt" | "validUntil">, pageUrl: string): string {
  const issued = new Date(certificate.issuedAt * 1000);
  const query = new URLSearchParams({
    startTask: "CERTIFICATION_NAME",
    name: certificate.title,
    organizationName: certificate.creator,
    issueYear: String(issued.getUTCFullYear()),
    issueMonth: String(issued.getUTCMonth() + 1),
    certId: certificate.id,
    certUrl: pageUrl,
  });
  // A certificate that expires says when, on the same form (639 [GL7](32)).
  if (certificate.validUntil) {
    const until = new Date(certificate.validUntil * 1000);
    query.set("expirationYear", String(until.getUTCFullYear()));
    query.set("expirationMonth", String(until.getUTCMonth() + 1));
  }
  return `https://www.linkedin.com/profile/add?${query}`;
}

/** LinkedIn's page for writing a post about a link, with this page's link in it. */
export function linkedInShareUrl(pageUrl: string): string {
  return `https://www.linkedin.com/sharing/share-offsite/?${new URLSearchParams({ url: pageUrl })}`;
}

/** Whether this student has done everything a certificate asks. */
export function hasFinished(course: Course, done: Set<string>, passed: Set<string>): boolean {
  const lessons = lessonsInOrder(course);
  if (lessons.length === 0) return false;
  return lessons.every(({ lesson }) => done.has(lesson.id)) && requiredQuizLessons(course).every((id) => passed.has(id));
}

type CertificateRecord = Record<string, unknown> & Pick<Certificate, "id" | "name" | "title" | "store">;
/** Privacy export keeps status as stored, without claiming that it is valid. */
type CertificateCopy = Omit<Certificate, "issuedAt" | "withdrawnAt" | "validUntil" | "withdrawnFor"> & Partial<Record<"issuedAt" | "withdrawnAt" | "validUntil" | "withdrawnFor", unknown>>;

function certificateRecord(raw: unknown): CertificateRecord | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (typeof value.id !== "string" || !CERT_ID_PATTERN.test(value.id)) return null;
    if (typeof value.name !== "string" || typeof value.title !== "string" || typeof value.store !== "string") return null;
    return value as CertificateRecord;
  } catch {
    return null;
  }
}

function certificateFields(value: CertificateRecord): Omit<Certificate, "issuedAt" | "withdrawnAt" | "validUntil" | "withdrawnFor"> {
  return {
    id: value.id,
    store: value.store,
    productId: typeof value.productId === "string" ? value.productId : "",
    courseId: typeof value.courseId === "string" ? value.courseId : "",
    name: value.name,
    title: value.title,
    creator: typeof value.creator === "string" ? value.creator : "",
    email: typeof value.email === "string" ? value.email : "",
  };
}

function copyCertificate(value: CertificateRecord): CertificateCopy {
  return {
    ...certificateFields(value),
    ...(Object.hasOwn(value, "issuedAt") ? { issuedAt: value.issuedAt } : {}),
    ...(Object.hasOwn(value, "withdrawnAt") ? { withdrawnAt: value.withdrawnAt } : {}),
    ...(Object.hasOwn(value, "validUntil") ? { validUntil: value.validUntil } : {}),
    ...(Object.hasOwn(value, "withdrawnFor") ? { withdrawnFor: value.withdrawnFor } : {}),
  };
}

function parseCertificate(raw: unknown): Certificate | null {
  const value = certificateRecord(raw);
  if (!value) return null;
  // Status is evidence, not a default. Only absence of expiration means
  // a legacy permanent certificate; malformed dates must never make one
  // standing again. Bound dates to what JavaScript can actually display.
  const seconds = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 8_640_000_000_000;
  if (!Object.hasOwn(value, "issuedAt") || !seconds(value.issuedAt)) return null;
  if (!Object.hasOwn(value, "withdrawnAt") || !seconds(value.withdrawnAt)) return null;
  const hasExpiration = Object.hasOwn(value, "validUntil");
  if (hasExpiration && (!seconds(value.validUntil) || value.validUntil === 0)) return null;
  // Withdrawn for a refund only as the refund pass writes it: on a withdrawn
  // one, exactly "refund". Anything else is no certificate, never one that
  // shows the name again.
  const forRefund = Object.hasOwn(value, "withdrawnFor");
  if (forRefund && (value.withdrawnFor !== "refund" || value.withdrawnAt === 0)) return null;
  return {
    ...certificateFields(value),
    issuedAt: value.issuedAt,
    withdrawnAt: value.withdrawnAt,
    ...(hasExpiration ? { validUntil: value.validUntil as number } : {}),
    ...(forRefund ? { withdrawnFor: "refund" as const } : {}),
  };
}

/**
 * The name a certificate's public page, its title and its description show:
 * none once it was withdrawn because its course's payment was given back
 * (DONO-18; Claude 2 on #3374). A certificate the creator withdrew shows it,
 * marked withdrawn, as before.
 */
export function publicName(certificate: Pick<Certificate, "name" | "withdrawnAt" | "withdrawnFor">): string | null {
  return certificate.withdrawnAt > 0 && certificate.withdrawnFor === "refund" ? null : certificate.name;
}

export const certKey = (id: string) => `nl:cert:${id}`;
/** Where a course's certificates are counted in the store's data room (lib/store-data.ts). */
const CERTS_SLOT = (courseId: string) => `cc:${courseId}`;
const indexKey = (courseId: string) => `nl:course:${courseId}:certs`;
export const allKey = (courseId: string) => `nl:course:${courseId}:certs:all`;
/**
 * A course's certificate ids by when each was issued, withdrawn ones too (#4304): the studio reads a page of it, so a
 * draw is bounded whatever the course holds. Each member is one more entry of the certificate's room (ENTRY_BYTES),
 * taken when it is added and given back when it is removed.
 */
export const atKey = (courseId: string) => `nl:course:${courseId}:certs:at`;
/** Where the studio's walk of allKey stands while it adds the certificates issued before atKey was kept (#4304). */
const atCursorKey = (courseId: string) => `nl:course:${courseId}:certs:atc`;
/** The work handed in for a course, as lib/assignment.ts keeps it (its allKey), read here only for courseIndexes. */
const tasksIndexKey = (courseId: string) => `nl:course:${courseId}:tasks:all`;
/**
 * A course's students, certificates and handed-in work, the indexes a dropped course's note is kept by while any holds
 * anyone (lib/removed-courses.ts; Claude 1 cloud R on #4563: a ca: slot read as nothing does not prove no work is kept).
 */
export const courseIndexes: CourseIndexes = (courseId) => [studentsIndexKey(courseId), allKey(courseId), tasksIndexKey(courseId)];
/** Every certificate one student was ever issued for a course, withdrawn ones too (added 17 October 2026), so deleting them finds each. */
const byKey = (courseId: string, who: string) => `nl:course:${courseId}:certs:by:${who}`;
/** A command answering 1 when this learner holds a certificate of a course: a dropped one's probe (lib/person-erasure.ts). */
export const certificateProbe = (courseId: string, who: string): (string | number)[] => ["EXISTS", byKey(courseId, who)];
/** How many certificates of a course deleting a person looks through for ones issued before byKey was kept. */
const LEGACY_SCAN = 500;

/**
 * The certificate kept under this id: null for a confirmed none (nil) or a
 * record that is itself malformed; any other reply throws UnknownReply
 * (CX-123 rule 24), so the page that proves a certificate never says "not
 * found", and a withdrawal never says "no such certificate", on a guess.
 */
export async function readCertificate(id: string): Promise<Certificate | null> {
  if (!isRedisConfigured() || !CERT_ID_PATTERN.test(id)) return null;
  const what = "a certificate's record";
  const [raw] = exactReplies(await redisPipeline([["GET", certKey(id)]]), 1, what);
  if (raw !== null && typeof raw !== "string") throw new UnknownReply(what);
  return parseCertificate(raw);
}

/**
 * The id the student's slot names and the certificate it names when that one
 * still stands, both read exactly (CX-123 rule 24): null only for a slot
 * Redis confirms empty (nil); a record confirmed gone (nil), malformed or
 * withdrawn is no standing certificate; any other reply throws UnknownReply.
 */
async function slotHolder(courseId: string, who: string, what: string): Promise<{ id: string; standing: Certificate | null } | null> {
  const [id] = exactReplies(await redisPipeline([["HGET", indexKey(courseId), who]]), 1, what);
  if (id === null) return null;
  if (typeof id !== "string") throw new UnknownReply(what);
  if (!CERT_ID_PATTERN.test(id)) return { id, standing: null };
  const [raw] = exactReplies(await redisPipeline([["GET", certKey(id)]]), 1, what);
  if (raw !== null && typeof raw !== "string") throw new UnknownReply(what);
  const found = parseCertificate(raw);
  return { id, standing: found && !found.withdrawnAt ? found : null };
}

/**
 * The standing certificate this student holds for this course, if any; a
 * reply that is not exactly what was asked for throws UnknownReply, never
 * read as "none".
 */
export async function certificateOf(courseId: string, who: string): Promise<Certificate | null> {
  if (!isRedisConfigured()) return null;
  return (await slotHolder(courseId, who, "a student's certificate"))?.standing ?? null;
}

/**
 * The student's slot moved from the certificate it names to a new one, only
 * while it still names that one, in one step: 1 when moved, 0 when it names
 * another meanwhile and nothing was written. Modelled by lib/redis-memory.ts.
 */
export const CERT_SLOT_SWAP = `-- marktmorgen:cert-slot-swap:v1
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1`;

/**
 * The student's slot freed only while it still names the certificate
 * withdrawn, in one step, the mirror of CERT_SLOT_SWAP: 1 when freed, 0 when
 * it names another or none and nothing was removed. Modelled by
 * lib/redis-memory.ts.
 */
export const CERT_SLOT_FREE = `-- marktmorgen:cert-slot-free:v1
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
return redis.call('HDEL', KEYS[1], ARGV[1])`;

/** How many times one press looks at the slot again when it changed between two reads. */
const CLAIM_TRIES = 3;

export type IssueResult = { ok: true; certificate: Certificate; fresh: boolean } | { ok: false; reason: "name" | "gone" };

/**
 * Issues the certificate, or hands back the one already issued.
 *
 * The student's slot in the course's list is taken first, and only if free,
 * so two presses of the button — two tabs, a double click — make one
 * certificate and not two. The caller has already checked that the course
 * gives certificates and that this student finished it.
 */
export async function issueCertificate(input: {
  store: string;
  productId: string;
  course: Course;
  title: string;
  creator: string;
  email: string;
  who: string;
  name: unknown;
  /** The store whose data room it takes from (DataRoomError when it does not fit). */
  room: DataStore;
  /**
   * The store's list id, whose deletion prints say the student was erased (lib/suppression.ts), read after the press's
   * writes: a store with none yet gets one from the erasure itself (lib/person-erasure.ts erasureScope), so it is read
   * then, not when the press began. Null when it cannot be had: not known, so nothing is issued. Not given, none read.
   */
  listId?: () => Promise<string | null>;
}): Promise<IssueResult> {
  const name = cleanName(input.name);
  if (!name) return { ok: false, reason: "name" };
  const id = newCertificateId();
  const certificate: Certificate = {
    id,
    store: input.store,
    productId: input.productId,
    courseId: input.course.id,
    name,
    title: input.title.slice(0, 200),
    creator: input.creator.slice(0, 120),
    email: input.email,
    issuedAt: Math.floor(Date.now() / 1000),
    withdrawnAt: 0,
  };
  // The course's validity now, fixed on this certificate (639 [GL7](32)).
  if (input.course.certificateMonths) certificate.validUntil = monthsAfter(certificate.issuedAt, input.course.certificateMonths);
  // The record is written before the student's slot is claimed (changed
  // 17 October 2026). Claiming first left a moment in which the slot named
  // a certificate not yet written, and a second press arriving then read it
  // as lost, took the slot and issued a second certificate beside the first.
  // Its room first: the record, kept for good, and its places in the course's lists (the by-time one too, #4304).
  const bytes = dataBytes([JSON.stringify(certificate)], 4);
  await needData(input.room, [{ slot: CERTS_SLOT(input.course.id), bytes }]);
  await redisPipeline([["SET", certKey(id), JSON.stringify(certificate)]]);
  let existing: Certificate | null;
  try {
    existing = await claimSlot(input.course.id, input.who, id);
  } catch (error) {
    // Unknown whether the slot names this press's record (CX-123 rule 24): the
    // record goes and its room comes back once its deletion is confirmed, and
    // the press is refused; a slot left naming it reads as gone and is taken
    // by the next press.
    const [gone] = await redisPipeline([["DEL", certKey(id)]]).catch(() => [null]);
    if (gone === 1) await giveData(input.room, [{ slot: CERTS_SLOT(input.course.id), bytes }]).catch(() => {});
    throw error;
  }
  if (existing) {
    // This press made nothing that stands: its record goes, the standing one is the answer.
    await redisPipeline([["DEL", certKey(id)]]);
    await giveData(input.room, [{ slot: CERTS_SLOT(input.course.id), bytes }]);
    // The standing one goes on the course's two lists again (SADD is idempotent): a press whose index write failed
    // after its slot was claimed left it off them, and only a later press can repair that (#4277). Each reply read
    // exactly as 0 or 1 (rule 24); any other throws, and the next press tries again.
    const what = "a standing certificate's places in its course's lists";
    exactReplies(
      await redisPipeline([["SADD", allKey(input.course.id), existing.id], ["SADD", byKey(input.course.id, input.who), existing.id]]),
      2,
      what,
    ).forEach((n) => {
      if (replyCount(n, what) > 1) throw new UnknownReply(what);
    });
    await listByTime(input.course.id, existing, input.room);
    return { ok: true, certificate: existing, fresh: false };
  }
  const written = await redisPipeline([
    ["SADD", allKey(input.course.id), id],
    ["SADD", byKey(input.course.id, input.who), id],
    ["ZADD", atKey(input.course.id), "NX", certificate.issuedAt, id],
  ]);
  // A studio draw between the SADD and the ZADD (Upstash runs a pipeline's commands one by one) may have added this
  // id to the by-time list itself, taking its entry's room (Claude 5 iYnra's LEVE 3 on #5481): the ZADD then answers
  // 0, and the entry this press reserved comes back. Any other answer keeps it, which only counts too much.
  if (Array.isArray(written) && written[2] === 0) await giveData(input.room, [{ slot: CERTS_SLOT(input.course.id), bytes: ENTRY_BYTES }]);
  // The student's deletion print read after every write (#4783): an erasure writes it before it deletes anything, so
  // one that completed while this press was past its checks found nothing yet, and what was just written would hold
  // their name and address with the erasure said done. Found, or unknown, it is all taken back and nothing is issued
  // (unknown throws, as a press whose writes could not be confirmed does). An erasure after this read finds the
  // certificate through its lists and deletes it itself.
  if (input.listId) {
    let erased: boolean;
    try {
      const listId = await input.listId();
      if (!listId) throw new Error("the store's list of deleted people could not be had");
      erased = (await suppressedAmong(listId, [input.email])).size > 0;
    } catch (error) {
      await takeBackIssued(input.course.id, input.who, id, input.room, bytes);
      throw error;
    }
    if (erased) {
      await takeBackIssued(input.course.id, input.who, id, input.room, bytes);
      return { ok: false, reason: "gone" };
    }
  }
  return { ok: true, certificate, fresh: true };
}

/**
 * Puts a standing certificate on its course's by-time list when it is not there (#4304): one whose press failed after
 * its slot was claimed, or one issued before that list was kept. Its entry's room is taken before the write and given
 * back when another draw or press added it meanwhile; with the room full it is left for the studio's walk. A press
 * that failed after taking the room for that entry took it once more here, which only ever counts too much, never too
 * little. Each reply read exactly; any other throws (rule 24).
 */
async function listByTime(courseId: string, certificate: Certificate, room: DataStore): Promise<void> {
  const what = "a standing certificate's place on its course's by-time list";
  const [score] = exactReplies(await redisPipeline([["ZSCORE", atKey(courseId), certificate.id]]), 1, what);
  if (score !== null) {
    if (typeof score !== "string" && typeof score !== "number") throw new UnknownReply(what);
    return;
  }
  try {
    await needData(room, [{ slot: CERTS_SLOT(courseId), bytes: ENTRY_BYTES }]);
  } catch (error) {
    if (error instanceof DataRoomError) return;
    throw error;
  }
  const [added] = exactReplies(await redisPipeline([["ZADD", atKey(courseId), "NX", certificate.issuedAt, certificate.id]]), 1, what);
  const count = replyCount(added, what);
  if (count > 1) throw new UnknownReply(what);
  if (count === 0) return void (await giveData(room, [{ slot: CERTS_SLOT(courseId), bytes: ENTRY_BYTES }]));
  await dropIfErased(courseId, [certificate.id], room);
}

/**
 * Takes off the by-time list the ids just added whose record is gone meanwhile (Claude 5 iYnra's LEVE 3 on #5481): an
 * erasure that removed the record and the id between this draw's read of the record and its ZADD would leave an id
 * there that nothing deletes, with its entry's room taken for good. Each one taken off gives its entry back once, on
 * the ZREM that removed it. A reply that does not read leaves the ids as they are, which only counts too much.
 */
async function dropIfErased(courseId: string, ids: string[], room: DataStore): Promise<void> {
  if (!ids.length) return;
  const exists = plainList(await redisPipeline(ids.map((id) => ["EXISTS", certKey(id)])).catch(() => null));
  if (!exists || exists.length !== ids.length) return;
  const gone = ids.filter((_, i) => exists[i] === 0);
  if (!gone.length) return;
  const removed = plainList(await redisPipeline(gone.map((id) => ["ZREM", atKey(courseId), id])).catch(() => null));
  const freed = removed ? removed.filter((n) => n === 1).length : 0;
  if (freed > 0) await giveData(room, [{ slot: CERTS_SLOT(courseId), bytes: freed * ENTRY_BYTES }]);
}

/**
 * Takes back what one press wrote (#4783): its record, its places in the course's lists, and the student's slot only
 * while it still names this record (HDEL_IF_EQUAL), so a later press's slot is kept. The record's room comes back once
 * its deletion is confirmed. Each reply read exactly; any other throws, and an erasure run again deletes the rest
 * through the lists it can still find.
 */
async function takeBackIssued(courseId: string, who: string, id: string, room: DataStore, bytes: number): Promise<void> {
  const what = "a certificate taken back from a student erased meanwhile";
  // Keep every reference until the record's deletion is known: a partial pipeline must not orphan personal data.
  const [record] = exactReplies(await redisPipeline([["DEL", certKey(id)]]), 1, what);
  if (replyCount(record, what) > 1) throw new UnknownReply(what);
  // The record's room with it, the by-time entry's apart: that one comes back only on the ZREM that removes it, so a
  // pipeline below that fails and an erasure that then removes the id never give it back twice (Claude 5 iYnra's LEVE 2
  // on #5481).
  if (record === 1) await giveData(room, [{ slot: CERTS_SLOT(courseId), bytes: bytes - ENTRY_BYTES }]);
  const [all, mine, slot, at] = exactReplies(await redisPipeline([
    ["SREM", allKey(courseId), id],
    ["SREM", byKey(courseId, who), id],
    ["EVAL", HDEL_IF_EQUAL, 1, indexKey(courseId), who, id],
    ["ZREM", atKey(courseId), id],
  ]), 4, what);
  for (const n of [all, mine, slot, at]) if (replyCount(n, what) > 1) throw new UnknownReply(what);
  if (at === 1) await giveData(room, [{ slot: CERTS_SLOT(courseId), bytes: ENTRY_BYTES }]);
}

/**
 * Takes the student's slot for the certificate `id`, already written: null
 * when this press holds it, or the standing certificate another press holds,
 * which is the answer. A slot that names a certificate no longer standing is
 * taken only while it still names that one (CERT_SLOT_SWAP), so a press never
 * writes over one made meanwhile. Every reply is read exactly: one that is not
 * what was asked for throws UnknownReply (CX-123 rule 24).
 */
async function claimSlot(courseId: string, who: string, id: string): Promise<Certificate | null> {
  const what = "a certificate's issue";
  for (let i = 0; i < CLAIM_TRIES; i += 1) {
    const [claimed] = exactReplies(await redisPipeline([["HSETNX", indexKey(courseId), who, id]]), 1, what);
    if (claimed === 1) return null;
    if (claimed !== 0) throw new UnknownReply(what);
    const holder = await slotHolder(courseId, who, what);
    // Emptied since (a withdrawal): claim it again.
    if (!holder) continue;
    if (holder.standing) return holder.standing;
    const [swapped] = exactReplies(await redisPipeline([["EVAL", CERT_SLOT_SWAP, 1, indexKey(courseId), who, holder.id, id]]), 1, what);
    if (swapped === 1) return null;
    if (swapped !== 0) throw new UnknownReply(what);
  }
  throw new Error("The student's certificate slot kept changing; nothing was issued");
}

/** What the studio's course page shows of a course's certificates (#4304). */
export type CertificatePage = {
  /** This page of them, newest first, withdrawn ones included; at most MAX_LISTED_CERTS. */
  list: Certificate[];
  /** Every certificate id the course's set holds, withdrawn ones too. */
  total: number;
  /** How many stand now: one per student whose slot names one. */
  standing: number;
  /**
   * Issued before the by-time list was kept and not on it yet, while the studio's walk still adds them (0 once the walk
   * is done: what is left is a record that is gone or does not read, which no page can show).
   */
  unlisted: number;
  /** The store's data room was full on this draw, so none of them could be added now. */
  roomFull: boolean;
  /**
   * The walk could not go on this draw: its place does not read, or a reply on the way did not (rule 24). Said as such,
   * never as more being added (Claude 3 wSUb3's LEVE on #5481).
   */
  walkUnread: boolean;
  /** Whether an older page follows this one. */
  more: boolean;
};

/**
 * A page of the certificates issued for a course, newest first, withdrawn ones
 * included; null when Redis answered in a shape that cannot be read (rule 24),
 * so the studio never says "No certificates yet" while some were issued. Only
 * Redis's own empty set is none; a certificate that is gone (nil) or whose
 * record is itself malformed is skipped, as before, so one broken record
 * never hides the rest.
 *
 * One draw reads a bounded page (#4304): the counts, a page of the by-time list (atKey) and its records in one MGET,
 * whatever the course holds. A course whose set holds certificates issued before that list was kept gets at most
 * CERT_BACKFILL_PER_DRAW of them added on each draw that brings the store's room (`room`), by the walk (addOlder). A
 * walk that does not read is left for the next draw and never hides the page (Claude 5 iYnra's NIT 8 on #5481).
 * `page` is 0 for the newest.
 */
export async function certificatesFor(courseId: string, options: { room?: DataStore; page?: number } = {}): Promise<CertificatePage | null> {
  const empty: CertificatePage = { list: [], total: 0, standing: 0, unlisted: 0, roomFull: false, walkUnread: false, more: false };
  if (!isRedisConfigured()) return empty;
  const page = Number.isSafeInteger(options.page) && (options.page as number) > 0 ? (options.page as number) : 0;
  const counted = plainList(await redisPipeline([["SCARD", allKey(courseId)], ["ZCARD", atKey(courseId)], ["HLEN", indexKey(courseId)], ["GET", atCursorKey(courseId)]]));
  if (!counted || counted.length !== 4 || !counted.slice(0, 3).every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return null;
  const [total, listedBefore, standing] = counted as number[];
  if (total === 0) return empty;
  const state = readWalk(counted[3]);
  let listed = listedBefore;
  let roomFull = false;
  let done = state === "done" || listed >= total;
  // A place that does not read is left alone, never started again on a guess, and the page says the walk cannot go on.
  let walkUnread = !done && state === null;
  if (!done && options.room && state !== null && state !== "done") {
    const walked = await addOlder(courseId, options.room, state).catch((error: unknown) => {
      console.error("the studio's walk of a course's older certificates failed; the next draw tries again", courseId, error);
      return null;
    });
    if (walked) {
      listed += walked.added;
      roomFull = walked.roomFull;
      done = walked.done;
    } else walkUnread = true;
  }
  const unlisted = done ? 0 : Math.max(0, total - listed);
  const from = page * MAX_LISTED_CERTS;
  const read = plainList(await redisPipeline([["ZREVRANGE", atKey(courseId), from, from + MAX_LISTED_CERTS]]));
  if (!read || read.length !== 1) return null;
  const ids = plainList(read[0]);
  if (!ids || ids.some((id) => typeof id !== "string")) return null;
  const more = ids.length > MAX_LISTED_CERTS;
  const valid = (ids as string[]).slice(0, MAX_LISTED_CERTS).filter((id) => CERT_ID_PATTERN.test(id));
  if (valid.length === 0) return { list: [], total, standing, unlisted, roomFull, walkUnread, more };
  const fetched = plainList(await redisPipeline([["MGET", ...valid.map(certKey)]]));
  if (!fetched || fetched.length !== 1) return null;
  const rows = plainList(fetched[0]);
  if (!rows || rows.length !== valid.length || rows.some((row) => row !== null && typeof row !== "string")) return null;
  const list = rows
    .map(parseCertificate)
    .filter((c): c is Certificate => c !== null && c.courseId === courseId)
    .sort((a, b) => b.issuedAt - a.issuedAt);
  return { list, total, standing, unlisted, roomFull, walkUnread, more };
}

/** How long the walk's place is kept: past it, the walk starts again at the start, which only reads again. */
export const CERT_WALK_SECONDS = 60 * 86_400;
/**
 * Where the studio's walk of a course's set stands (#4304): the SSCAN cursor, how far into that cursor's page it has
 * looked, and whether this cycle added any; or "done" once a whole cycle added none, so what is left can never be
 * added (a record that is gone, does not read or is another course's) and the walk stops (Claude 5 iYnra's LEVE 4 on
 * #5481). Null for a value that does not read: the walk is left alone, never started again on a guess.
 */
type Walk = { cursor: string; offset: number; added: boolean; fresh?: boolean };
function readWalk(raw: unknown): Walk | "done" | null {
  if (raw === null || raw === undefined) return { cursor: "0", offset: 0, added: false, fresh: true };
  if (raw === "done") return "done";
  if (typeof raw !== "string") return null;
  const m = /^([0-9]{1,20}):([0-9]{1,6}):([01])$/.exec(raw);
  return m ? { cursor: m[1], offset: Number(m[2]), added: m[3] === "1" } : null;
}
const walkValue = (walk: Walk | "done") => (walk === "done" ? "done" : `${walk.cursor}:${walk.offset}:${walk.added ? 1 : 0}`);
/** The room the walk's place takes (dataBytes of its longest value, one entry), for CERT_WALK_SECONDS at a time. */
const WALK_BYTES = dataBytes(["99999999999999999999:999999:1"], 1);

/**
 * One step of the studio's walk of a course's set (#4304): at most CERT_BACKFILL_PER_DRAW ids of the SSCAN page the
 * walk stands on, from its place in that page (so a page larger than a step, as SSCAN may return on a small set, is
 * walked a step at a time, never stalled), those not yet on the by-time list (ZMSCORE), their records read (MGET), and
 * those of this course added at the time each was issued (ZADD NX). Each added entry's room is taken before the write
 * and given back for each one another draw added meanwhile; an id whose record went meanwhile is taken off again
 * (dropIfErased). A full room adds nothing and keeps the walk's place, so the same ids are tried on a later draw. At
 * the end of the set, a cycle that added none marks the walk done. The walk's place is a key of its own, its room taken
 * for CERT_WALK_SECONDS when it is first written, kept that long and then gone (Claude 5 iYnra's LEVE 5 on #5481).
 * Throws when a reply does not read (rule 24); the caller then leaves the walk for the next draw.
 */
async function addOlder(courseId: string, room: DataStore, walk: Walk): Promise<{ added: number; roomFull: boolean; done: boolean }> {
  const what = "the studio's walk of a course's older certificates";
  const [scannedRaw] = exactReplies(await redisPipeline([["SSCAN", allKey(courseId), walk.cursor, "COUNT", CERT_BACKFILL_PER_DRAW]]), 1, what);
  const reply = plainList(scannedRaw);
  if (!reply || reply.length !== 2 || typeof reply[0] !== "string" || !/^[0-9]{1,20}$/.test(reply[0])) throw new UnknownReply(what);
  const members = plainList(reply[1]);
  if (!members || members.some((id) => typeof id !== "string")) throw new UnknownReply(what);
  const page = (members as string[]).filter((id) => CERT_ID_PATTERN.test(id));
  const step = page.slice(walk.offset, walk.offset + CERT_BACKFILL_PER_DRAW);
  let missing: string[] = [];
  if (step.length) {
    const [scoredRaw] = exactReplies(await redisPipeline([["ZMSCORE", atKey(courseId), ...step]]), 1, what);
    const scores = plainList(scoredRaw);
    if (!scores || scores.length !== step.length || scores.some((x) => x !== null && typeof x !== "string" && typeof x !== "number")) throw new UnknownReply(what);
    missing = step.filter((_, i) => scores[i] === null);
  }
  let added = 0;
  if (missing.length) {
    const [rowsRaw] = exactReplies(await redisPipeline([["MGET", ...missing.map(certKey)]]), 1, what);
    const rows = plainList(rowsRaw);
    if (!rows || rows.length !== missing.length || rows.some((row) => row !== null && typeof row !== "string")) throw new UnknownReply(what);
    const pairs: (string | number)[] = [];
    const adding: string[] = [];
    rows.forEach((raw, i) => {
      const record = parseCertificate(raw);
      if (record && record.courseId === courseId) {
        pairs.push(record.issuedAt, missing[i]);
        adding.push(missing[i]);
      }
    });
    if (adding.length) {
      try {
        await needData(room, [{ slot: CERTS_SLOT(courseId), bytes: adding.length * ENTRY_BYTES }]);
      } catch (error) {
        // Full: nothing is added now and the walk keeps its place, so these are tried again on a later draw.
        if (error instanceof DataRoomError) return { added: 0, roomFull: true, done: false };
        throw error;
      }
      const [countRaw] = exactReplies(await redisPipeline([["ZADD", atKey(courseId), "NX", ...pairs]]), 1, what);
      const count = replyCount(countRaw, what);
      // Unknown how many were added: the room taken stays taken (it only counts too much), and the walk is not moved.
      if (count > adding.length) throw new UnknownReply(what);
      if (count < adding.length) await giveData(room, [{ slot: CERTS_SLOT(courseId), bytes: (adding.length - count) * ENTRY_BYTES }]);
      added = count;
      if (count > 0) await dropIfErased(courseId, adding, room);
    }
  }
  const offset = walk.offset + CERT_BACKFILL_PER_DRAW;
  const cycleAdded = walk.added || added > 0;
  const next: Walk | "done" =
    offset < page.length ? { cursor: walk.cursor, offset, added: cycleAdded }
    : reply[0] !== "0" ? { cursor: reply[0], offset: 0, added: cycleAdded }
    : cycleAdded ? { cursor: "0", offset: 0, added: false }
    : "done";
  // A first place that does not fit is said as a full room, never a walk that silently never moves (Claude 5 iYwjc's
  // LEVE A on #5481): the step is tried again on a later draw, and what it added stays added (ZADD NX).
  const kept = await keepWalk(courseId, room, walk, next);
  return { added, roomFull: !kept, done: kept && next === "done" };
}

/**
 * Writes the walk's place: the first write takes its room for CERT_WALK_SECONDS and sets that expiry (SET NX EX); later
 * writes keep it (SET XX KEEPTTL), so the room taken is the key's for exactly as long as it lives. False when a first
 * write finds the room full: nothing is written, and the caller says the room is full. A room that could not be read
 * throws, and the walk is left for the next draw.
 */
async function keepWalk(courseId: string, room: DataStore, before: Walk, next: Walk | "done"): Promise<boolean> {
  const what = "the studio's walk of a course's older certificates";
  // Only a walk whose place was not kept yet (no key) takes room; one that went round and starts again keeps its key.
  if (before.fresh) {
    const now = Date.now();
    const taken = await takeData(room, [{ until: now + CERT_WALK_SECONDS * 1000, bytes: WALK_BYTES }], now);
    if (!taken.ok) {
      if (taken.reason === "full") return false;
      throw new UnknownReply(what);
    }
    const [set] = exactReplies(await redisPipeline([["SET", atCursorKey(courseId), walkValue(next), "NX", "EX", CERT_WALK_SECONDS]]), 1, what);
    if (set !== "OK" && set !== null) throw new UnknownReply(what);
    if (set === null) await redisPipeline([["SET", atCursorKey(courseId), walkValue(next), "XX", "KEEPTTL"]]);
    return true;
  }
  const [set] = exactReplies(await redisPipeline([["SET", atCursorKey(courseId), walkValue(next), "XX", "KEEPTTL"]]), 1, what);
  if (set !== "OK" && set !== null) throw new UnknownReply(what);
  return true;
}

/**
 * Withdraws a certificate. The page stays and says it was withdrawn, and the
 * student may issue it again. Only a certificate of this course is touched.
 * `why` "refund": withdrawn because its course's payment was given back
 * (withdrawForRefund), so its page no longer shows the name.
 */
export async function withdrawCertificate(courseId: string, id: string, why?: "refund"): Promise<boolean> {
  const found = await readCertificate(id);
  if (!found || found.courseId !== courseId) return false;
  if (!found.withdrawnAt) {
    const marked: Certificate = { ...found, withdrawnAt: Math.floor(Date.now() / 1000), ...(why ? { withdrawnFor: why } : {}) };
    // XX: only while it is still there, so a withdrawal racing the person's deletion never writes it back.
    const [written] = exactReplies(await redisPipeline([["SET", certKey(id), JSON.stringify(marked), "XX"]]), 1, "a certificate's withdrawal");
    if (written === null) return false;
    // Unknown whether it was marked withdrawn: the slot is not freed for a second one (CX-123 rule 24).
    if (written !== "OK") throw new UnknownReply("a certificate's withdrawal");
  }
  // Freed only while it still names this one (CERT_SLOT_FREE): a press that
  // took it for a new certificate meanwhile keeps it. Read exactly: 1 or 0,
  // anything else is unknown and never reported as done (CX-123 rules 24, 25).
  const [freed] = exactReplies(await redisPipeline([["EVAL", CERT_SLOT_FREE, 1, indexKey(courseId), emailKey(found.email), id]]), 1, "a certificate's withdrawal");
  if (freed !== 1 && freed !== 0) throw new UnknownReply("a certificate's withdrawal");
  return true;
}

/** How many of a student's earlier certificates one withdrawal for a refund marks at the most (Codex N1, U and X6 on #3409). */
export const REFUND_WALK_IDS = 1;
/** SSCAN's COUNT while a withdrawal for a refund walks the student's list: a hint, so a page may hold a few more. */
export const REFUND_WALK_SCAN = 10;
/** The refunded payment a walk is for, as its "done" mark names it: a Stripe id, never empty. */
export const REFUND_WALK_PAYMENT = /^[A-Za-z0-9_]{1,255}$/;
/** How long a walk's place is kept between calls: longer than the refund pass takes to come back to the row. */
export const REFUND_WALK_SECONDS = 60 * 86_400;
/** The ids of the student's list a walk has read and not yet looked at (a list), and where its SSCAN stands (a string). */
const walkKey = (courseId: string, who: string) => `nl:course:${courseId}:certs:rw:${who}`;
const walkCursorKey = (courseId: string, who: string) => `nl:course:${courseId}:certs:rwc:${who}`;

/** What one withdrawal for a refund did: whether it changed a certificate, and whether the student's list has more to look at. */
export type RefundWithdrawal = { changed: boolean; more: boolean };

/**
 * Withdraws the certificates a student was issued for a course because the payment that gave them the course was
 * given back in full and the course no longer opens for them (lib/certificate-refunds.ts; owner decision DONO-18):
 * the one standing is marked withdrawn for a refund, and so is every other one of the course the student was issued,
 * withdrawn already by the creator or replaced since (review of #3409, Claude 5, MÉDIO 1), keeping when it was
 * withdrawn; so no page of theirs shows the name. Found by the student's slot and their own list (byKey); one issued
 * before that list was kept (17 October 2026) and no longer in the slot is not reached here, and stays for the
 * creator to withdraw.
 *
 * The student's list is walked a few at a time, never read whole (Codex N1, U and X6 on #3409: the list has no
 * ceiling of its own): each call reads one SSCAN page when the ids it kept are used up, and looks at REFUND_WALK_IDS
 * of them; `more` says the list holds more, and the caller comes back to the row on a later pass, inside the
 * month's checks. So one call's commands and bytes are bounded whatever the list holds
 * (CERTIFICATE_PASS_CHECK_COMMANDS, tests/plan-cost-registry.ts). The walk's place is kept beside the list and goes
 * with the person and the store. Looking at a certificate again is harmless: one marked for the refund is skipped.
 * `changed` is true when one was changed now; running it again after `more` is false changes nothing. Every reply is
 * read exactly: one that is not what was asked for throws UnknownReply (CX-123 rule 24), and the caller tries again on
 * its next run, from the place kept.
 */
export async function withdrawForRefund(courseId: string, email: string, refund: string): Promise<RefundWithdrawal> {
  if (!isRedisConfigured()) return { changed: false, more: false };
  const what = "a certificate's withdrawal for a refund";
  // The payment the walk is for: its "done" mark names it, so a later refund of another payment walks the list again.
  if (!REFUND_WALK_PAYMENT.test(refund)) throw new Error(`${what}: the refunded payment is not named`);
  const doneMark = `done:${refund}`;
  const who = emailKey(email);
  let changed = false;
  const holder = await slotHolder(courseId, who, what);
  if (holder?.standing) {
    if (await withdrawCertificate(courseId, holder.id, "refund")) changed = true;
    // Nothing withdrawn while the slot still names one that stands: its record read in a shape that says nothing, never "none".
    else if ((await slotHolder(courseId, who, what))?.standing) throw new UnknownReply(what);
  }
  const list = walkKey(courseId, who);
  const place = walkCursorKey(courseId, who);
  const [cursorRaw, keptRaw] = exactReplies(await redisPipeline([["GET", place], ["LRANGE", list, 0, REFUND_WALK_IDS - 1]]), 2, what);
  if (cursorRaw !== null && (typeof cursorRaw !== "string" || !/^(?:\d{1,20}|done(?::[A-Za-z0-9_]{1,255})?)$/.test(cursorRaw))) throw new UnknownReply(what);
  // Walked to its end already for this payment: nothing of the list is looked at again (the pass coming back to the
  // row), until the mark ends or goes with the person. A walk done for another payment, or a mark from before it named
  // one, is walked again from the start: a later refund (the course bought again, a certificate issued and replaced
  // since) must reach the certificates the earlier walk did not see (Claude 4 AA's LEVE on #3409). Looking again is
  // harmless: one marked for the refund is skipped.
  if (cursorRaw === doneMark) return { changed, more: false };
  const kept = plainList(keptRaw);
  if (!kept || !kept.every((id) => typeof id === "string")) throw new UnknownReply(what);
  let ids = kept as string[];
  // Where the SSCAN stands: "0" before the first page and after the last, so a list read to its end says "no more".
  let cursor = cursorRaw === null || cursorRaw.startsWith("done") ? "0" : cursorRaw;
  if (ids.length === 0) {
    const [page] = exactReplies(await redisPipeline([["SSCAN", byKey(courseId, who), cursor, "COUNT", REFUND_WALK_SCAN]]), 1, what);
    const parts = plainList(page);
    const next = parts?.[0];
    const found = plainList(parts?.[1]);
    if (!parts || parts.length !== 2 || typeof next !== "string" || !/^\d{1,20}$/.test(next) || !found || !found.every((id) => typeof id === "string")) throw new UnknownReply(what);
    // The page's ids are kept before any is looked at, with where the scan goes next: a call stopped part way comes
    // back to the same ids, never to the next page with these skipped.
    const queue = (found as string[]).filter((id) => CERT_ID_PATTERN.test(id));
    const writes: (string | number)[][] = [["SET", place, next, "EX", REFUND_WALK_SECONDS]];
    if (queue.length) writes.push(["RPUSH", list, ...queue], ["EXPIRE", list, REFUND_WALK_SECONDS]);
    const wrote = exactReplies(await redisPipeline(writes), writes.length, what);
    if (wrote[0] !== "OK" || (queue.length && (replyCount(wrote[1], what) < queue.length || replyCount(wrote[2], what) !== 1))) throw new UnknownReply(what);
    cursor = next;
    ids = queue.slice(0, REFUND_WALK_IDS);
  }
  if (ids.length) {
    const [rows] = exactReplies(await redisPipeline([["MGET", ...ids.map(certKey)]]), 1, what);
    const values = plainList(rows);
    if (!values || values.length !== ids.length || !values.every((raw) => raw === null || typeof raw === "string")) throw new UnknownReply(what);
    for (let j = 0; j < ids.length; j += 1) {
      const found = parseCertificate(values[j]);
      if (!found || found.courseId !== courseId || found.withdrawnFor === "refund") continue;
      if (!found.withdrawnAt) {
        // One still standing that the slot does not name: withdrawn for the refund as the standing one is.
        if (await withdrawCertificate(courseId, ids[j], "refund")) changed = true;
        continue;
      }
      const marked: Certificate = { ...found, withdrawnFor: "refund" };
      // XX: only while it is still there, so this never writes back a certificate the person's deletion took.
      const [written] = exactReplies(await redisPipeline([["SET", certKey(ids[j]), JSON.stringify(marked), "XX"]]), 1, what);
      if (written === null) continue;
      if (written !== "OK") throw new UnknownReply(what);
      changed = true;
    }
    // Looked at: taken off the walk's list only now, so a call stopped above looks at them again.
    const [left] = exactReplies(await redisPipeline([["LTRIM", list, ids.length, -1]]), 1, what);
    if (left !== "OK") throw new UnknownReply(what);
  }
  // More while the walk's list holds ids not looked at, or its SSCAN has pages left; the walk's place goes once done.
  const [remaining] = exactReplies(await redisPipeline([["LLEN", list]]), 1, what);
  const queued = replyCount(remaining, what);
  if (queued > 0 || cursor !== "0") return { changed, more: true };
  // Done: the ids it kept go, and its place says so, so the list is not walked again for this refund.
  const [ended, cleared] = exactReplies(await redisPipeline([["SET", place, doneMark, "EX", REFUND_WALK_SECONDS], ["DEL", list]]), 2, what);
  if (ended !== "OK" || replyCount(cleared, what) > 1) throw new UnknownReply(what);
  return { changed, more: false };
}

/**
 * Deletes every certificate one student was issued in these courses
 * (lib/person-erasure.ts): its page stops proving anything and says it was
 * not found. Found by the student's own list, and, for certificates issued
 * before that list was kept, by reading the course's certificates when it
 * has LEGACY_SCAN or fewer; a standing one is always found by its slot.
 * A reply that is not exactly what was asked for throws UnknownReply, and a
 * certificate whose deletion is unknown keeps the references that find it.
 */
export async function forgetCertificatesPerson(courseIds: string[], email: string, room?: DataStore): Promise<number> {
  if (!courseIds.length || !isRedisConfigured()) return 0;
  const who = emailKey(email);
  const address = email.trim().toLowerCase();
  const what = "the deletion of a person's certificates";
  // Every reply read exactly (lib/redis-exact.ts): one that is not what was
  // asked for throws UnknownReply before any reference that finds a
  // certificate is removed, so a retry still finds it.
  const ids = (raw: unknown): string[] => {
    const list = plainList(raw);
    if (!list || !list.every((id) => typeof id === "string")) throw new UnknownReply(what);
    return list as string[];
  };
  let gone = 0;
  for (const courseId of courseIds) {
    const [mine, current, size] = exactReplies(await redisPipeline([["SMEMBERS", byKey(courseId, who)], ["HGET", indexKey(courseId), who], ["SCARD", allKey(courseId)]]), 3, what);
    if (current !== null && typeof current !== "string") throw new UnknownReply(what);
    const known = new Set<string>([...ids(mine), ...(typeof current === "string" ? [current] : [])]);
    const [all] = replyCount(size, what) > 0 && (size as number) <= LEGACY_SCAN ? exactReplies(await redisPipeline([["SMEMBERS", allKey(courseId)]]), 1, what) : [[]];
    const others = ids(all).filter((id) => CERT_ID_PATTERN.test(id) && !known.has(id));
    for (let i = 0; i < others.length; i += 500) {
      const chunk = others.slice(i, i + 500);
      const [rows] = exactReplies(await redisPipeline([["MGET", ...chunk.map(certKey)]]), 1, what);
      const values = plainList(rows);
      if (!values || values.length !== chunk.length || !values.every((raw) => raw === null || typeof raw === "string")) throw new UnknownReply(what);
      values.forEach((raw, j) => {
        const record = certificateRecord(raw);
        if (typeof record?.email === "string" && record.email.trim().toLowerCase() === address) known.add(chunk[j]);
      });
    }
    const list = [...known].filter((id) => CERT_ID_PATTERN.test(id));
    // Each record taken out with GETDEL, so only the deletion that removed it
    // gives back what it took when issued (the record as made, withdrawnAt 0):
    // two deletions at once never give the same room back twice. Each reply
    // must be the record or a confirmed none (null), one per certificate.
    let freed = 0;
    let unknown = false;
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      const rows = plainList(await redisPipeline(chunk.map((id) => ["GETDEL", certKey(id)])));
      if (!rows || rows.length !== chunk.length) {
        unknown = true;
        continue;
      }
      for (const raw of rows) {
        if (raw === null) continue;
        if (typeof raw !== "string") {
          unknown = true;
          continue;
        }
        try {
          const value = JSON.parse(raw) as Record<string, unknown>;
          // Back to its issue-time shape: not withdrawn, and without the refund's mark (withdrawnFor), which issue never wrote.
          if (value && typeof value === "object") freed += dataBytes([JSON.stringify({ ...value, withdrawnAt: 0, withdrawnFor: undefined })], 3);
        } catch {
          // Unreadable: nothing is known of what it took, so nothing is given back for it.
        }
      }
    }
    // What was confirmed taken comes back now; a retry finds it gone and gives nothing again.
    if (room && freed > 0) await giveData(room, [{ slot: CERTS_SLOT(courseId), bytes: freed }]);
    // A certificate whose deletion is unknown keeps every reference to it, for the retry.
    if (unknown) throw new UnknownReply(what);
    const replies = exactReplies(
      await redisPipeline([
        // With the student's list, a refund's walk of it (withdrawForRefund): its ids and its place.
        ["DEL", byKey(courseId, who), walkKey(courseId, who), walkCursorKey(courseId, who)],
        ["HDEL", indexKey(courseId), who],
        ...(list.length ? [["SREM", allKey(courseId), ...list], ["ZREM", atKey(courseId), ...list]] : []),
      ]),
      list.length ? 4 : 2,
      what,
    );
    replies.forEach((n) => replyCount(n, what));
    // Each place on the by-time list this removed gives back the entry it took (#4304); one issued before that list
    // was kept and never added to it took none, and gets none back.
    const takenOffAt = list.length ? replyCount(replies[3], what) : 0;
    if (room && takenOffAt > 0) await giveData(room, [{ slot: CERTS_SLOT(courseId), bytes: takenOffAt * ENTRY_BYTES }]);
    gone += list.length;
  }
  return gone;
}

/**
 * Every certificate of these courses that is a person's, found exactly as the
 * erasure finds them (their own list, the one standing, and the old ones by
 * address), withdrawn ones included: for the copy of their data (619 [SZ3]).
 * Only reads.
 */
export async function certificatesOf(courseIds: string[], email: string): Promise<CertificateCopy[]> {
  if (!courseIds.length || !isRedisConfigured()) return [];
  const who = emailKey(email);
  const address = email.trim().toLowerCase();
  const out: CertificateCopy[] = [];
  const what = "a person's certificate copy";
  const idsOf = (raw: unknown): string[] => {
    const list = plainList(raw);
    if (!list || !list.every((id) => typeof id === "string" && CERT_ID_PATTERN.test(id))) throw new UnknownReply(what);
    return list as string[];
  };
  const countOf = (raw: unknown): number => {
    const count = replyCount(raw, what);
    if (!Number.isSafeInteger(count)) throw new UnknownReply(what);
    return count;
  };
  for (const courseId of courseIds) {
    const [mine, current, size] = exactReplies(
      await redisPipeline([["SMEMBERS", byKey(courseId, who)], ["HGET", indexKey(courseId), who], ["SCARD", allKey(courseId)]]),
      3,
      what,
    );
    if (current !== null && (typeof current !== "string" || !CERT_ID_PATTERN.test(current))) throw new UnknownReply(what);
    const count = countOf(size);
    const [all] = count > 0 && count <= LEGACY_SCAN
      ? exactReplies(await redisPipeline([["SMEMBERS", allKey(courseId)]]), 1, what)
      : [[]];
    const ids = new Set<string>([
      ...idsOf(mine),
      ...(typeof current === "string" ? [current] : []),
    ]);
    const candidates = [...new Set([...ids, ...idsOf(all)])];
    for (let i = 0; i < candidates.length; i += 500) {
      const chunk = candidates.slice(i, i + 500);
      const [rows] = exactReplies(await redisPipeline([["MGET", ...chunk.map(certKey)]]), 1, what);
      const values = plainList(rows);
      if (!values || values.length !== chunk.length || !values.every((raw) => raw === null || typeof raw === "string")) {
        throw new UnknownReply(what);
      }
      values.forEach((raw, k) => {
        const record = certificateRecord(raw);
        if (record && (ids.has(chunk[k]) || (typeof record.email === "string" && record.email.trim().toLowerCase() === address))) out.push(copyCertificate(record));
      });
    }
  }
  return out;
}

/** How many certificates each course keeps: what deleting a person may read (lib/person-erasure.ts). */
export async function certificateCount(courseIds: string[]): Promise<number> {
  if (!courseIds.length || !isRedisConfigured()) return 0;
  const what = "the certificates counted for a person's erasure";
  const counts = exactReplies(await redisPipeline(courseIds.map((c) => ["SCARD", allKey(c)])), courseIds.length, what);
  return counts.reduce<number>((sum, raw) => {
    const count = replyCount(raw, what);
    if (!Number.isSafeInteger(count)) throw new UnknownReply(what);
    return sum + Math.min(count, LEGACY_SCAN);
  }, 0);
}
