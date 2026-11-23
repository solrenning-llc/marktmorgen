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
 *   nl:cm:mail:<job>:to     member keys, in order (a list); a deleted person's is written over with ERASED_MARK
 *   nl:cm:mailq             sends waiting or under way
 *   nl:cm:<community>:sends that community's sends waiting or under way, at most MAX_SENDS_UNDER_WAY: what a
 *                           person's erasure walks to take their key out of each list (Codex L-20261121-0758)
 *   nl:cm:unsub:<token>     community|member|handle, for the link in an email
 */
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
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
import { MAX_SENDS_UNDER_WAY } from "@/lib/community-text";
import { ERASED_MARK, blankInLists } from "@/lib/erasure-lists";

export const COMMUNITY_UNSUB = /^[0-9a-f]{40}$/;
const QUEUE = "nl:cm:mailq";
const jobKey = (id: string) => `nl:cm:mail:${id}`;
const toKey = (id: string) => `nl:cm:mail:${id}:to`;
/**
 * A send's place marked as live from the moment it is taken until its record is saved (Claude 4 AC on #5072, LEVE):
 * the members read and the list write come in between, and a sweep past the cap (holdSendPlace of another send,
 * forgetAnnouncementRecipient) lets go only a place with neither this mark nor a record. It holds nothing about a
 * person (the value is "1") and lasts SEND_HELD_SECONDS, longer than the one request that reads the members and writes
 * the list, so a send whose request died lets its place go within the hour.
 */
const heldKey = (id: string) => `nl:cm:mail:${id}:held`;
const SEND_HELD_SECONDS = 60 * 60;
const lockKey = (id: string) => `nl:cm:mail:${id}:lock`;
/** A community's sends waiting or under way, kept as long as a send's record (SENDS_SECONDS). */
const sendsKey = (community: string) => `nl:cm:${community}:sends`;
const SENDS_SECONDS = 60 * 86_400;
/**
 * A community's count of erasures begun (Claude 2 lpgvy on #5072, LOW 1): a person's erasure adds one after they
 * leave the members' index and before their key is written over in the sends under way. A send reads it before it
 * reads the members and again once its list is written, and a change means someone was erased while it read: the
 * list is let go and nothing is sent. One number a community, kept as long as a send's record.
 */
const erasuresKey = (community: string) => `nl:cm:${community}:erasures`;
/**
 * The most ids an erasure reads from a community's sends and looks up (ERASE_ANNOUNCEMENT_LISTS): twice the cap, room
 * for places whose send is gone (a refused send's lost SREM). More than that refuses the erasure for its retry.
 */
export const ERASE_SENDS_READ_MOST = 2 * MAX_SENDS_UNDER_WAY;
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
};

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

export type QueueResult = { ok: true; job: AnnouncementJob } | { ok: false; reason: "plan" | "empty" | "busy" };

/**
 * Takes one of the community's MAX_SENDS_UNDER_WAY places for a send, before anything of it is written: true when it
 * holds one. Past the cap, the places whose send record is gone (let go after sixty days, or never saved) are let go
 * first, and only then is the send refused. Concurrent sends that each see the cap passed each let theirs go, so the
 * set holds more than the cap only for that instant, and an erasure that reads it then refuses and is tried again.
 * A count in an unknown shape throws (CX-123 rule 24) and nothing more of the send is written.
 */
async function holdSendPlace(community: string, id: string): Promise<boolean> {
  const key = sendsKey(community);
  const count = async () => {
    const n = countOf(repliesFor(await redisPipeline([["SCARD", key]]), 1)?.[0]);
    if (n === null) throw new UnknownReplyError("a community's announcements under way");
    return n;
  };
  const added = repliesFor(await redisPipeline([["SET", heldKey(id), "1", "EX", SEND_HELD_SECONDS], ["SADD", key, id], ["EXPIRE", key, SENDS_SECONDS]]), 3);
  if (!added || added[0] !== "OK" || countOf(added[1]) === null) throw new UnknownReplyError("a community's announcements under way");
  if ((await count()) <= MAX_SENDS_UNDER_WAY) return true;
  const listed = repliesFor(await redisPipeline([["SMEMBERS", key]]), 1)?.[0];
  if (!Array.isArray(listed) || listed.some((other) => typeof other !== "string")) throw new UnknownReplyError("a community's announcements under way");
  const others = (listed as string[]).filter((other) => other !== id && JOB_ID.test(other));
  // A place is live while its record or its held mark is there (Claude 4 AC on #5072, LEVE): EXISTS of both answers 0
  // only for a place neither of them holds.
  const there = others.length ? repliesFor(await redisPipeline(others.map((other) => ["EXISTS", jobKey(other), heldKey(other)])), others.length) : [];
  if (!there || there.some((n) => n !== 0 && n !== 1 && n !== 2)) throw new UnknownReplyError("a community's announcements under way");
  // A member that is not a send's id holds no place either (Claude 7 xAF on #5072, NIT).
  const stale = [...others.filter((_, i) => there[i] === 0), ...(listed as string[]).filter((other) => !JOB_ID.test(other))];
  if (stale.length) await letStaleGo(key, stale);
  if ((await count()) <= MAX_SENDS_UNDER_WAY) return true;
  await redisPipeline([["SREM", key, id]]);
  return false;
}

