/**
 * The emails and the phone notification around a community's live events
 * (lib/community-events.ts), sent by the five-minute mail job.
 *
 *   - Reminders, a day and an hour before, to the members who said they are
 *     coming AND asked to be emailed by the community (the "Email me" box on
 *     their You page, which starts empty). Each carries the same one-click
 *     way to stop as the community's announcements (lib/community-mail.ts):
 *     one switch for the community's emails, which leaves the member in the
 *     community and keeps their places.
 *   - One email when the creator moves an event and one when they cancel it,
 *     to everyone who said they are coming, whether or not they asked for
 *     the community's emails: they planned their day around it. Each move is
 *     its own email, sent once however often the page is pressed or the job
 *     retried; a cancellation is sent once.
 *   - A notification on the creator's phone fifteen minutes before, to open
 *     the room first (lib/phone-alerts.ts, "live").
 *
 * Nothing in the queue is trusted beyond "look at this event now". The event
 * is read again when its moment comes: a reminder planned for a start the
 * event has since moved away from, or for an event since cancelled, is
 * dropped; and who gets it is decided batch by batch as it goes out — still
 * coming, not taken out, and, for a reminder, still let into the community
 * and the event (lib/community-access.ts), so a member whose membership
 * lapsed is not reminded of an event they can no longer open. The emails
 * never carry the way in: they point at the event's page, which shows it
 * from fifteen minutes before, to whoever may come.
 *
 * Each send is written down when it starts, its readers in a list, and goes
 * out a hundred at a time, each batch with its own key so a retry never sends
 * twice; the key a send is made under says which reminder, move or
 * cancellation it is, so the same one is never started twice.
 *
 * A move's or a cancellation's notice whose list of who is coming does not
 * read when it is made (rule 30) is written down all the same, `waiting`,
 * with no readers yet: the change is made and must not go untold. Each run
 * reads the list again, until it reads, while the notice is still of use
 * (as the hour-before reminder: not once the event has begun), and then
 * sends it like any other. A move's notice still waiting when the event is
 * then called off is dropped: the cancellation's email says all.
 *
 * These are the community's own notices about something a member signed up
 * for, sent from the store's name through Marktmorgen's address like the reminders
 * before a booked call, on every plan, and not counted against Pro's monthly
 * emails.
 *
 *   nl:cm:evq                  what is due, by when (lib/community-events.ts plans it)
 *   nl:cm:evmail:<job>         one send (JSON)
 *   nl:cm:evmail:<job>:to      its readers, as member keys, in order (a list)
 *   nl:cm:evmail:<job>:made    written once, so the same send is never started twice
 *   nl:cm:evmailq              sends under way
 */
import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { type BatchMessage, isSenderConfigured, sendBatch } from "@/lib/email";
import { BATCH_SIZE, CHECKED_BATCH_SIZE, bodyHtml, render } from "@/lib/mail";
import { storeSender } from "@/lib/calls";
import { SITE_URL } from "@/lib/site-url";
import type { Store } from "@/lib/store";
import { type CommunityConfig, type Member, readConfig, readMembers } from "@/lib/community";
import { holdsTicket } from "@/lib/community-access";
import { tokenFor } from "@/lib/community-mail";
import { alertCreator } from "@/lib/phone-alerts";
import { JOIN_EARLY_MINUTES } from "@/lib/community-text";
import { communityWords } from "@/lib/buyer-words/community";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import {
  type CommunityEvent,
  EVENT_QUEUE,
  eventAddress,
  eventTimeIn,
  lengthIn,
  mayAttend,
  readEvent,
  rsvpList,
  rsvpNumbers,
  stillGoing,
} from "@/lib/community-events";

export type EventMailKind = "24" | "1" | "moved" | "cancelled";

