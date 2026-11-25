/**
 * A creator's announcement in their community, emailed to the members who
 * asked for it.
 *
 * Nobody is emailed who did not tick "Email me announcements" themselves,
 * and the box starts empty. Each email carries a one-click way to stop them
 * (its own link and the header a mail app reads), the creator's postal
 * address and why the reader is getting it — the same template, sender and
 * monthly allowance as the creator's emails to their list (lib/mail.ts), so
 * announcements are part of Pro's email, counted against the same number.
 * Stopping them stops only these: the member stays in the community, and
 * stays off or on the creator's list exactly as they were.
 *
 * Who it goes to is written down when it starts: the members who asked, then
 * — batch by batch, as it goes out — only those who still hold a ticket in
 * (lib/community-access.ts), so a member whose membership lapsed is not
 * emailed about a community they can no longer open. It goes out a hundred
 * at a time, each batch with its own key so a retry never sends twice, and a
 * send that outlives one run is picked up by the mail job every five minutes.
 *
 *   nl:cm:mail:<job>        the send (JSON)
 *   nl:cm:mail:<job>:to     member keys, in order (a list)
 *   nl:cm:mailq             sends waiting or under way
 *   nl:cm:unsub:<token>     community|member|handle, for the link in an email
 */
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { orderWrite } from "@/lib/order-data";
import { type BatchMessage, sendListBatch } from "@/lib/email";
import { stopTags } from "@/lib/mail-health-rules";
import { CHECKED_BATCH_SIZE, SENDER_RETRY_NOTE, SENDER_WAIT_NOTE, canWrite, fromLine, mailDay, monthlyAllowance, release, render, reserve } from "@/lib/mail";
import { SITE_URL } from "@/lib/site-url";
import { leadsKey } from "@/lib/contact-rules";
import type { Store } from "@/lib/store";
import {
  type CommunityConfig,
  type Member,
  type Post,
  mailableMembers,
  readConfig,
  readMember,
  readMembersExact,
  readPost,
  setMail,
  setMemberToken,
} from "@/lib/community";
import { askingAgainWontTell, holdsTicket, maySeeSpace } from "@/lib/community-access";
import { communityWords } from "@/lib/buyer-words/community";

export const COMMUNITY_UNSUB = /^[0-9a-f]{40}$/;
const QUEUE = "nl:cm:mailq";
const jobKey = (id: string) => `nl:cm:mail:${id}`;
const toKey = (id: string) => `nl:cm:mail:${id}:to`;
const lockKey = (id: string) => `nl:cm:mail:${id}:lock`;
export const unsubKey = (token: string) => `nl:cm:unsub:${token}`;
const JOB_ID = /^[0-9a-f]{24}$/;

export type AnnouncementJob = {
  id: string;
  community: string;
  handle: string;
  post: string;
  subject: string;
  body: string;
  total: number;
  /** How far through the list it is: sent, or skipped because no longer let in. */
  done: number;
  sent: number;
  status: "sending" | "waiting" | "sent" | "failed";
  note: string;
  failures: number;
  /**
   * Members passed over unsent because whether they are let in could not be told (sortBatch): never counted in
   * `sent`. Absent on a send that skipped nobody.
   */
  skipped?: number;
  /** The current batch's members not answered for, by member key, with the tries in a row so far (sortBatch). */
  tries?: Record<string, number>;
  /**
   * The space the post was written in. A member who cannot see that space (one kept for the buyers of a product
   * they do not hold) is passed over, never emailed its words. Absent on a send queued before it was kept: the post
   * is read for it.
   */
  space?: string;
  /**
   * While it waits on a store switched off or a plan without email: not looked at again before this time (ms), so a
   * held send costs a read of its record a run, never the store's and a write (#5285 row #3406). Absent otherwise.
   */
  retryAt?: number;
  /** When it began to wait on a store switched off or a plan without email (ms): it ends ANNOUNCEMENT_HELD_DAYS later. */
  heldSince?: number;
  /** Whether it holds its place among its community's held sends (ANNOUNCEMENTS_HELD_MOST); asked again on each look until it does. */
  heldPlaced?: boolean;
};

/**
 * How long a send held for a store switched off, or for a plan without email, waits between looks: an hour, as a
 * broadcast's LIST_RETRY_SECONDS (lib/broadcasts.ts), never every run of the mail job (Claude 1's MEDIUM 1 on #3406).
 */
export const ANNOUNCEMENT_RETRY_SECONDS = 3_600;