/**
 * Lets go of places that hold no send (neither a record nor a held mark), with the recipient list each may have left
 * (Claude 3 yaQt on #5072, LEVE): a list written before its record, whose record was never saved, would otherwise keep
 * the member keys sixty days after its place was let go, where no later erasure finds it. Each list goes first, read
 * exactly (0 or 1 removed); only a place whose list is known gone is let go, so an erasure still reaches the others.
 * A reply in another shape throws (CX-123 rule 24). A member that is not a send's id names no list: only let go.
 */
async function letStaleGo(key: string, stale: string[]): Promise<void> {
  const ids = stale.filter((id) => JOB_ID.test(id));
  const gone = ids.length ? repliesFor(await redisPipeline(ids.map((id) => ["DEL", toKey(id)])), ids.length) : [];
  if (!gone || gone.some((n) => countOf(n) === null || (countOf(n) as number) > 1)) throw new UnknownReplyError("a stale announcement's recipient list");
  await redisPipeline([["SREM", key, ...stale]]);
}

/** The community's count of erasures as kept (null when none has been counted), read exactly. */
async function erasuresCount(community: string): Promise<string | null> {
  const read = repliesFor(await redisPipeline([["GET", erasuresKey(community)]]), 1);
  if (!read || (read[0] !== null && (typeof read[0] !== "string" || !/^\d{1,16}$/.test(read[0])))) throw new UnknownReplyError("a community's count of erasures");
  return read[0] as string | null;
}

/**
 * Takes a send that is over (sent, failed, stopped, or its record gone) out of line and out of its community's sends.
 * Its recipient list goes first, confirmed (Claude 7 xAF on #5072, LEVE): a failed send no longer in the community's
 * sends is not walked by a person's erasure, so its member keys must not outlive it. While the list is not known gone
 * the send stays in line and in its community's sends, so the next run tries again and an erasure still reaches it.
 */
async function letGo(id: string, community?: string): Promise<void> {
  const gone = countOf(repliesFor(await redisPipeline([["DEL", toKey(id)]]), 1)?.[0]);
  if (gone === null || gone > 1) throw new UnknownReplyError("an announcement's recipient list");
  await redisPipeline(community ? [["SREM", QUEUE, id], ["SREM", sendsKey(community), id]] : [["SREM", QUEUE, id]]);
}

/**
 * Writes the erased mark over a deleted member's key in every send of the community still under way (Codex
 * L-20261121-0758), in its place, so nobody after them moves and the send passes over it (recipientBatch): their key,
 * which is derived from their address, is not kept for the sixty days a send's list may last. Reads only that
 * community's sends, at most MAX_SENDS_UNDER_WAY, in one script on the Redis side (lib/erasure-lists.ts). More than
 * that, or a reply in an unknown shape, throws, so the erasure is said as not finished and its retry comes back here.
 */