export type EventMailJob = {
  id: string;
  community: string;
  handle: string;
  event: string;
  kind: EventMailKind;
  /** The start the send is about: a reminder whose event has moved since is dropped. */
  start: number;
  /** For a move: where it was. */
  was: number;
  wasMinutes: number;
  total: number;
  done: number;
  sent: number;
  status: "sending" | "sent" | "failed";
  note: string;
  failures: number;
  /**
   * A notice whose list of who is coming did not read when it was made: no
   * readers written yet, and `total` 0 until they are. False once they are,
   * and absent on every send made with its list.
   */
  waiting?: boolean;
};

const JOBS = "nl:cm:evmailq";
const JOB_ID = /^[0-9a-f]{24}$/;
const jobKey = (id: string) => `nl:cm:evmail:${id}`;
const toKey = (id: string) => `nl:cm:evmail:${id}:to`;
const madeKey = (id: string) => `nl:cm:evmail:${id}:made`;
const lockKey = (id: string) => `nl:cm:evmail:${id}:lock`;
const KEEP_SECONDS = 30 * 86_400;
const HOUR = 3_600_000;
/** How many due entries one run takes on. The rest wait five minutes. */
const QUEUE_BATCH = 200;

const KINDS: readonly string[] = ["24", "1", "moved", "cancelled"] satisfies EventMailKind[];
const STATUSES: readonly string[] = ["sending", "sent", "failed"] satisfies EventMailJob["status"][];
const COUNTS = ["start", "was", "wasMinutes", "total", "done", "sent", "failures"] as const;

/**
 * A send's record, only when every field is there in the shape save() writes; anything else is null. Its id alone,
 * or a status or count this code never writes, is a partial record, not a send (Codex P on #2954): a reminder is
 * never dropped as made on it, and a send half done is never taken out of line or written over on it.
 */
function parseJob(raw: unknown): EventMailJob | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const job = value as Record<string, unknown>;
  if (typeof job.id !== "string" || !JOB_ID.test(job.id)) return null;
  if (typeof job.community !== "string" || typeof job.handle !== "string" || typeof job.event !== "string" || typeof job.note !== "string") return null;
  if (typeof job.kind !== "string" || !KINDS.includes(job.kind)) return null;
  if (typeof job.status !== "string" || !STATUSES.includes(job.status)) return null;
  if (!COUNTS.every((name) => typeof job[name] === "number" && Number.isFinite(job[name]))) return null;
  return value as EventMailJob;
}

async function save(job: EventMailJob): Promise<void> {
  await redisPipeline([["SET", jobKey(job.id), JSON.stringify(job), "EX", KEEP_SECONDS]]);
}

/** Whether the emails telling people an event was called off are still going out. */
export async function cancelNoticeSending(community: string, event: string): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const [members] = await redisPipeline([["SMEMBERS", JOBS]]);
  const ids = (Array.isArray(members) ? members.map(String) : []).filter((id) => JOB_ID.test(id));
  if (!ids.length) return false;
  const raws = await redisPipeline(ids.map((id) => ["GET", jobKey(id)]));
  return raws.some((raw) => {
    const job = parseJob(raw);
    return job !== null && job.community === community && job.event === event && job.kind === "cancelled" && job.status === "sending";
  });
}

/** A send: null when it is not there; a reply in another shape throws UnknownReplyError (CX-123 rule 24). */
export async function readEventJob(id: string): Promise<EventMailJob | null> {
  if (!JOB_ID.test(id) || !isRedisConfigured()) return null;
  const raw = repliesFor(await redisPipeline([["GET", jobKey(id)]]), 1)?.[0];
  if (raw === null) return null;
  // Text that is not a whole send (cut, or partial: Codex P on #2954) is unknown, never "not there".
  const job = typeof raw === "string" ? parseJob(raw) : null;
  if (!job || job.id !== id) throw new UnknownReplyError("an event email's send");
  return job;
}

/**
 * A send asked for whose once-only mark is there but whose send is not (yet): the reminder stays due and is asked
 * for again later, never dropped as made (Codex P on #2954).
 */
export class SendNotMadeYetError extends Error {
  constructor() {
    super("an event email's once-only mark is there but its send is not, yet");
    this.name = "SendNotMadeYetError";
  }
}