/**
 * How long a send held for a store switched off, or for a plan without email, is kept: 60 days, as a product update
 * held on a switched-off store (lib/product-updates.ts). Then it ends, out of line, saying so (Claude 4 AC, mail 2aab),
 * so its looks have an end: at most 60 x 24 hourly looks and the five-minute runs between them.
 */
export const ANNOUNCEMENT_HELD_DAYS = 60;

/**
 * How many sends of one community can wait at once on a store switched off, or a plan without email: 3. A send that
 * would be held past them ends at once, out of line, saying so, so the company's cost of held sends has a ceiling a
 * store (the coordinator's cost line, ibqho c2c2; tests/plan-cost-registry.ts, ANNOUNCEMENT_HELD_EXPOSURE).
 */
export const ANNOUNCEMENTS_HELD_MOST = 3;
/** The commands one run of the mail job sends for a held send before its hour is past: the lock's claim, its GET, the lock's release. */
export const ANNOUNCEMENT_HELD_RUN_COMMANDS = 3;
/** The commands an hourly look at a held send sends of its own, besides its store's and its settings' reads: the lock's claim, its GET, its SET, the lock's release. */
export const ANNOUNCEMENT_HELD_LOOK_OWN_COMMANDS = 4;
/**
 * The commands a send's first hold adds once: the community's held sends read (SMEMBERS), their records (MGET), the
 * SREM of those that ended, and its place taken (HOLD_PLACE: one EVAL and, inside it, SISMEMBER, SCARD, SADD, EXPIRE).
 */
export const ANNOUNCEMENT_HELD_ENTER_COMMANDS = 8;

/** The sends of a community held at once (the ids of their records): at most ANNOUNCEMENTS_HELD_MOST waiting there. */
const heldKey = (community: string) => `nl:cm:mailq:held:${community}`;

/**
 * A held send: looked at again in an hour, or ended once it has waited ANNOUNCEMENT_HELD_DAYS. A send's first hold
 * takes a place among its community's held sends, read exactly: past ANNOUNCEMENTS_HELD_MOST it ends at once with
 * `full`. It never waits without its place (Claude 2 upbeat's LEVE on #5341): a read of the others that does not
 * answer only skips giving back places of sends that ended, the place is still asked of the atomic step, and when that
 * step's own answer does not read the send ends at once with `unheld`, so the held sends never pass the ceiling.
 */
async function hold(job: AnnouncementJob, note: string, ended: string, full: string, unheld: string): Promise<AnnouncementJob> {
  const now = Date.now();
  // Its 60 days start on its first hold, whether or not its place could be taken then (Claude 7 xAF's LEVE on #5341).
  const heldSince = job.heldSince ?? now;
  if (now - heldSince >= ANNOUNCEMENT_HELD_DAYS * 86_400_000) {
    if (job.heldPlaced) await redisPipeline([["SREM", heldKey(job.community), job.id]]);
    return { ...job, status: "failed", note: ended, retryAt: undefined, heldPlaced: undefined };
  }
  const waiting = (): AnnouncementJob => ({ ...job, status: "waiting", note, retryAt: now + ANNOUNCEMENT_RETRY_SECONDS * 1000, heldSince, heldPlaced: true });
  if (job.heldPlaced) return waiting();
  const key = heldKey(job.community);
  // Places held by sends that ended or are gone are given back first. A send still under way is never taken out on a
  // read: it may be entering the hold at this moment.
  const listed = repliesFor(await redisPipeline([["SMEMBERS", key]]), 1);
  const ids = listed ? stringList(listed[0]) : null;
  const others = (ids ?? []).filter((other) => other !== job.id);
  if (others.length) {
    const read = repliesFor(await redisPipeline([["MGET", ...others.map(jobKey)]]), 1);
    const values = read ? repliesFor(read[0], others.length) : null;
    const gone = !values ? [] : others.filter((_, i) => {
      if (values[i] === null) return true;
      const other = parse(values[i]);
      return other !== null && (other.status === "sent" || other.status === "failed");
    });
    if (gone.length) await redisPipeline([["SREM", key, ...gone]]);
  }
  // The place itself in one atomic step (Claude 7 xAF's MEDIUM on #5341): sends held at the same moment never pass the
  // ceiling together. Kept a day past the longest hold, from the last send held.
  const taken = repliesFor(await redisPipeline([["EVAL", HOLD_PLACE, 1, key, job.id, ANNOUNCEMENTS_HELD_MOST, (ANNOUNCEMENT_HELD_DAYS + 1) * 86_400]]), 1)?.[0];
  if (taken === 1) return waiting();
  return { ...job, status: "failed", note: taken === 0 ? full : unheld, retryAt: undefined, heldSince: undefined, heldPlaced: undefined };
}