export async function forgetAnnouncementRecipient(community: string, who: string): Promise<number> {
  if (!who || !isRedisConfigured()) return 0;
  // The community's count of erasures first, read exactly, so a send that read the members before this person left
  // the index sees it changed once its list is written, and lets its list go (Claude 2 lpgvy on #5072, LOW 1).
  const counted = repliesFor(await redisPipeline([["INCR", erasuresKey(community)], ["EXPIRE", erasuresKey(community), SENDS_SECONDS]]), 2);
  if (!counted || countOf(counted[0]) === null || countOf(counted[1]) === null) throw new UnknownReplyError("a community's count of erasures");
  const listed = repliesFor(await redisPipeline([["SMEMBERS", sendsKey(community)]]), 1)?.[0];
  if (!Array.isArray(listed) || listed.length > ERASE_SENDS_READ_MOST || listed.some((id) => typeof id !== "string")) {
    throw new UnknownReplyError("a community's announcements under way");
  }
  // A member that is not a send's id names no list this code made: let go here, so it never blocks an erasure again
  // (Claude 7 xAF on #5072, NIT), and never walked.
  let sends = (listed as string[]).filter((id) => JOB_ID.test(id));
  const odd = (listed as string[]).filter((id) => !JOB_ID.test(id));
  // Past the cap (a refused send whose own SREM was lost, Claude 2 lpgvy on #5072, LOW 2), the places whose send
  // record is gone are let go too, read exactly; only real sends past the cap refuse the erasure, for its retry.
  let stale: string[] = [];
  if (sends.length > MAX_SENDS_UNDER_WAY) {
    // A send still reading its members has no record yet, only its held mark (Claude 4 AC on #5072, LEVE).
    const there = repliesFor(await redisPipeline(sends.map((id) => ["EXISTS", jobKey(id), heldKey(id)])), sends.length);
    if (!there || there.some((n) => n !== 0 && n !== 1 && n !== 2)) throw new UnknownReplyError("a community's announcements under way");
    stale = sends.filter((_, i) => there[i] === 0);
    sends = sends.filter((_, i) => there[i] !== 0);
  }
  if (odd.length || stale.length) await letStaleGo(sendsKey(community), [...odd, ...stale]);
  if (sends.length > MAX_SENDS_UNDER_WAY) throw new UnknownReplyError("a community's announcements under way");
  if (!sends.length) return 0;
  return (await blankInLists(sends.map(toKey), who)) > 0 ? 1 : 0;
}

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
  const id = randomBytes(12).toString("hex");
  // Its place among the community's sends first, before the members are read, so a person's erasure that takes them
  // out of the index after that read finds this send (Claude 2 lpgvy on #5072, LOW 1).
  if (!(await holdSendPlace(communityId, id))) return { ok: false, reason: "busy" };
  const release = () => redisPipeline([["SREM", sendsKey(communityId), id]]).catch((error: unknown) => console.error("letting go of an announcement's place failed", error));
  let members: Awaited<ReturnType<typeof mailableMembers>>;
  let before: string | null;
  try {
    before = await erasuresCount(communityId);
    members = await mailableMembers(communityId);
  } catch (error) {
    await release();
    throw new RecipientsUnreadError(error);
  }
  if (members.length === 0) {
    await release();
    return { ok: false, reason: "empty" };
  }
  const w = communityWords(store.language);
  const subject = (post.title || w.announceSubject(config.name)).slice(0, 150);
  const body = [post.text, "", w.announceReadIt(config.name), postAddress(store, post.id)].join("\n").trim();
  const job: AnnouncementJob = {
    id,
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
  // Someone erased while the members were read (the count moved, or cannot be read): their key may be in the list and
  // their erasure may have looked before it was written. The list is let go and nothing is sent; the post says it was
  // not emailed, as for a read that failed (Claude 2 lpgvy on #5072, LOW 1).
  let after: string | null | undefined;
  try {
    after = await erasuresCount(communityId);
  } catch {
    after = undefined;
  }
  if (after !== before) {
    await letGo(job.id, communityId);
    throw new RecipientsUnreadError(new UnknownReplyError("a person erased while the community's members were read"));
  }
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
      // A deleted person's place holds the erased mark (forgetAnnouncementRecipient): passed over, never a member.
      if (!slot || !Object.hasOwn(slot, "value") || typeof slot.value !== "string" || !(slot.value === ERASED_MARK || /^[0-9a-f]{32}$/.test(slot.value))) return null;
      keys.push(slot.value);
    }
    const live = keys.filter((key) => key !== ERASED_MARK);
    return new Set(live).size === live.length ? keys : null;
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
      await letGo(id, job?.community);
      return job;
    }
    const store = await load(job.handle);
    const config = store?.community?.id === job.community ? await readConfig(job.community) : null;
    if (!store || !config) {
      job = { ...job, status: "failed", note: "The community is not here anymore." };
      await save(job);
      await letGo(id, job.community);
      return job;
    }
    // Switched off after notices about its content (lib/takedown.ts; any value but nothing or "" reads as off, rule 24):
    // nobody is read, reserved or emailed. It waits in line, saying so, and goes on by itself once the store is back on.
    if (store.suspended) {
      job = { ...job, status: "waiting", note: job.done > 0 ? "Your store is switched off after notices about its content, so nothing more was sent. The rest go out by themselves once your store is back on." : "Your store is switched off after notices about its content, so nothing was sent. It goes out by itself once your store is back on." };
      await save(job);
      return job;
    }
    if (monthlyAllowance(store) === 0 || !store.mail) {
      job = { ...job, status: "waiting", note: "Your plan does not include email right now. It goes out once Pro is on again." };
      await save(job);
      return job;
    }
    job = { ...job, status: "sending", note: "" };
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
        // The places a deleted person stood in are no one's: never read, never sent to, counted as done below.
        const live = keys.filter((k) => k !== ERASED_MARK);
        const found = await readMembersExact(community, live);
        const asking = live.map((k) => found.get(k)).filter((m): m is Member => Boolean(m && m.mail && !m.removed));
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
    }
    await save(job);
    // Its recipient list goes with it, sent or failed (letGo).
    if (job.status === "sent" || job.status === "failed") await letGo(id, job.community);
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
    if (stopped) await letGo(id, job.community);
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