/**
 * How long a once-only mark with no send under it is taken to belong to a run still writing the send down. Writing
 * it down is three Redis calls of at most five seconds each (lib/fetch-timeout.ts) after the mark, so a mark this
 * old with no send belongs to no run still going: one that could not let it go, or whose writing failed.
 */
const ORPHAN_MS = 10 * 60_000;

/**
 * The once-only mark was taken: made, only when the send itself is there (put back in line while it is still being
 * sent, in case the run that made it could not); a mark with no send under it is not "made". Young, it belongs to a
 * run still writing the send down, and the send stays due; old (ORPHAN_MS), that very mark is let go (a compare and
 * delete, so a newer mark is never touched) and claimed again with this run's own value, so two runs cannot both
 * take it over. Every reply exact; anything else throws.
 */
async function madeOrTakeOver(id: string, mark: string): Promise<"made" | "ours"> {
  const held = repliesFor(await redisPipeline([["GET", madeKey(id)], ["GET", jobKey(id)]]), 2);
  if (!held || !held.every((raw) => raw === null || typeof raw === "string")) throw new UnknownReplyError("an event email's once-only mark and its send");
  const [was, raw] = held as (string | null)[];
  if (raw !== null) {
    // "Made" only when the text read back is this very send, whole (Codex P on #2954): cut text, a partial record,
    // an id this code never writes or another send's record is unknown, so the reminder stays due and the mark is
    // not taken over on it.
    const send = parseJob(raw);
    if (!send || send.id !== id) throw new UnknownReplyError("an event email's send under its once-only mark");
    if (send.status === "sending") {
      const added = repliesFor(await redisPipeline([["SADD", JOBS, id]]), 1)?.[0];
      if (countOf(added) === null) throw new UnknownReplyError("an event email's send put in line");
    }
    return "made";
  }
  const at = was === null ? Number.NaN : Number(was);
  if (was === null || !(at < Date.now() - ORPHAN_MS)) throw new SendNotMadeYetError();
  await releaseMark(madeKey(id), was);
  const again = await claimMark(madeKey(id), KEEP_SECONDS, mark);
  if (again === "ours") return "ours";
  if (again === "unknown") await releaseMark(madeKey(id), mark);
  throw new SendNotMadeYetError();
}

/**
 * Whether a reminder is still worth sending: the day-before one gives way to the hour-before one. A notice still
 * waiting for its list is asked as the hour-before one is (advanceEventJob).
 */
function stillUseful(kind: EventMailKind, start: number, now: number): boolean {
  if (kind === "24") return now < start - HOUR;
  if (kind === "1") return now < start;
  return true;
}

/**
 * Writes a waiting notice's readers down, in order, then the send with them, every reply exact (Claude 2's focal on
 * #3134), as startJob writes a send's. True only when the whole list was written and then the send; false when any
 * reply is not known or the write failed, so the caller keeps the notice waiting and the next run reads and writes
 * the list again (DEL first, so a list written in part is never sent from).
 */
async function listReaders(job: EventMailJob, readers: string[]): Promise<boolean> {
  const commands: (string | number)[][] = [["DEL", toKey(job.id)]];
  for (let i = 0; i < readers.length; i += 500) commands.push(["RPUSH", toKey(job.id), ...readers.slice(i, i + 500)]);
  commands.push(["EXPIRE", toKey(job.id), KEEP_SECONDS]);
  try {
    const listed = repliesFor(await redisPipeline(commands), commands.length);
    if (!listed || !listed.every((reply) => countOf(reply) !== null)) return false;
    const saved = repliesFor(await redisPipeline([["SET", jobKey(job.id), JSON.stringify(job), "EX", KEEP_SECONDS]]), 1)?.[0];
    return saved === "OK";
  } catch (error) {
    console.error("writing down who a waiting event email goes to failed", error);
    return false;
  }
}

/**
 * Writes a send down, once: the same reminder, move or cancellation asked
 * for again finds it made and starts nothing. Null when there is nobody to
 * send it to, or it was made already. A move's or a cancellation's notice
 * whose list does not read is written down `waiting` (advanceEventJob reads
 * it again); a reminder's throws, and stays queued (runEventQueue).
 */
