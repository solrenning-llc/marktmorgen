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
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { orderWrite } from "@/lib/order-data";
import { type BatchMessage, sendBatch } from "@/lib/email";
import { CHECKED_BATCH_SIZE, SENDER_WAIT_NOTE, canWrite, fromLine, monthlyAllowance, release, render, reserve } from "@/lib/mail";
import { SITE_URL } from "@/lib/site-url";
import type { Store } from "@/lib/store";
import {
  type CommunityConfig,
  type Member,
  type Post,
  mailableMembers,
  readConfig,
  readMember,
  readMembers,
  setMail,
  setMemberToken,
} from "@/lib/community";
import { holdsTicket } from "@/lib/community-access";
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

export type QueueResult = { ok: true; job: AnnouncementJob } | { ok: false; reason: "plan" | "empty" };

/** Writes down an announcement's email to go now, to everyone who asked. */
export async function queueAnnouncement(store: Store, config: CommunityConfig, post: Post): Promise<QueueResult> {
  const communityId = store.community?.id;
  if (!communityId || !canAnnounceByEmail(store)) return { ok: false, reason: "plan" };
  const members = await mailableMembers(communityId);
  if (members.length === 0) return { ok: false, reason: "empty" };
  const w = communityWords(store.language);
  const subject = (post.title || w.announceSubject(config.name)).slice(0, 150);
  const body = [post.text, "", w.announceReadIt(config.name), postAddress(store, post.id)].join("\n").trim();
  const job: AnnouncementJob = {
    id: randomBytes(12).toString("hex"),
    community: communityId,
    handle: store.handle,
    post: post.id,
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
  if (member.t) return member.t;
  const token = randomBytes(20).toString("hex");
  // Kept for good, once a member: counted in the store's room (lib/order-data.ts).
  await orderWrite(store, [["SET", unsubKey(token), `${communityId}|${member.k}|${store.handle}`]]);
  await setMemberToken(communityId, member, token);
  return token;
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
    const store = await load(job.handle);
    const config = store?.community?.id === job.community ? await readConfig(job.community) : null;
    if (!store || !config) {
      job = { ...job, status: "failed", note: "The community is not here anymore." };
      await save(job);
      await redisPipeline([["SREM", QUEUE, id]]);
      return job;
    }
    if (monthlyAllowance(store) === 0 || !store.mail) {
      job = { ...job, status: "waiting", note: "Your plan does not include email right now. It goes out once Pro is on again." };
      await save(job);
      return job;
    }
    job = { ...job, status: "sending", note: "" };

    while (job.done < job.total && Date.now() < deadline) {
      // Checked batches (lib/mail.ts): each member is asked of Stripe before sending.
      const keys = await recipientBatch(id, job.done, Math.min(CHECKED_BATCH_SIZE, job.total - job.done));
      if (!keys) {
        job = { ...job, status: "waiting", note: "We couldn't read the remaining recipients. The send is still pending." };
        break;
      }
      const found = await readMembers(job.community, keys);
      const candidates = keys.map((k) => found.get(k)).filter((m): m is Member => Boolean(m && m.mail && !m.removed));
      // Asked batch by batch, so a member who lapsed since it started is left out.
      const letIn = await inTurns(candidates, 5, (m) => holdsTicket(store, config, m.e));
      const recipients = candidates.filter((_, i) => letIn[i]);
      if (recipients.length) {
        const reserved = await reserve(store, recipients.length);
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
        for (const member of recipients) {
          const token = await tokenFor(store, job.community, member);
          const fromName = store.mail?.fromName || store.name;
          const r = render(store, job.subject, job.body, null, {
            page: `${SITE_URL}/unsubscribe?c=${token}`,
            oneClick: `${SITE_URL}/api/mail/unsubscribe?c=${token}`,
            why: communityWords(store.language).announceWhy(fromName, config.name),
            label: communityWords(store.language).stopLabel,
            after: communityWords(store.language).stopAfterAnnounce,
          });
          messages.push({ from: fromLine(store), to: member.e, subject: r.subject, text: r.text, html: r.html, replyTo: store.email, headers: r.headers });
        }
        const outcome = await sendBatch(messages, `cm:${id}:${job.done}:${keys.length}`, { by: "monthly" });
        if (outcome !== "sent") {
          await release(store, recipients.length);
          const failures = job.failures + 1;
          job = failures >= 5
            ? { ...job, status: "failed", failures, note: "The email service would not take it. Nothing more was sent." }
            : { ...job, failures, note: "Paused for a moment: the email service asked us to slow down." };
          break;
        }
      }
      job = { ...job, done: job.done + keys.length, sent: job.sent + recipients.length, failures: 0 };
      await save(job);
    }
    if (job.status === "sending" && job.done >= job.total) {
      job = { ...job, status: "sent" };
      await redisPipeline([["DEL", toKey(id)]]);
    }
    await save(job);
    if (job.status === "sent" || job.status === "failed") await redisPipeline([["SREM", QUEUE, id]]);
    return job;
  } finally {
    await releaseMark(lockKey(id), lock);
  }
}

/** Moves every waiting send on. For the mail job. */
export async function advanceAnnouncements(load: (handle: string) => Promise<Store | null>, deadline: number): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const [raw] = await redisPipeline([["SMEMBERS", QUEUE]]);
  const ids = Array.isArray(raw) ? (raw as string[]) : [];
  let touched = 0;
  for (const id of ids) {
    if (Date.now() > deadline) break;
    if (await advanceAnnouncement(id, load, deadline)) touched += 1;
  }
  return touched;
}

/** Who a stop link belongs to, without acting on it. */
export async function readCommunityUnsub(
  token: string,
): Promise<{ community: string; handle: string; member: Member } | null> {
  if (!COMMUNITY_UNSUB.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", unsubKey(token)]]);
  if (typeof raw !== "string") return null;
  const [community, key, handle] = raw.split("|");
  if (!community || !key || !handle) return null;
  const member = await readMember(community, key);
  return member && member.t === token ? { community, handle, member } : null;
}

/** Stops a member's announcement emails. Safe to press twice. */
export async function stopAnnouncements(token: string): Promise<boolean> {
  const found = await readCommunityUnsub(token);
  if (!found) return false;
  if (found.member.mail) await setMail(found.community, found.member, false);
  return true;
}

/** Deletes the record behind a deleted member's unsubscribe link (lib/community-erasure.ts). */
export async function forgetCommunityUnsub(token: string): Promise<number> {
  if (!token || !isRedisConfigured()) return 0;
  const [gone] = await redisPipeline([["DEL", unsubKey(token)]]);
  return Number(gone) || 0;
}