/**
 * A held send's place among its community's held sends (KEYS: the set; ARGV: the send's id, ANNOUNCEMENTS_HELD_MOST,
 * the set's seconds): 1 when it holds one (already, or taken now), 0 when the others hold them all. Modelled by
 * lib/redis-memory-take.ts.
 */
export const HOLD_PLACE = `-- marktmorgen:announcement-hold:v1
if redis.call("SISMEMBER", KEYS[1], ARGV[1]) == 1 then return 1 end
if redis.call("SCARD", KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call("SADD", KEYS[1], ARGV[1])
redis.call("EXPIRE", KEYS[1], tonumber(ARGV[3]))
return 1`;

function parse(raw: unknown): AnnouncementJob | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as AnnouncementJob;
    return JOB_ID.test(value.id) ? value : null;
  } catch {
    return null;
  }
}

async function save(job: AnnouncementJob): Promise<void> {
  await redisPipeline([["SET", jobKey(job.id), JSON.stringify(job), "EX", 60 * 86_400]]);
}

/** An announcement's send: null when it is not there; a reply in another shape throws UnknownReplyError (CX-123 rule 24). */
export async function readJob(id: string): Promise<AnnouncementJob | null> {
  if (!JOB_ID.test(id) || !isRedisConfigured()) return null;
  const raw = repliesFor(await redisPipeline([["GET", jobKey(id)]]), 1)?.[0];
  if (raw !== null && typeof raw !== "string") throw new UnknownReplyError("an announcement's send");
  return parse(raw);
}

/** Whether this store can email announcements now: Pro, with its emails set up. */
export function canAnnounceByEmail(store: Store): boolean {
  return canWrite(store);
}

/** How many members asked for announcement emails. */
export async function announcementReach(communityId: string): Promise<number> {
  return (await mailableMembers(communityId)).length;
}

/** Where the post is read, on the address that always works. */
export function postAddress(store: Store, post: string): string {
  return `${SITE_URL}/@${store.handle}/community/post/${post}`;
}

export type QueueResult = { ok: true; job: AnnouncementJob } | { ok: false; reason: "plan" | "empty" };

/** Writes down an announcement's email to go now, to everyone who asked. */
/**
 * Who asked for a community's emails could not be read: a reply in another shape (lib/community.ts memberPage, rule
 * 24) or no answer at all. Raised before anything of the send is written, so the caller can say the post went up and
 * was not emailed (Codex M on #3213), and only for that read: a failure while writing the job is not this.
 */
export class RecipientsUnreadError extends UnknownReplyError {
  /** What the read failed with. */
  readonly why: unknown;
  constructor(cause: unknown) {
    super("the read of who asked for the community's emails");
    this.name = "RecipientsUnreadError";
    if (!(cause instanceof UnknownReplyError)) this.message = "The read of who asked for the community's emails did not answer";
    this.why = cause;
  }
}

export async function queueAnnouncement(store: Store, config: CommunityConfig, post: Post): Promise<QueueResult> {
  const communityId = store.community?.id;
  if (!communityId || !canAnnounceByEmail(store)) return { ok: false, reason: "plan" };
  let members: Awaited<ReturnType<typeof mailableMembers>>;
  try {
    members = await mailableMembers(communityId);
  } catch (error) {
    throw new RecipientsUnreadError(error);
  }
  if (members.length === 0) return { ok: false, reason: "empty" };
  const w = communityWords(store.language);
  const subject = (post.title || w.announceSubject(config.name)).slice(0, 150);
  const body = [post.text, "", w.announceReadIt(config.name), postAddress(store, post.id)].join("\n").trim();
  const job: AnnouncementJob = {
    id: randomBytes(12).toString("hex"),
    community: communityId,
    handle: store.handle,
    post: post.id,
    space: post.sp,
    subject,
    body,
    total: members.length,
    done: 0,
    sent: 0,
    status: "sending",
    note: "",
    failures: 0,
  };
  const commands: (string | number)[][] = [["DEL", toKey(job.id)]];
  const keys = members.map((m) => m.k);
  for (let i = 0; i < keys.length; i += 500) commands.push(["RPUSH", toKey(job.id), ...keys.slice(i, i + 500)]);
  commands.push(["EXPIRE", toKey(job.id), 60 * 86_400]);
  await redisPipeline(commands);
  await save(job);
  await redisPipeline([["SADD", QUEUE, job.id]]);
  return { ok: true, job };
}