async function startJob(
  store: Store,
  event: CommunityEvent,
  kind: EventMailKind,
  was: { start: number; minutes: number } | null,
): Promise<EventMailJob | null> {
  const community = store.community?.id;
  if (!community) return null;
  const seq = kind === "moved" ? `m${event.moves}` : kind === "cancelled" ? "x" : `${event.start}`;
  const id = createHash("sha256").update(`${community}|${event.id}|${kind}|${seq}`).digest("hex").slice(0, 24);
  // Who is coming first, read exactly (it throws on a page it cannot read), so no mark is taken for a send that
  // cannot be written down whole (Claude 5 on #2954). A reminder whose list does not read throws, and stays queued
  // (runEventQueue). A move's or a cancellation's notice whose list does not read is written down waiting for it
  // (rule 30): the change it tells of is already made.
  const notice = kind !== "24" && kind !== "1";
  let readers: string[] | null;
  try {
    readers = (await rsvpList(community, event.id)).map((r) => r.key);
  } catch (error) {
    if (!notice) throw error;
    readers = null;
  }
  // Nobody coming: no send, and no mark taken for one.
  if (readers !== null) {
    if (!readers.length) return null;
  }
  // Made once, on an exact claim (lib/claim-mark.ts, CX-123 rule 24): taken is made only when the send is there
  // (madeOrTakeOver); unknown makes nothing and lets go of the mark only while it holds our own value.
  const mark = claimValue();
  let claimed = await claimMark(madeKey(id), KEEP_SECONDS, mark);
  if (claimed === "taken") {
    if ((await madeOrTakeOver(id, mark)) === "made") return null;
    claimed = "ours";
  }
  if (claimed !== "ours") {
    await releaseMark(madeKey(id), mark);
    throw new UnknownReplyError("an event email's once-only mark");
  }
  const job: EventMailJob = {
    id,
    community,
    handle: store.handle,
    event: event.id,
    kind,
    start: event.start,
    was: was?.start ?? 0,
    wasMinutes: was?.minutes ?? 0,
    total: readers?.length ?? 0,
    done: 0,
    sent: 0,
    status: "sending",
    note: "",
    failures: 0,
  };
  if (readers === null) return await startWaiting({ ...job, note: WAITING_NOTE, waiting: true }, mark);
  const commands: (string | number)[][] = [["DEL", toKey(id)]];
  for (let i = 0; i < readers.length; i += 500) commands.push(["RPUSH", toKey(id), ...readers.slice(i, i + 500)]);
  commands.push(["EXPIRE", toKey(id), KEEP_SECONDS]);
  // Everything after the mark is ours, read exactly (Claude 5 on #2954). Before the send is written, a failure lets
  // the mark go, so the next run makes it; once the send may be written, the mark goes only when the send is read
  // back as not there (letting it go otherwise could make it twice), and the next run finds the send and puts it in
  // line, or takes the mark over when no send is there.
  try {
    const listed = repliesFor(await redisPipeline(commands), commands.length);
    if (!listed || !listed.every((reply) => countOf(reply) !== null)) throw new UnknownReplyError("an event email's list of people");
  } catch (error) {
    await releaseMark(madeKey(id), mark);
    throw error instanceof UnknownReplyError ? error : new UnknownReplyError("an event email's list of people");
  }
  try {
    const saved = repliesFor(await redisPipeline([["SET", jobKey(job.id), JSON.stringify(job), "EX", KEEP_SECONDS]]), 1)?.[0];
    if (saved !== "OK") throw new UnknownReplyError("an event email's send");
    const added = repliesFor(await redisPipeline([["SADD", JOBS, id]]), 1)?.[0];
    if (countOf(added) === null) throw new UnknownReplyError("an event email's send put in line");
  } catch (error) {
    // Not known whether the send was written: read back. Not there, the mark is let go, so the next run makes it;
    // there, or not known, the mark stays and the next run finds the send and puts it in line (madeOrTakeOver).
    const back = await redisPipeline([["GET", jobKey(id)]]).then(
      (replies) => repliesFor(replies, 1),
      () => null,
    );
    if (back && back[0] === null) await releaseMark(madeKey(id), mark);
    throw error instanceof UnknownReplyError ? error : new UnknownReplyError("an event email's send");
  }
  return job;
}

