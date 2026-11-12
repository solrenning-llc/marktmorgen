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
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReply, exactReplies, plainList, replyCount } from "@/lib/redis-exact";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { type Course, lessonsInOrder } from "@/lib/course";
import { requiredQuizLessons } from "@/lib/quiz";
import { emailKey } from "@/lib/learn";
import { randomLetters } from "@/lib/random-letters";

export const CERT_ID_PATTERN = /^[a-z0-9]{16}$/;
export const MIN_CERT_NAME = 2;
export const MAX_CERT_NAME = 80;
/** The most certificates the studio lists for one course. */
export const MAX_LISTED_CERTS = 500;
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
type CertificateCopy = Omit<Certificate, "issuedAt" | "withdrawnAt" | "validUntil"> & Partial<Record<"issuedAt" | "withdrawnAt" | "validUntil", unknown>>;

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

function certificateFields(value: CertificateRecord): Omit<Certificate, "issuedAt" | "withdrawnAt" | "validUntil"> {
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
  return {
    ...certificateFields(value),
    issuedAt: value.issuedAt,
    withdrawnAt: value.withdrawnAt,
    ...(hasExpiration ? { validUntil: value.validUntil as number } : {}),
  };
}

export const certKey = (id: string) => `nl:cert:${id}`;
/** Where a course's certificates are counted in the store's data room (lib/store-data.ts). */
const CERTS_SLOT = (courseId: string) => `cc:${courseId}`;
const indexKey = (courseId: string) => `nl:course:${courseId}:certs`;
export const allKey = (courseId: string) => `nl:course:${courseId}:certs:all`;
/** Every certificate one student was ever issued for a course, withdrawn ones too (added 17 October 2026), so deleting them finds each. */
const byKey = (courseId: string, who: string) => `nl:course:${courseId}:certs:by:${who}`;
/** How many certificates of a course deleting a person looks through for ones issued before byKey was kept. */
const LEGACY_SCAN = 500;

export async function readCertificate(id: string): Promise<Certificate | null> {
  if (!isRedisConfigured() || !CERT_ID_PATTERN.test(id)) return null;
  const [raw] = await redisPipeline([["GET", certKey(id)]]);
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

/** How many times one press looks at the slot again when it changed between two reads. */
const CLAIM_TRIES = 3;

export type IssueResult = { ok: true; certificate: Certificate; fresh: boolean } | { ok: false; reason: "name" };

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
  // Its room first: the record, kept for good, and its places in the course's lists.
  const bytes = dataBytes([JSON.stringify(certificate)], 3);
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
    return { ok: true, certificate: existing, fresh: false };
  }
  await redisPipeline([["SADD", allKey(input.course.id), id], ["SADD", byKey(input.course.id, input.who), id]]);
  return { ok: true, certificate, fresh: true };
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

/**
 * Every certificate issued for a course, newest first, withdrawn ones
 * included; null when Redis answered in a shape that cannot be read (rule 24),
 * so the studio never says "No certificates yet" while some were issued. Only
 * Redis's own empty set is none; a certificate that is gone (nil) or whose
 * record is itself malformed is skipped, as before, so one broken record
 * never hides the rest.
 */
export async function certificatesFor(courseId: string): Promise<{ list: Certificate[]; total: number } | null> {
  if (!isRedisConfigured()) return { list: [], total: 0 };
  const read = plainList(await redisPipeline([["SMEMBERS", allKey(courseId)]]));
  if (!read || read.length !== 1) return null;
  const members = plainList(read[0]);
  if (!members || members.some((id) => typeof id !== "string")) return null;
  const valid = (members as string[]).filter((id) => CERT_ID_PATTERN.test(id));
  if (valid.length === 0) return { list: [], total: 0 };
  const rows = plainList(await redisPipeline(valid.map((id) => ["GET", certKey(id)])));
  if (!rows || rows.length !== valid.length || rows.some((row) => row !== null && typeof row !== "string")) return null;
  const list = rows
    .map(parseCertificate)
    .filter((c): c is Certificate => c !== null && c.courseId === courseId)
    .sort((a, b) => b.issuedAt - a.issuedAt);
  return { list: list.slice(0, MAX_LISTED_CERTS), total: list.length };
}

/**
 * Withdraws a certificate. The page stays and says it was withdrawn, and the
 * student may issue it again. Only a certificate of this course is touched.
 */
export async function withdrawCertificate(courseId: string, id: string): Promise<boolean> {
  const found = await readCertificate(id);
  if (!found || found.courseId !== courseId) return false;
  if (!found.withdrawnAt) {
    // XX: only while it is still there, so a withdrawal racing the person's deletion never writes it back.
    const [written] = exactReplies(await redisPipeline([["SET", certKey(id), JSON.stringify({ ...found, withdrawnAt: Math.floor(Date.now() / 1000) }), "XX"]]), 1, "a certificate's withdrawal");
    if (written === null) return false;
    // Unknown whether it was marked withdrawn: the slot is not freed for a second one (CX-123 rule 24).
    if (written !== "OK") throw new UnknownReply("a certificate's withdrawal");
  }
  const who = emailKey(found.email);
  const [current] = exactReplies(await redisPipeline([["HGET", indexKey(courseId), who]]), 1, "a certificate's withdrawal");
  if (current === id) await redisPipeline([["HDEL", indexKey(courseId), who]]);
  return true;
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
          if (value && typeof value === "object") freed += dataBytes([JSON.stringify({ ...value, withdrawnAt: 0 })], 3);
        } catch {
          // Unreadable: nothing is known of what it took, so nothing is given back for it.
        }
      }
    }
    // What was confirmed taken comes back now; a retry finds it gone and gives nothing again.
    if (room && freed > 0) await giveData(room, [{ slot: CERTS_SLOT(courseId), bytes: freed }]);
    // A certificate whose deletion is unknown keeps every reference to it, for the retry.
    if (unknown) throw new UnknownReply(what);
    exactReplies(
      await redisPipeline([
        ["DEL", byKey(courseId, who)],
        ["HDEL", indexKey(courseId), who],
        ...(list.length ? [["SREM", allKey(courseId), ...list]] : []),
      ]),
      list.length ? 3 : 2,
      what,
    ).forEach((n) => replyCount(n, what));
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