/**
 * The token for a member's stop link, made once and kept. The same link stops
 * the reminders for the live events they said they are coming to
 * (lib/community-event-mail.ts): both are the community's emails they asked for.
 */
export async function tokenFor(store: Store, communityId: string, member: Member): Promise<string> {
  // The token is made canonical on the member's record first: ours, or one
  // another send kept first, which is the link already in an email and is
  // never replaced (Codex G on #3123). Only that token ever gets a link
  // record, so no record is written for a token that is not the member's, and
  // the member's erasure, which deletes the record of member.t, finds every
  // one (Codex G, review 5815472405).
  const kept = member.t || (await setMemberToken(communityId, member, randomBytes(20).toString("hex")));
  if (!kept) throw new Error("a community member with no record has no stop link");
  // A token not in a stop link's exact shape is not one any email may carry (rules 24 and 30): the batch waits.
  if (!COMMUNITY_UNSUB.test(kept)) throw new UnknownReplyError("a member's stop link");
  await keepStopLink(store, communityId, member.k, kept);
  return kept;
}

/**
 * Makes sure the member's canonical token has its link record, and only
 * while the member still holds it. A record already there is read, not
 * written again; a missing one (a send that stopped between keeping the
 * token and writing its record) is written once, with SET NX. Then the
 * member is read again: an erasure that ran in between (and so may have
 * deleted the record before it was written) leaves no member holding the
 * token, and the record just written is deleted with its reply confirmed,
 * before anything is returned. Every reply is read in its exact shape
 * (CX-123 rule 24): one not known throws, so the send stays pending and no
 * email carries the link.
 */
async function keepStopLink(store: Store, communityId: string, key: string, token: string): Promise<void> {
  const value = `${communityId}|${key}|${store.handle}`;
  const read = repliesFor(await redisPipeline([["GET", unsubKey(token)]]), 1);
  if (!read || (read[0] !== null && read[0] !== value)) throw new UnknownReplyError("a community stop link");
  if (read[0] === value) return;
  // Kept for good, once a member: counted in the store's room at what it adds (lib/order-data.ts).
  const [set] = await orderWrite(store, [["SET", unsubKey(token), value, "NX"]]);
  if (set !== "OK" && set !== null) throw new UnknownReplyError("a community stop link");
  if ((await readMember(communityId, key))?.t === token) return;
  // The member is gone (or holds another token): this token is no one's link,
  // and its record goes before the call refuses.
  const gone = repliesFor(await redisPipeline([["DEL", unsubKey(token)]]), 1)?.[0];
  if (gone !== 0 && gone !== 1) throw new UnknownReplyError("a community stop link of a member who is gone");
  throw new Error("a community member with no record has no stop link");
}

/**
 * How many runs in a row one member of a batch may go unanswered for (Stripe or Redis failing for them, while it
 * may pass) before the batch goes on without them, counted as skipped, never as sent (review of #3140, M2). The mail
 * job runs every five minutes, so six tries is about half an hour: longer than a passing fault of Stripe, the
 * network or Redis lasts nearly always, and short enough that the members after them still get an announcement the
 * same hour, and an hour-before reminder before its event (stillUseful, lib/community-event-mail.ts). Only the batch
 * under way waits meanwhile, so a longer outage passes over at most one batch (CHECKED_BATCH_SIZE) each half hour.
 */
export const MEMBER_TRIES = 6;

export type SortedBatch =
  | { wait: false; recipients: Member[]; tokens: string[]; skipped: number }
  | { wait: true; tries: Record<string, number>; unkept: boolean };

/** What a send says while it waits only on stop links not yet kept on their members (CX-123 rule 24). */
export const UNKEPT_LINK_NOTE = "We couldn't save every recipient's unsubscribe link. The send is still pending.";

/**
 * Who in a checked batch is emailed, member by member (rules 24 and 30, review of #3140, M2): each of `candidates`
 * asked `letIn` strictly, and each let in given the stop link their record keeps (tokenFor). A member whose answer
 * cannot be had and never will (askingAgainWontTell: more of their purchases than is read, the store's Stripe account
 * disconnected) is passed over now; one whose answer may yet come (a timeout, Stripe or Redis failing) makes the
 * batch wait, and is passed over only once that has happened MEMBER_TRIES runs in a row (`tries`, kept on the send,
 * by member key, for the batch under way only). A member passed over is counted in `skipped`, never sent to. A
 * batch that waits sends nobody, and its cursor stays where it was, so the next run asks again under the same key;
 * `unkept` says it waits only on stop links not kept (UNKEPT_LINK_NOTE), never on a member not yet asked.
 */