/**
 * A notice with its list still to be read, written down with no readers, every reply exact. Not known whether it was
 * written: read back, as startJob does; not there, its once-only mark is let go (only while it holds our value), so
 * asking again makes it; there, or not known, the mark stays and the next ask finds it (madeOrTakeOver).
 */
async function startWaiting(job: EventMailJob, mark: string): Promise<EventMailJob> {
  try {
    const written = repliesFor(await redisPipeline([["SET", jobKey(job.id), JSON.stringify(job), "EX", KEEP_SECONDS], ["SADD", JOBS, job.id]]), 2);
    if (!written || written[0] !== "OK" || countOf(written[1]) === null) throw new UnknownReplyError("an event email's notice waiting for its list");
  } catch (error) {
    const back = await redisPipeline([["GET", jobKey(job.id)]]).then(
      (replies) => repliesFor(replies, 1),
      () => null,
    );
    if (back && back[0] === null) await releaseMark(madeKey(job.id), mark);
    throw error instanceof UnknownReplyError ? error : new UnknownReplyError("an event email's notice waiting for its list");
  }
  return job;
}

const WAITING_NOTE = "We couldn't read who is coming yet. The email waits and goes out once we can.";

/** The creator moved or cancelled an event: the one email to everyone coming. */
export async function queueEventNotice(
  store: Store,
  event: CommunityEvent,
  kind: "moved" | "cancelled",
  was: { start: number; minutes: number } | null,
): Promise<EventMailJob | null> {
  return startJob(store, event, kind, was);
}

/** Runs `each` over `items`, a few at a time. */
async function inTurns<T, R>(items: T[], width: number, each: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        out[i] = await each(items[i]);
      }
    }),
  );
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** A notice's email, which is not a list email: no way to stop it, just why it came. */
function noticeHtml(body: string, why: string, lang: string, sent: string): string {
  return `<!doctype html><html lang="${escapeHtml(lang)}"><body style="margin:0;padding:0;background:#f7f5f0">
<div style="max-width:560px;margin:0 auto;padding:32px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1c1917">
<div style="background:#ffffff;border-radius:16px;padding:28px 24px">${bodyHtml(body)}</div>
<div style="padding:20px 8px 0;font-size:13px;line-height:1.5;color:#57534e">
<p style="margin:0 0 8px">${escapeHtml(why)}</p>
<p style="margin:0">${escapeHtml(sent)}</p>
</div></div></body></html>`;
}

/** What one kind of email says. The event's own words are the creator's; the rest is ours. */
export function eventMailWords(
  store: Pick<Store, "handle" | "name"> & Partial<Pick<Store, "language">>,
  config: Pick<CommunityConfig, "name">,
  event: CommunityEvent,
  job: Pick<EventMailJob, "kind" | "was" | "wasMinutes">,
): { subject: string; body: string; why: string } {
  // In the store's language, like every page its members read.
  const tongue = { language: parseLanguage(store.language) };
  const w = communityWords(tongue.language);
  const page = eventAddress(store, event.id);
  const when = `${eventTimeIn(tongue, event)}, ${lengthIn(tongue, event.minutes)}`;
  if (job.kind === "cancelled") {
    return {
      subject: w.evCanceledSubject(event.title),
      body: w.evCanceledBody(store.name, event.title, config.name, eventTimeIn(tongue, event), `${SITE_URL}/@${store.handle}/community/events`),
      why: w.evWhyOnce(config.name),
    };
  }
  if (job.kind === "moved") {
    const wasWhen = `${eventTimeIn(tongue, { start: job.was, tz: event.tz })}, ${lengthIn(tongue, job.wasMinutes || event.minutes)}`;
    return {
      subject: w.evMovedSubject(event.title),
      body: w.evMovedBody(store.name, event.title, config.name, wasWhen, when, page),
      why: w.evWhyMoved(config.name),
    };
  }
  return {
    subject: w.evReminderSubject(job.kind === "24", event.title),
    body: w.evReminderBody(job.kind === "24", event.title, config.name, when, JOIN_EARLY_MINUTES, page),
    why: w.evWhyReminder(config.name),
  };
}

/** Only a complete positional recipient batch can advance this send. */
async function recipientBatch(id: string, start: number, count: number): Promise<string[] | null> {
  try {
    const reply: unknown = await redisPipeline([["LRANGE", toKey(id), start, start + count - 1]]);
    if (!Array.isArray(reply) || Object.getPrototypeOf(reply) !== Array.prototype || reply.length !== 1 || Reflect.ownKeys(reply).length !== 2) return null;
    const outer = Object.getOwnPropertyDescriptor(reply, "0");
    const rows: unknown = outer && Object.hasOwn(outer, "value") ? outer.value : null;
    if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype || rows.length !== count || Reflect.ownKeys(rows).length !== count + 1) return null;
    const keys: string[] = [];
    for (let index = 0; index < count; index++) {
      const slot = Object.getOwnPropertyDescriptor(rows, String(index));
      if (!slot || !Object.hasOwn(slot, "value") || typeof slot.value !== "string" || !/^[0-9a-f]{32}$/.test(slot.value)) return null;
      keys.push(slot.value);
    }
    return new Set(keys).size === count ? keys : null;
  } catch { return null; }
}

/**
 * Moves one send on for as long as `deadline` allows. Safe to call from two
 * places at once: only one holds the send at a time.
 */
export async function advanceEventJob(
  id: string,
  load: (handle: string) => Promise<Store | null>,
  deadline: number,
): Promise<EventMailJob | null> {
  // One run at a time, on an exact claim: held by another run, or not known to be ours, nothing is done this time.
  const lock = claimValue();
  if ((await claimMark(lockKey(id), 90, lock)) !== "ours") return null;
  try {
    // Its record not read (Claude 5 on #2954): nothing is done this time and it stays in line, never taken out of it.
    let job: EventMailJob | null;
    try {
      job = await readEventJob(id);
    } catch (error) {
      if (error instanceof UnknownReplyError) return null;
      throw error;
    }
    if (!job || job.status !== "sending") {
      await redisPipeline([["SREM", JOBS, id]]);
      return job;
    }
    const store = await load(job.handle).catch(() => null);
    const config = store?.community?.id === job.community ? await readConfig(job.community) : null;
    const event = config ? await readEvent(job.community, job.event) : null;
    const finish = async (status: "sent" | "failed", note: string) => {
      job = { ...(job as EventMailJob), status, note };
      await save(job);
      await redisPipeline([["DEL", toKey(id)], ["SREM", JOBS, id]]);
      return job;
    };
    if (!store || !config || !event) return await finish("failed", "The event is not there anymore.");
    const reminder = job.kind === "24" || job.kind === "1";
    // A reminder for a time the event has left, or for an event called off, is no use.
    if (reminder && (event.cancelled || event.start !== job.start || !stillUseful(job.kind, event.start, Date.now()))) {
      return await finish("sent", "No longer due.");
    }
    if (job.waiting) {
      // A move's notice gives way to the cancellation's, which says all.
      if (job.kind === "moved" && event.cancelled) return await finish("sent", "No longer due: the event was canceled, and that email says so.");
      // Read again only while it is of use: as the hour-before reminder, not once the event has begun.
      if (!stillUseful("1", event.start, Date.now())) return await finish("failed", "We couldn't read who was coming before the event's time. Nobody was emailed.");
      const readers = await rsvpList(job.community, job.event).then((list) => list.map((r) => r.key), () => null);
      if (readers === null) {
        job = { ...job, note: WAITING_NOTE };
        await save(job);
        return job;
      }
      if (!readers.length) return await finish("sent", "");
      const listed: EventMailJob = { ...job, waiting: false, total: readers.length, note: "" };
      if (!(await listReaders(listed, readers))) {
        // Not written down whole: it waits, and the next run writes the whole list again. Nothing was sent from it.
        job = { ...job, note: WAITING_NOTE };
        await save(job);
        return job;
      }
      job = listed;
    }
    if (!isSenderConfigured()) return job;
    const words = eventMailWords(store, config, event, job);
    const kind = job.kind;
    const community = job.community;

    // A reminder checks each member against the creator's Stripe account
    // first, so it goes in checked batches (lib/mail.ts); a notice of a move
    // or a cancellation checks nobody, and goes in full ones.
    const size = reminder ? CHECKED_BATCH_SIZE : BATCH_SIZE;
    while (job.done < job.total && Date.now() < deadline) {
      const keys = await recipientBatch(id, job.done, Math.min(size, job.total - job.done));
      if (!keys) {
        job = { ...job, note: "We couldn't read the remaining recipients. The send is still pending." };
        break;
      }
      const [found, going]: [Map<string, Member>, Set<string>] = await Promise.all([readMembers(community, keys), stillGoing(community, event.id, keys)]);
      let recipients: Member[] = keys
        .map((k) => found.get(k))
        .filter((m): m is Member => Boolean(m && !m.removed && (going.has(m.k) || kind === "cancelled")))
        .filter((m) => !reminder || m.mail);
      if (reminder && recipients.length) {
        // Asked batch by batch, so a member who lapsed since it started is left out.
        const letIn: boolean[] = await inTurns(recipients, 5, async (m: Member) =>
          (await holdsTicket(store, config, m.e)) && (await mayAttend(store, config, event, { owner: false, email: m.e })),
        );
        recipients = recipients.filter((_, i) => letIn[i]);
      }
      if (recipients.length) {
        const messages: BatchMessage[] = [];
        let unkept = false;
        for (const member of recipients) {
          if (reminder) {
            // A stop link that could not be kept on its member (CX-123 rule 24) is never emailed:
            // nothing of the batch is sent and the send stays where it was, to be tried again.
            const token = await tokenFor(store, job.community, member).catch(() => null);
            if (token === null) {
              unkept = true;
              break;
            }
            const r = render(store, words.subject, words.body, null, {
              page: `${SITE_URL}/unsubscribe?c=${token}`,
              oneClick: `${SITE_URL}/api/mail/unsubscribe?c=${token}`,
              why: words.why,
              label: communityWords(store.language).stopLabel,
              after: communityWords(store.language).stopAfterEvents,
            });
            messages.push({ from: storeSender(store), to: member.e, subject: r.subject, text: r.text, html: r.html, replyTo: store.email, headers: r.headers });
          } else {
            messages.push({
              from: storeSender(store),
              to: member.e,
              subject: words.subject.slice(0, 150),
              text: `${words.body}\n\n—\n${words.why}\n${communityWords(store.language).mailSentWith}`,
              html: noticeHtml(words.body, words.why, LANGUAGES[parseLanguage(store.language)].locale, communityWords(store.language).mailSentWith),
              replyTo: store.email,
            });
          }
        }
        if (unkept) {
          job = { ...job, note: "We couldn't save every recipient's unsubscribe link. The send is still pending." };
          break;
        }
        const outcome = await sendBatch(messages, `cmev:${id}:${job.done}:${keys.length}`, { by: "store", store, kind: "email" });
        if (outcome !== "sent") {
          const failures = job.failures + 1;
          if (outcome === "refused" || failures >= 5) return await finish("failed", "The email service would not take it. Nothing more was sent.");
          job = { ...job, failures, note: "Paused for a moment: the email service asked us to slow down." };
          break;
        }
      }
      job = { ...job, done: job.done + keys.length, sent: job.sent + recipients.length, failures: 0, note: "" };
      await save(job);
    }
    if (job.done >= job.total) return await finish("sent", "");
    await save(job);
    return job;
  } finally {
    await releaseMark(lockKey(id), lock);
  }
}