export async function sortBatch(
  store: Store,
  community: string,
  candidates: Member[],
  letIn: (member: Member) => Promise<boolean>,
  tries: Record<string, number> | undefined,
): Promise<SortedBatch> {
  type Answer = { member: Member; state: "in" | "out" | "never" | "unknown"; token?: string; link?: boolean };
  const answers: Answer[] = await inTurns(candidates, 5, async (member): Promise<Answer> => {
    try {
      return { member, state: (await letIn(member)) ? "in" : "out" };
    } catch (error) {
      if (askingAgainWontTell(error)) return { member, state: "never" };
      console.error("a community send could not ask whether a member is let in", error);
      return { member, state: "unknown" };
    }
  });
  for (const answer of answers) {
    if (answer.state !== "in") continue;
    try {
      answer.token = await tokenFor(store, community, answer.member);
    } catch (error) {
      console.error("a community send could not keep a member's stop link", error);
      answer.state = "unknown";
      answer.link = true;
    }
  }
  const next: Record<string, number> = {};
  let waiting = false;
  let unkept = true;
  for (const answer of answers) {
    if (answer.state !== "unknown") continue;
    const before = tries?.[answer.member.k];
    const count = (typeof before === "number" && Number.isSafeInteger(before) && before > 0 ? before : 0) + 1;
    if (count >= MEMBER_TRIES) answer.state = "never";
    else {
      next[answer.member.k] = count;
      waiting = true;
      if (!answer.link) unkept = false;
    }
  }
  if (waiting) return { wait: true, tries: next, unkept };
  const sent = answers.filter((a) => a.state === "in");
  return {
    wait: false,
    recipients: sent.map((a) => a.member),
    tokens: sent.map((a) => a.token as string),
    skipped: answers.filter((a) => a.state === "never").length,
  };
}