type Due = { member: string; community: string; handle: string; event: string; mark: "24" | "1" | "p"; start: number };

function parseDue(member: string): Due | null {
  const [community, handle, event, mark, start] = member.split("|");
  if (!/^[0-9a-f]{32}$/.test(community ?? "") || !handle || !/^[0-9a-f]{12}$/.test(event ?? "")) return null;
  if (mark !== "24" && mark !== "1" && mark !== "p") return null;
  const at = Number(start);
  if (!Number.isFinite(at)) return null;
  return { member, community, handle, event, mark, start: at };
}

export type EventRun = { reminders: number; pushed: number; dropped: number; sends: number };

/**
 * Everything due about live events: starts the reminders whose time has
 * come, tells the creator's phone about an event starting in fifteen
 * minutes, then moves every send under way on. `mail` false (no email on
 * this deployment) still does the phone and leaves the reminders queued.
 */
export async function runEventQueue(
  findStore: (handle: string) => Promise<Store | null>,
  deadline: number,
  options: { mail: boolean },
): Promise<EventRun> {
  const counts: EventRun = { reminders: 0, pushed: 0, dropped: 0, sends: 0 };
  if (!isRedisConfigured()) return counts;
  const now = Date.now();
  const [raw] = await redisPipeline([["ZRANGEBYSCORE", EVENT_QUEUE, 0, now, "LIMIT", 0, QUEUE_BATCH]]);
  const members = Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
  const stores = new Map<string, Store | null>();
  for (const member of members) {
    if (Date.now() > deadline) break;
    const due = parseDue(member);
    if (!due) {
      await redisPipeline([["ZREM", EVENT_QUEUE, member]]);
      counts.dropped += 1;
      continue;
    }
    if (due.mark !== "p" && !options.mail) continue;
    try {
      if (!stores.has(due.handle)) stores.set(due.handle, await findStore(due.handle).catch(() => null));
      const store = stores.get(due.handle) ?? null;
      const event = store?.community?.id === due.community ? await readEvent(due.community, due.event) : null;
      const current = event && !event.cancelled && event.start === due.start;
      if (!store || !event || !current) {
        counts.dropped += 1;
      } else if (due.mark === "p") {
        if (Date.now() < event.start) {
          const going = (await rsvpNumbers(due.community, [event], null)).get(event.id)?.going ?? 0;
          const time = new Intl.DateTimeFormat("en-US", { timeZone: event.tz, hour: "numeric", minute: "2-digit" }).format(new Date(event.start));
          const sent = await alertCreator(
            store,
            "live",
            {
              title: "Live in 15 minutes",
              body: `${event.title} starts at ${time}. ${going} ${going === 1 ? "person has" : "people have"} RSVP'd. Get there a few minutes early.`,
              url: store.sid ? `/studio/community?store=${store.sid}` : "/studio/community",
            },
            { seed: `event:${event.id}:${event.start}` },
          );
          if (sent) counts.pushed += 1;
        } else counts.dropped += 1;
      } else if (stillUseful(due.mark, event.start, Date.now())) {
        const job = await startJob(store, event, due.mark, null);
        if (job) counts.reminders += 1;
      } else counts.dropped += 1;
    } catch (error) {
      console.error("a live event reminder failed", error);
      // Not known whether it was made: it stays due, and a later run makes it once. Put behind the others due, so a
      // few that keep failing never take the turn of the rest (Claude 5 on #2954, LIGHT 3); the order is all that
      // write changes, so its answer is not needed.
      if (error instanceof UnknownReplyError || error instanceof SendNotMadeYetError) {
        await redisPipeline([["ZADD", EVENT_QUEUE, now, member]]).catch(() => {});
        continue;
      }
    }
    await redisPipeline([["ZREM", EVENT_QUEUE, member]]);
  }
  if (options.mail) {
    const [ids] = await redisPipeline([["SMEMBERS", JOBS]]);
    for (const id of Array.isArray(ids) ? (ids as string[]) : []) {
      if (Date.now() > deadline) break;
      if (await advanceEventJob(id, findStore, deadline)) counts.sends += 1;
    }
  }
  return counts;
}