/** What a finished send's note says of the members it passed over, or "" when it passed over nobody. */
export function skippedNote(skipped: number | undefined): string {
  if (!skipped) return "";
  return `${skipped} ${skipped === 1 ? "member was" : "members were"} not emailed: we couldn't confirm they still have access.`;
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

const GONE = new Set(["bounced", "complained", "refused"]);

/**
 * The members whose address the store's list did not take off for a hard bounce, a spam complaint or a refusal (`gone`
 * with `unsub`, lib/contacts.ts stopWriting): such an address never gets an announcement either, so a member who
 * marked one as spam is not written to again and a dead address stops being tried (tests/community-mail-list-gone.test.ts).
 * A plain unsubscribe from the list is not read here: the community's own stop link decides its emails. A member not
 * on the list is kept. A row in no known shape is unknown (rule 24): it throws, and the batch waits.
 */
async function keptOnList(listId: string, members: Member[]): Promise<Member[]> {
  if (!members.length) return members;
  const rows = repliesFor(await redisPipeline([["HMGET", leadsKey(listId), ...members.map((m) => m.e)]]), 1)?.[0];
  if (!Array.isArray(rows) || rows.length !== members.length) throw new UnknownReplyError("the store's list rows of an announcement batch");
  return members.filter((_, i) => {
    if (!Object.hasOwn(rows, i)) throw new UnknownReplyError("a store's list row");
    const raw: unknown = rows[i];
    if (raw === null) return true;
    if (typeof raw !== "string") throw new UnknownReplyError("a store's list row");
    let row: unknown;
    try {
      row = JSON.parse(raw);
    } catch {
      throw new UnknownReplyError("a store's list row");
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new UnknownReplyError("a store's list row");
    const { unsub, gone } = row as { unsub?: unknown; gone?: unknown };
    // Rows are written with unsub as true or false: another shape ("true" as text, 1, null) is unknown, never "still on
    // the list" (#5285 row #4566, Claude 2's LEVE; as lib/checkout-recovery.ts contactExact reads it).
    if (Object.hasOwn(row, "unsub") && typeof unsub !== "boolean") throw new UnknownReplyError("a store's list row");
    // gone is written only as one of GONE, or not at all (lib/contacts.ts): a gone in another shape ("Bounced", 1, null)
    // is unknown too, never "still on the list" (Claude 1's NIT 2 on #5355).
    if (Object.hasOwn(row, "gone") && !(typeof gone === "string" && GONE.has(gone))) throw new UnknownReplyError("a store's list row");
    return !(unsub === true && typeof gone === "string" && GONE.has(gone));
  });
}

/**
 * Moves one send on for as long as `deadline` allows. Safe to call from two
 * places at once: only one holds the send at a time.
 */
export async function advanceAnnouncement(
  id: string,
  load: (handle: string) => Promise<Store | null>,
  deadline: number,
): Promise<AnnouncementJob | null> {
  // One run at a time, on an exact claim (lib/claim-mark.ts, CX-123 rule 24): held by another run, or not known to
  // be ours, nothing is sent this time, and the lock is let go only while it still holds this run's own value.
  const lock = claimValue();
  if ((await claimMark(lockKey(id), 90, lock)) !== "ours") return null;
  try {
    // Its record not read (Claude 5 on #2954): nothing is done this time and it stays in line, never taken out of it.
    let job: AnnouncementJob | null;
    try {
      job = await readJob(id);
    } catch (error) {
      if (error instanceof UnknownReplyError) return null;
      throw error;
    }
    if (!job || job.status === "sent" || job.status === "failed") {
      await redisPipeline([["SREM", QUEUE, id]]);
      return job;
    }
    // Held for a store switched off or a plan without email: looked at again only once its hour is past.
    if (job.status === "waiting" && typeof job.retryAt === "number" && Date.now() < job.retryAt) return job;
    const store = await load(job.handle);
    const config = store?.community?.id === job.community ? await readConfig(job.community) : null;
    if (!store || !config) {
      job = { ...job, status: "failed", note: "The community is not here anymore." };
      await save(job);
      await redisPipeline([["SREM", QUEUE, id]]);
      return job;
    }
    // Switched off after notices about its content (lib/takedown.ts; any value but nothing or "" reads as off, rule 24):
    // nobody is read, reserved or emailed. It waits in line, saying so, and goes on by itself once the store is back on.
    if (store.suspended) {
      job = await hold(
        job,
        job.done > 0 ? "Your store is switched off after notices about its content, so nothing more was sent. The rest go out by themselves once your store is back on." : "Your store is switched off after notices about its content, so nothing was sent. It goes out by itself once your store is back on.",
        `Your store was switched off after notices about its content for ${ANNOUNCEMENT_HELD_DAYS} days, so ${job.done > 0 ? "the rest of this announcement was" : "this announcement was"} not sent. Post it again once your store is back on.`,
        `Only ${ANNOUNCEMENTS_HELD_MOST} announcements wait at a time while your store is switched off, so ${job.done > 0 ? "the rest of this one was" : "this one was"} not sent. Post it again once your store is back on.`,
        `Your store is switched off after notices about its content, and ${job.done > 0 ? "the rest of this announcement" : "this announcement"} could not be held to wait for it, so it was not sent. Post it again once your store is back on.`,
      );
      await save(job);
      if (job.status === "failed") await redisPipeline([["SREM", QUEUE, id]]);
      return job;
    }
    if (monthlyAllowance(store) === 0 || !store.mail) {
      job = await hold(
        job,
        "Your plan does not include email right now. It goes out once Pro is on again.",
        `Your plan did not include email for ${ANNOUNCEMENT_HELD_DAYS} days, so ${job.done > 0 ? "the rest of this announcement was" : "this announcement was"} not sent. Post it again once Pro is on.`,
        `Only ${ANNOUNCEMENTS_HELD_MOST} announcements wait at a time while your plan does not include email, so ${job.done > 0 ? "the rest of this one was" : "this one was"} not sent. Post it again once Pro is on.`,
        `Your plan does not include email right now, and ${job.done > 0 ? "the rest of this announcement" : "this announcement"} could not be held to wait for it, so it was not sent. Post it again once Pro is on.`,
      );
      await save(job);
      if (job.status === "failed") await redisPipeline([["SREM", QUEUE, id]]);
      return job;
    }
    // No longer held: its place among the community's held sends is given back.
    if (job.heldPlaced) await redisPipeline([["SREM", heldKey(job.community), id]]);
    job = { ...job, status: "sending", note: "", retryAt: undefined, heldSince: undefined, heldPlaced: undefined };
    const community = job.community;

    while (job.done < job.total && Date.now() < deadline) {
      // Checked batches (lib/mail.ts): each member is asked of Stripe before sending.
      const keys = await recipientBatch(id, job.done, Math.min(CHECKED_BATCH_SIZE, job.total - job.done));
      if (!keys) {
        job = { ...job, status: "waiting", note: "We couldn't read the remaining recipients. The send is still pending." };
        break;
      }
      // Who is in this batch, read exactly (rules 24 and 30): a member is left out only when read as gone (nil), taken
      // out, no longer asking for these emails, or known to be let in no more (asked batch by batch, so a member who
      // lapsed since it started is left out). Members who did not read leave the batch not done and the cursor where
      // it was, before anything is reserved, so the next run sends to them once, under the same batch key; a ticket
      // Stripe could not be asked about, or a stop link not kept, does the same for a bounded number of runs, and a
      // member whose ticket can never be asked about is passed over, counted, never sent to (sortBatch).
      const read: SortedBatch | null = await (async (): Promise<SortedBatch> => {
        const found = await readMembersExact(community, keys);
        const asking = keys.map((k) => found.get(k)).filter((m): m is Member => Boolean(m && m.mail && !m.removed));
        // Never an address the store's list took off for a hard bounce, a spam complaint or a refusal (keptOnList).
        const candidates = store.listId ? await keptOnList(store.listId, asking) : asking;
        // The post's space, as it is now: a space taken away leaves its posts in the whole community's feed.
        const spaceId = job.space ?? (await readPost(community, job.post))?.sp;
        const space = spaceId ? config.spaces.find((s) => s.id === spaceId) : undefined;
        const letIn = async (m: Member) =>
          (await holdsTicket(store, config, m.e, { strict: true })) &&
          (!space?.only.length || (await maySeeSpace(store, config, space, { owner: false, email: m.e }, { strict: true })));
        return sortBatch(store, community, candidates, letIn, job.tries);
      })().catch((error: unknown) => {
        console.error("an announcement could not read who is in a batch", error);
        return null;
      });
      if (!read || read.wait) {
        const note = read?.unkept ? UNKEPT_LINK_NOTE : "We couldn't read who is in the next batch just now. The send is still pending.";
        job = { ...job, status: "waiting", note, ...(read ? { tries: read.tries } : {}) };
        break;
      }
      const { recipients, tokens, skipped } = read;
      if (recipients.length) {
        const day = mailDay();
        const reserved = await reserve(store, recipients.length, false, day);
        if (reserved !== "ok") {
          job = {
            ...job,
            status: "waiting",
            note:
              reserved === "month"
                ? "This month's emails ran out. The rest go out when the month turns."
                : reserved === "sender"
                  ? SENDER_WAIT_NOTE
                  : "Going out in daily portions: the rest continue tomorrow, by themselves.",
          };
          break;
        }
        const messages: BatchMessage[] = [];
        for (const [i, member] of recipients.entries()) {
          const token = tokens[i];
          const fromName = store.mail?.fromName || store.name;
          const r = render(store, job.subject, job.body, null, {
            page: `${SITE_URL}/unsubscribe?c=${token}`,
            oneClick: `${SITE_URL}/api/mail/unsubscribe?c=${token}`,
            why: communityWords(store.language).announceWhy(fromName, config.name),
            label: communityWords(store.language).stopLabel,
            after: communityWords(store.language).stopAfterAnnounce,
          });
          messages.push({ from: fromLine(store), to: member.e, subject: r.subject, text: r.text, html: r.html, replyTo: store.email, headers: r.headers, tags: stopTags(store) });
        }
        const outcome = await sendListBatch(messages, `cm:${id}:${job.done}:${keys.length}`, { by: "monthly" });
        if (outcome === "waiting") {
          // Known not handed to any provider: it waits for the sender in the queue, never counted as a failure.
          await release(store, recipients.length, day);
          job = { ...job, status: "waiting", note: SENDER_WAIT_NOTE };
          break;
        }
        if (outcome !== "sent") {
          await release(store, recipients.length, day);
          const failures = job.failures + 1;
          // Only a refusal ends it: a provider that is down keeps the email waiting, never abandoned (outage drill).
          job = outcome === "refused"
            ? { ...job, status: "failed", failures, note: "The email service would not take it. Nothing more was sent." }
            : { ...job, failures, note: SENDER_RETRY_NOTE };
          break;
        }
      }
      job = { ...job, done: job.done + keys.length, sent: job.sent + recipients.length, failures: 0, tries: undefined };
      if (skipped) job = { ...job, skipped: (job.skipped ?? 0) + skipped };
      await save(job);
    }
    if (job.status === "sending" && job.done >= job.total) {
      job = { ...job, status: "sent", note: skippedNote(job.skipped) };
      await redisPipeline([["DEL", toKey(id)]]);
    }
    await save(job);
    if (job.status === "sent" || job.status === "failed") await redisPipeline([["SREM", QUEUE, id]]);
    return job;
  } finally {
    await releaseMark(lockKey(id), lock);
  }
}

/** The runs in a row an announcement may fail with an error before it is stopped as failed (advanceAnnouncements). */
export const ANNOUNCEMENT_ERRORS_MOST = 5;

/**
 * An announcement whose run threw: logged, and counted on its own record under its lock, so it is tried again by the
 * next run and, after ANNOUNCEMENT_ERRORS_MOST in a row (a sent batch puts the count back to 0), stopped as failed and
 * taken out of line, saying so to the creator. A record that cannot be read or locked is left as it is: the next run
 * tries again.
 */
async function countError(id: string, error: unknown): Promise<void> {
  console.error("a community announcement failed; the others go on", id, error);
  const lock = claimValue();
  if ((await claimMark(lockKey(id), 90, lock)) !== "ours") return;
  try {
    const job = await readJob(id);
    if (!job || job.status === "sent" || job.status === "failed") return;
    const failures = job.failures + 1;
    const stopped = failures >= ANNOUNCEMENT_ERRORS_MOST;
    await save({
      ...job,
      failures,
      status: stopped ? "failed" : "waiting",
      note: stopped
        ? `This send stopped after the same error ${ANNOUNCEMENT_ERRORS_MOST} times in a row. Nothing more was sent.`
        : "Paused for a moment: something went wrong on our side. It is tried again by itself.",
    });
    if (stopped) await redisPipeline([["SREM", QUEUE, id]]);
  } finally {
    await releaseMark(lockKey(id), lock);
  }
}

/**
 * Moves every waiting send on. For the mail job. Each announcement on its own: one that throws is counted against
 * itself (countError) and never keeps the ones after it from going out (tests/community-mail-isolated.test.ts).
 */
export async function advanceAnnouncements(load: (handle: string) => Promise<Store | null>, deadline: number): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const [raw] = await redisPipeline([["SMEMBERS", QUEUE]]);
  const ids = Array.isArray(raw) ? (raw as string[]) : [];
  let touched = 0;
  for (const id of ids) {
    if (Date.now() > deadline) break;
    try {
      if (await advanceAnnouncement(id, load, deadline)) touched += 1;
    } catch (error) {
      await countError(id, error).catch((failure: unknown) => console.error("counting an announcement's error failed", id, failure));
    }
  }
  return touched;
}

/**
 * Who a stop link belongs to, without acting on it. Null only when Redis
 * said there is no such link or member; a read in any other shape throws
 * UnknownReplyError (CX-123 rule 24), so a link that exists is never called
 * unknown, and the stop door and page say they could not do it just now.
 */
export async function readCommunityUnsub(
  token: string,
): Promise<{ community: string; handle: string; member: Member } | null> {
  if (!COMMUNITY_UNSUB.test(token) || !isRedisConfigured()) return null;
  const replies = repliesFor(await redisPipeline([["GET", unsubKey(token)]]), 1);
  if (!replies) throw new UnknownReplyError("a community stop link");
  const raw = replies[0];
  if (raw === null) return null;
  if (typeof raw !== "string") throw new UnknownReplyError("a community stop link");
  const [community, key, handle] = raw.split("|");
  if (!community || !key || !handle) return null;
  const member = await readMember(community, key);
  return member && member.t === token ? { community, handle, member } : null;
}

/**
 * Stops a member's announcement emails. Safe to press twice. True only once
 * the stop is written (or was already); throws when a read or the write was
 * answered in another shape, so the door never says "Unsubscribed." for a
 * stop that was not kept.
 */
export async function stopAnnouncements(token: string): Promise<boolean> {
  const found = await readCommunityUnsub(token);
  if (!found) return false;
  if (found.member.mail) await setMail(found.community, found.member, false);
  return true;
}

/** Deletes the record behind a deleted member's unsubscribe link (lib/community-erasure.ts). */
export async function forgetCommunityUnsub(token: string): Promise<number> {
  if (!token || !isRedisConfigured()) return 0;
  const gone = countOf(repliesFor(await redisPipeline([["DEL", unsubKey(token)]]), 1)?.[0]);
  // Never 0 removed on a reply of another shape (CX-123 rule 24): thrown, so the erasure is said as not finished.
  if (gone === null || gone > 1) throw new UnknownReplyError("the deletion of a member's unsubscribe token");
  return gone;
}
