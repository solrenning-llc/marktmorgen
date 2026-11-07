/**
 * Links in a one-off email that can be sent somewhere else after it went
 * out (124 [F2-EDIT-SENT-LINKS], unit 1; added 6 November 2026).
 *
 * A creator sends an email with a link that turns out wrong, or ends (a
 * call's address changes, a page moves). Until now the email was beyond
 * reach: its links went straight where they were typed. From now on, in a
 * one-off email made from this day, each of its first SENT_LINKS_MAX links
 * goes through one address of ours, app/go/<handle>/<email>/<n><share>,
 * which carries the address the link was sent with, signed with a key of
 * ours. Everybody who got the email gets the same link: nothing of the
 * reader is in it, nothing is counted when it is opened (no open, no
 * click), and the visible words of the link are the address as typed.
 *
 * What it does when opened (app/go/[handle]/[id]/[link]/route.ts): it
 * checks the signature, so it only ever leads to an address one of our
 * emails was sent with, or to a change the creator made to it, under the
 * rules of lib/sent-link-rules.ts. It counts one of the store's public
 * requests before it reads the change. Whatever cannot be read (the
 * store, its count, the change) leads to the address sent, never further.
 *
 *   nl:mail:bc:<id>:go   the changes to one email's links, in order, with
 *                        the list they belong to (JSON); gone
 *                        SENT_LINK_KEEP_DAYS after the first change, and
 *                        with the store (lib/broadcasts.ts, broadcastKeys);
 *                        written only over exactly the record read before
 *                        (APPEND_SENT_LINK), so two changes made at the same
 *                        moment never write over each other; never
 *                        written past SENT_LINK_RECORD_MAX_BYTES (UTF-8)
 *
 * What a change costs is paid before the email or its history is read
 * (sentLinkChangeUnits, taken by app/api/store/mail/links): the email's own
 * size asked first, inside the request's own studio request, and the history
 * at its longest, read and written as often as a change can, both ways.
 *
 * Old emails cannot be changed: their links point straight at the address,
 * and the studio says so. Sequence emails are written again for whoever
 * comes next, so they are not part of this.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { deriveKey, deriveLegacyKey } from "@/lib/secret-box";
import { SITE_URL } from "@/lib/site-url";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { TAKE_DATA, needData } from "@/lib/store-data";
import { dataBytes, utf8Length } from "@/lib/store-data-rules";
import { broadcastCampaign, variantCampaign } from "@/lib/mail-links";
import type { Store } from "@/lib/store";
import {
  type LinkChange,
  type SentVariant,
  SENT_LINKS_MAX,
  SENT_LINK_CHANGES_MAX,
  SENT_LINK_ENTRY_MAX_BYTES,
  SENT_LINK_KEEP_DAYS,
  SENT_LINK_MAX_LENGTH,
  SENT_LINK_RECORD_MAX_BYTES,
  currentOf,
  destinationProblem,
  linksOf,
} from "@/lib/sent-link-rules";

const KEY_LABEL = "sent-link";
const ID = /^[0-9a-f]{24}$/;
/** The longest address a signed link carries: an address as written, with the email's tag on it. */
const MAX_SIGNED_LENGTH = 4_096;

/** Where the changes to one email's links are kept. */
export const sentLinkKey = (id: string) => `nl:mail:bc:${id}:go`;

/** The changes kept for one email: the list they belong to, when they go (seconds), and every change in order. */
export type SentLinks = { l: string; exp: number; changes: LinkChange[] };

/** The changes could not be read: an unknown reply is not "none". */
export class SentLinksUnreadable extends Error {
  constructor() { super("The changes to this email's links could not be read"); this.name = "SentLinksUnreadable"; }
}
/** A change may have been written though its answer was lost. */
export class SentLinkWriteUnconfirmed extends Error {
  constructor() { super("The change to this link could not be confirmed"); this.name = "SentLinkWriteUnconfirmed"; }
}

/** Whether links can be signed here; without the key, emails keep their links straight to the address. */
export function sentLinksReady(): boolean {
  return deriveKey(KEY_LABEL) !== null;
}

function signature(key: Buffer, handle: string, id: string, n: number, variant: SentVariant, sent: string): string {
  return createHmac("sha256", key).update(`nimbus-sent-link|${handle}|${id}|${n}|${variant}|${sent}`).digest("hex").slice(0, 32);
}

/** The share a campaign of this email is (lib/mail-links.ts): its own, or one subject line's. */
export function variantOf(id: string, campaign: string): SentVariant | null {
  if (campaign === broadcastCampaign(id)) return "x";
  if (campaign === variantCampaign(id, "a")) return "a";
  if (campaign === variantCampaign(id, "b")) return "b";
  return null;
}

/** The campaign a share of this email carries. */
export function campaignOf(id: string, variant: SentVariant): string {
  return variant === "x" ? broadcastCampaign(id) : variantCampaign(id, variant);
}

/**
 * For the email about to go out: where each of its first links leads
 * instead, given the address as written and the address it would have
 * gone to (tagged, lib/mail-links.ts). The same for every reader. Undefined
 * when links cannot be signed here, so they go straight where written.
 */
export function sentLinksFor(handle: string, id: string, campaign: string, body: string): ((href: string, tagged: string) => string) | undefined {
  const key = deriveKey(KEY_LABEL);
  const variant = variantOf(id, campaign);
  if (!key || !variant || !ID.test(id)) return undefined;
  const hrefs = linksOf(body);
  const made = new Map<string, string>();
  return (href, tagged) => {
    const n = hrefs.indexOf(href);
    if (n < 0 || tagged.length > MAX_SIGNED_LENGTH || !/^https:\/\//.test(tagged)) return tagged;
    const known = made.get(`${n}|${tagged}`);
    if (known) return known;
    const link = `${SITE_URL}/go/${encodeURIComponent(handle)}/${id}/${n}${variant}?u=${encodeURIComponent(tagged)}&s=${signature(key, handle, id, n, variant, tagged)}`;
    made.set(`${n}|${tagged}`, link);
    return link;
  };
}

/**
 * The address a link was sent with, when the signature on it is ours for
 * exactly this store, email, link and share; null otherwise. Checked with
 * the key in use and the one before it.
 */
export function sentAddress(handle: string, id: string, n: number, variant: SentVariant, sent: string, given: string): string | null {
  if (!ID.test(id) || !Number.isSafeInteger(n) || n < 0 || n >= SENT_LINKS_MAX) return null;
  if (typeof sent !== "string" || sent.length > MAX_SIGNED_LENGTH || typeof given !== "string" || !/^[0-9a-f]{32}$/.test(given)) return null;
  let url: URL;
  try {
    url = new URL(sent);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  for (const key of [deriveKey(KEY_LABEL), deriveLegacyKey(KEY_LABEL)]) {
    if (!key) continue;
    const made = signature(key, handle, id, n, variant, sent);
    if (timingSafeEqual(Buffer.from(made), Buffer.from(given))) return sent;
  }
  return null;
}

function parseKept(raw: unknown): SentLinks {
  if (typeof raw !== "string") throw new SentLinksUnreadable();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SentLinksUnreadable();
  }
  const kept = value as Partial<SentLinks> | null;
  if (!kept || typeof kept !== "object" || typeof kept.l !== "string" || !Number.isSafeInteger(kept.exp) || !Array.isArray(kept.changes)) throw new SentLinksUnreadable();
  if (kept.changes.length > SENT_LINK_CHANGES_MAX) throw new SentLinksUnreadable();
  for (const change of kept.changes as unknown[]) {
    const c = change as Partial<LinkChange> | null;
    if (!c || typeof c !== "object" || !Number.isSafeInteger(c.n) || (c.n as number) < 0 || (c.n as number) >= SENT_LINKS_MAX) throw new SentLinksUnreadable();
    if (typeof c.to !== "string" || c.to.length > SENT_LINK_MAX_LENGTH || !Number.isSafeInteger(c.at)) throw new SentLinksUnreadable();
  }
  return { l: kept.l, exp: kept.exp as number, changes: (kept.changes as LinkChange[]).map((c) => ({ n: c.n, to: c.to, at: c.at })) };
}

/** The record as read, exactly (lib/redis-reply.ts), with what it says: both null when there is none. */
async function readKept(id: string): Promise<{ raw: string | null; kept: SentLinks | null }> {
  if (!isRedisConfigured()) throw new SentLinksUnreadable();
  const reply = repliesFor(await redisPipeline([["GET", sentLinkKey(id)]]), 1);
  if (!reply) throw new SentLinksUnreadable();
  if (reply[0] === null) return { raw: null, kept: null };
  if (typeof reply[0] !== "string") throw new SentLinksUnreadable();
  return { raw: reply[0], kept: parseKept(reply[0]) };
}

/** The changes kept for one email: null when there are none; SentLinksUnreadable when the answer is not one. */
export async function readSentLinks(id: string): Promise<SentLinks | null> {
  if (!ID.test(id)) return null;
  return (await readKept(id)).kept;
}

/** What one studio request pays for in the database (tests/plan-cost-registry.ts, UNIT_COST.studio). */
const STUDIO_UNIT_COMMANDS = 20;
const STUDIO_UNIT_BYTES = 50_000;
/** Commands a further take of studio requests sends, at the most (lib/store-allowance.ts: its count, a place for a store that pays nothing, a refusal given back). */
const TAKE_COMMANDS = 4;
/**
 * TAKE_DATA's calls inside, at the most, which Upstash bills one by one
 * beside the EVAL: the total and the month list read, the slot read and
 * written, the list and the total written, and a read and a drop for each
 * month that ended since the store's room was last touched (any studio write
 * touches it), taken at two years of them; only the first call of a request
 * finds any.
 */
const DATA_INSIDE_FIRST = 6 + 2 * 24;
const DATA_INSIDE_AGAIN = 6;
/** How much an email's record may grow while it is read, after its size was asked: its count sent, its note and failures. */
const EMAIL_GROWTH_BYTES = 4_096;
/** A stored value as it crosses to the database and back as JSON: each byte escaped once more at the most, and its quotes. */
const wireOf = (bytes: number) => 2 * bytes + 64;
/**
 * The history as it crosses: no address has a quote, a backslash, a control
 * character or half a character in it (lib/sent-link-rules.ts) and the list
 * is the store's own id, so only the history's own quotes are escaped again,
 * eight a change and eight more.
 */
const HISTORY_WIRE_BYTES = SENT_LINK_RECORD_MAX_BYTES + 2 * (8 * SENT_LINK_CHANGES_MAX + 8) + 64;

/**
 * The studio requests one change takes beyond the request's own, before the
 * email or its history is read: what changeLink and the route send and read
 * at the most, both ways, for an email of `emailBytes` (as stored), with the
 * history at SENT_LINK_RECORD_MAX_BYTES read and written over
 * SENT_LINK_WRITE_TRIES times and read back once when a write's answer is
 * lost. The larger of what its bytes and its commands come to, in studio
 * requests of twenty commands and fifty kilobytes. Held over what is
 * measured in tests/f2-sent-links-cost.test.ts.
 */
export function sentLinkChangeUnits(emailBytes: number): number {
  const email = Number.isSafeInteger(emailBytes) && emailBytes > 0 ? emailBytes : 0;
  // The scripts as they are sent, with their arguments besides the history.
  const appendWire = utf8Length(JSON.stringify(APPEND_SENT_LINK)) + 256;
  const dataWire = utf8Length(JSON.stringify(TAKE_DATA)) + 512;
  const tryBytes = HISTORY_WIRE_BYTES + 64 + dataWire + appendWire + 2 * HISTORY_WIRE_BYTES;
  const bytes = 512 + wireOf(email + EMAIL_GROWTH_BYTES) + SENT_LINK_WRITE_TRIES * tryBytes + HISTORY_WIRE_BYTES + 64;
  const commands = TAKE_COMMANDS + 1 + (1 + 1 + DATA_INSIDE_FIRST + 3) + (SENT_LINK_WRITE_TRIES - 1) * (1 + 1 + DATA_INSIDE_AGAIN + 3) + 1;
  return Math.max(Math.ceil(bytes / STUDIO_UNIT_BYTES), Math.ceil(commands / STUDIO_UNIT_COMMANDS));
}

/**
 * A change that may land on a history between the studio page asking its
 * size and reading it: one entry at its longest. A history grown further is
 * read no further than that (GETRANGE), so it does not parse and the page
 * says it could not be read.
 */
const SHOWN_GROWTH_BYTES = SENT_LINK_ENTRY_MAX_BYTES;
/** One read of a history as it is sent: its command, with the key and the range. */
const SHOWN_READ_COMMAND_BYTES = 128;

/**
 * The studio requests the page "Change where a link goes" takes, beyond its
 * own, to read the histories of the emails it shows, from each one's size as
 * stored (0 when it has none, and then it is not read): one GETRANGE each, up
 * to its size and SHOWN_GROWTH_BYTES more, both ways as JSON (each byte
 * escaped once more at the most, wireOf: what is stored is JSON written by
 * changeLink), and the take itself. 0 when there is nothing to read. Held
 * over what is measured in tests/f2-sent-links-page-cost.test.ts.
 */
export function sentLinksShownUnits(sizes: readonly number[]): number {
  const read = sizes.filter((size) => Number.isSafeInteger(size) && size > 0);
  if (!read.length) return 0;
  const bytes = 512 + read.reduce((sum, size) => sum + SHOWN_READ_COMMAND_BYTES + wireOf(size + SHOWN_GROWTH_BYTES), 0);
  const commands = TAKE_COMMANDS + read.length;
  return Math.max(Math.ceil(bytes / STUDIO_UNIT_BYTES), Math.ceil(commands / STUDIO_UNIT_COMMANDS));
}

/** The shortest address a change can send a link to: no change is shorter in bytes. */
const SHORTEST_ADDRESS = "https://a";

/**
 * Whether a history has no room in bytes for even the shortest change, though
 * under SENT_LINK_CHANGES_MAX changes: written as changeLink writes it, and
 * past SENT_LINK_RECORD_MAX_BYTES, so every change would be refused. Only a
 * history kept before the ceiling was checked can be like that.
 */
export function sentLinksNoRoom(kept: SentLinks, nowSeconds: number): boolean {
  if (kept.changes.length >= SENT_LINK_CHANGES_MAX) return false;
  const next: SentLinks = { l: kept.l, exp: kept.exp, changes: [...kept.changes, { n: 0, to: SHORTEST_ADDRESS, at: nowSeconds }] };
  return utf8Length(JSON.stringify(next)) > SENT_LINK_RECORD_MAX_BYTES;
}

/** What the studio page shows of the histories: each read one (null: never changed), and those with no room left; or why none was read. */
export type ShownSentLinks = { ok: true; kept: Map<string, SentLinks | null>; noRoom: Set<string> } | { ok: false; refused: string };

/**
 * The histories of the emails the studio page shows (#3034, Claude 5): their
 * sizes first (one STRLEN each, inside the page's own studio requests), then
 * the studio requests reading them comes to at the most (sentLinksShownUnits)
 * are taken through `pay`, and only then is each one that exists read, no
 * further than paid. Without them nothing is read and the refusal says why.
 * One unread or unreadable is left out of `kept`, and the page says it could
 * not be read.
 */
export async function readShownSentLinks(ids: string[], pay: (units: number) => Promise<{ ok: true } | { ok: false; message: string }>, now = Date.now()): Promise<ShownSentLinks> {
  const kept = new Map<string, SentLinks | null>();
  const noRoom = new Set<string>();
  const wanted = ids.filter((id) => ID.test(id));
  if (!wanted.length || !isRedisConfigured()) return { ok: true, kept, noRoom };
  // Exactly one reply a size (lib/redis-reply.ts), or none is known.
  const sized = repliesFor(await redisPipeline(wanted.map((id) => ["STRLEN", sentLinkKey(id)])), wanted.length);
  if (!sized || sized.some((size) => !Number.isSafeInteger(size) || (size as number) < 0)) return { ok: true, kept, noRoom };
  const sizes = sized as number[];
  const units = sentLinksShownUnits(sizes);
  if (units > 0) {
    const paid = await pay(units);
    if (!paid.ok) return { ok: false, refused: paid.message };
  }
  const read: { id: string; size: number }[] = [];
  wanted.forEach((id, i) => (sizes[i] > 0 ? read.push({ id, size: sizes[i] }) : kept.set(id, null)));
  if (!read.length) return { ok: true, kept, noRoom };
  const replies = repliesFor(await redisPipeline(read.map(({ id, size }) => ["GETRANGE", sentLinkKey(id), 0, size + SHOWN_GROWTH_BYTES - 1])), read.length);
  if (!replies) return { ok: true, kept, noRoom };
  const at = Math.floor(now / 1000);
  read.forEach(({ id }, i) => {
    // Gone since its size was asked: its links go where the email sent them.
    if (replies[i] === "") return kept.set(id, null);
    try {
      const one = parseKept(replies[i]);
      kept.set(id, one);
      if (sentLinksNoRoom(one, at)) noRoom.add(id);
    } catch {
      // Not shown as "never changed": left out, and the studio says it could not be read.
    }
  });
  return { ok: true, kept, noRoom };
}

/**
 * The size of a sent email's record as stored, in bytes, asked before it is
 * read (one STRLEN, inside the request's own studio request): 0 when there is
 * none, null when the answer is not one.
 */
export async function sentEmailBytes(id: string): Promise<number | null> {
  if (!ID.test(id)) return 0;
  if (!isRedisConfigured()) return null;
  try {
    const reply = repliesFor(await redisPipeline([["STRLEN", `nl:mail:bc:${id}`]]), 1);
    return reply && Number.isSafeInteger(reply[0]) && (reply[0] as number) >= 0 ? (reply[0] as number) : null;
  } catch {
    return null;
  }
}

/** The emails the page "Change where a link goes" reads, newest first: as many as it read before (lib/broadcasts.ts, listBroadcastsStrict's default). */
export const SHOWN_EMAILS_READ = 30;
const STATUSES = new Set(["scheduled", "sending", "sent", "waiting", "cancelled", "failed"]);

/** A sent email as the studio page needs it (lib/broadcasts.ts, Broadcast). */
export type ShownEmail = { id: string; subject: string; body: string; sent: number; links?: true; finishedAt: number; sendAt: number };
/** The store's newest emails, or why none was read. */
export type ShownEmails = { ok: true; emails: ShownEmail[] } | { ok: false; refused: string };

/**
 * The studio requests the page takes, beyond its own, to read the emails
 * whose sizes as stored are `sizes`, each up to its size and `growth` bytes
 * more (GETRANGE), both ways as JSON (each byte escaped once more at the
 * most, wireOf), and the take itself. 0 when there is nothing to read. Held
 * over what is measured in tests/f2-sent-links-page-emails-cost.test.ts.
 */
export function sentEmailsShownUnits(sizes: readonly number[], growth = 0): number {
  const read = sizes.filter((size) => Number.isSafeInteger(size) && size > 0);
  if (!read.length) return 0;
  const bytes = 512 + read.reduce((sum, size) => sum + SHOWN_READ_COMMAND_BYTES + wireOf(size + growth), 0);
  const commands = TAKE_COMMANDS + read.length;
  return Math.max(Math.ceil(bytes / STUDIO_UNIT_BYTES), Math.ceil(commands / STUDIO_UNIT_COMMANDS));
}

/** One email's record, checked as listBroadcastsStrict checks what the page uses of it: null when it is not one (or was read short). */
function parseShownEmail(raw: unknown, id: string, listId: string): ShownEmail | null {
  if (typeof raw !== "string" || !raw) return null;
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    value = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const words = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;
  const { subject, body, sent, total, finishedAt, sendAt, createdAt } = value;
  if (value.id !== id || value.listId !== listId || !words(value.handle) || !words(subject) || !words(body) || !STATUSES.has(value.status as string)) return null;
  if (!count(sent) || !count(total) || sent > total || !count(finishedAt) || !count(sendAt) || !sendAt || !count(createdAt) || !createdAt) return null;
  return { id, subject, body, sent, finishedAt, sendAt, ...(value.links === true ? { links: true as const } : {}) };
}

/**
 * The store's newest emails for the studio page "Change where a link goes"
 * (#3034, Claude 5's review): the list and each email's size first (one
 * LRANGE, then one STRLEN each, inside the page's own studio requests), then
 * the studio requests reading them comes to (sentEmailsShownUnits) are taken
 * through `pay`, and only then is each read, no further than its size. One
 * that grew since (its send moving on: its count, its note) is read once more
 * up to EMAIL_GROWTH_BYTES further, paid first. All or nothing, as
 * listBroadcastsStrict (lib/broadcasts.ts): an index or a record that is not
 * one throws, and the page says the emails could not be read. Without the
 * studio requests nothing is read and the refusal says why.
 */
export async function readShownSentEmails(listId: string | null, pay: (units: number) => Promise<{ ok: true } | { ok: false; message: string }>, limit = SHOWN_EMAILS_READ): Promise<ShownEmails> {
  if (!listId) return { ok: true, emails: [] };
  if (!isRedisConfigured()) throw new Error("Campaign storage is unavailable");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid campaign history limit");
  const index = repliesFor(await redisPipeline([["LRANGE", `nl:mail:bcs:${listId}`, 0, limit - 1]]), 1);
  if (!index || !Array.isArray(index[0])) throw new Error("Campaign index is unavailable");
  const ids: unknown[] = index[0];
  if (ids.length > limit || ids.some((id) => typeof id !== "string" || !ID.test(id)) || new Set(ids).size !== ids.length) throw new Error("Campaign index is incomplete");
  if (!ids.length) return { ok: true, emails: [] };
  const wanted = ids as string[];
  const key = (id: string) => `nl:mail:bc:${id}`;
  const sized = repliesFor(await redisPipeline(wanted.map((id) => ["STRLEN", key(id)])), wanted.length);
  if (!sized || sized.some((size) => !Number.isSafeInteger(size) || (size as number) <= 0)) throw new Error("Campaign records are incomplete");
  const sizes = sized as number[];
  const paid = await pay(sentEmailsShownUnits(sizes));
  if (!paid.ok) return { ok: false, refused: paid.message };
  const replies = repliesFor(await redisPipeline(wanted.map((id, i) => ["GETRANGE", key(id), 0, sizes[i] - 1])), wanted.length);
  if (!replies) throw new Error("Campaign records are incomplete");
  const emails = wanted.map((id, i) => parseShownEmail(replies[i], id, listId));
  const again = wanted.flatMap((id, i) => (emails[i] ? [] : [{ i, id, size: sizes[i] }]));
  if (again.length) {
    // Grown since its size was asked, or not one: read once more, paid first, no further than a send can write on it.
    const more = await pay(sentEmailsShownUnits(again.map(({ size }) => size), EMAIL_GROWTH_BYTES));
    if (!more.ok) return { ok: false, refused: more.message };
    const second = repliesFor(await redisPipeline(again.map(({ id, size }) => ["GETRANGE", key(id), 0, size + EMAIL_GROWTH_BYTES - 1])), again.length);
    if (!second) throw new Error("Campaign records are incomplete");
    again.forEach(({ i, id }, j) => (emails[i] = parseShownEmail(second[j], id, listId)));
  }
  if (emails.some((email) => email === null)) throw new Error("Invalid campaign record");
  return { ok: true, emails: emails as ShownEmail[] };
}

/** The email as the studio and the change need it (lib/broadcasts.ts, Broadcast). */
export type SentEmail = { id: string; listId: string; handle: string; body: string; sent: number; links?: true };

export type ChangeResult =
  | { ok: true; changes: LinkChange[] }
  | { ok: false; reason: "none" | "old" | "unsent" | "link" | "to" | "full" | "busy"; message: string };

export const CHANGE_REFUSALS: Record<Exclude<ChangeResult, { ok: true }>["reason"], string> = {
  none: "That email is not one of this store's.",
  old: "This email was sent before links could be changed. Its links go straight to the addresses written in it.",
  unsent: "This email has not gone to anybody yet. Change its words instead, before it goes.",
  link: "That link is not one of this email's.",
  to: "That address cannot be used.",
  full: `This email's links have been changed ${SENT_LINK_CHANGES_MAX} times, the most kept for one email. Each one keeps going where it goes now.`,
  busy: "This email's links were being changed somewhere else at the same moment, so this change was not saved. Reload the page to see where each link goes now, then try again.",
};

/** A history that has no room in bytes for another change (SENT_LINK_RECORD_MAX_BYTES). */
const CHANGE_REFUSALS_SIZE = "This email's links have no room left for another change. Each one keeps going where it goes now.";

/** Reads of the history and writes over it, in all, before a change made at the same moment as others says it was not saved. */
export const SENT_LINK_WRITE_TRIES = 2;

/**
 * KEYS[1] one email's changes. ARGV[1] the record exactly as read before
 * ("" when there was none), ARGV[2] the record with the new change, ARGV[3]
 * its time to live in seconds. Writes it only while the key still holds
 * exactly what was read, in one step: a change another request saved since
 * is never written over (Codex P and Codex J on #3034). Answers 1 when
 * written, 0 when the record changed since (nothing written). The first
 * line names it for the local stand-in (lib/redis-memory.ts).
 */
export const APPEND_SENT_LINK = `-- marktmorgen:sent-link-append:v1
local current = redis.call("GET", KEYS[1])
if (current or "") ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
return 1`;

/**
 * Writes `next` over exactly `raw` (null: only where there is none). "written" or "changed" (another change landed
 * first, nothing written); an answer of any other shape is read back, and only our own record there is "written":
 * anything else throws SentLinkWriteUnconfirmed, since the write may have landed.
 */
async function writeOver(id: string, raw: string | null, next: string, seconds: number): Promise<"written" | "changed"> {
  let answer: unknown;
  try {
    const replies = repliesFor(await redisPipeline([["EVAL", APPEND_SENT_LINK, 1, sentLinkKey(id), raw ?? "", next, seconds]]), 1);
    answer = replies ? replies[0] : undefined;
  } catch {
    answer = undefined;
  }
  if (answer === 1) return "written";
  if (answer === 0) return "changed";
  try {
    const back = repliesFor(await redisPipeline([["GET", sentLinkKey(id)]]), 1);
    if (back && back[0] === next) return "written";
  } catch {
    // Not read: unknown, below.
  }
  throw new SentLinkWriteUnconfirmed();
}

/**
 * Sends link `n` of a sent email somewhere else, under the rules of
 * lib/sent-link-rules.ts, kept after every change before it. Its room in
 * the store's data room is taken first (DataRoomError when it does not
 * fit). The new history is written only over exactly the one read
 * (APPEND_SENT_LINK): when another change landed in between, the history is
 * read again and checked again (its list, its most changes, its expiry,
 * whether the link already goes there), up to SENT_LINK_WRITE_TRIES reads
 * in all, reusing the room already taken where it covers the record; past
 * them it answers "busy", never a success, with nothing written. "Saved"
 * is said only for a change written. Throws SentLinksUnreadable when what
 * is kept cannot be read, and SentLinkWriteUnconfirmed when the write's
 * answer is unknown and our record is not read back.
 *
 * Room taken for a write that then did not land (another change came first
 * and the check refused or no longer needed it, or the room had to be taken
 * again until a later expiry) is not given back: what expires by itself is
 * never given back early (lib/store-data.ts, giveData), so it errs toward a
 * fuller room, never toward storage nobody counted.
 */
export async function changeLink(store: Store, email: SentEmail, n: number, raw: string, now = Date.now()): Promise<ChangeResult> {
  const refuse = (reason: Exclude<ChangeResult, { ok: true }>["reason"], message = CHANGE_REFUSALS[reason]): ChangeResult => ({ ok: false, reason, message });
  // The list, not the address: a store that changed its address keeps its list, and its emails stay its own.
  if (!ID.test(email.id) || !store.listId || email.listId !== store.listId) return refuse("none");
  if (email.links !== true) return refuse("old");
  if (!(email.sent > 0)) return refuse("unsent");
  const hrefs = linksOf(email.body);
  if (!Number.isSafeInteger(n) || n < 0 || n >= hrefs.length) return refuse("link");
  const problem = destinationProblem(raw, hrefs[n], store);
  if (problem) return refuse("to", problem);
  const to = raw.trim();
  const at = Math.floor(now / 1000);
  let held: { bytes: number; until: number } | null = null;
  for (let tries = 0; tries < SENT_LINK_WRITE_TRIES; tries += 1) {
    const { raw: before, kept } = await readKept(email.id);
    if (kept && kept.l !== store.listId) return refuse("none");
    const changes = kept?.changes ?? [];
    if ((currentOf(changes, n) ?? hrefs[n]) === to) return { ok: true, changes };
    if (changes.length >= SENT_LINK_CHANGES_MAX) return refuse("full");
    const exp = kept?.exp ?? at + SENT_LINK_KEEP_DAYS * 86_400;
    if (exp <= at) return refuse("full");
    const entry: LinkChange = { n, to, at };
    const next: SentLinks = { l: store.listId, exp, changes: [...changes, entry] };
    const written = JSON.stringify(next);
    // Never past the ceiling in bytes, whatever was kept before it was checked: what is read and sent stays bounded by it.
    if (utf8Length(written) > SENT_LINK_RECORD_MAX_BYTES) return refuse("full", CHANGE_REFUSALS_SIZE);
    // The change's bytes, and the record's own the first time, until the record goes.
    const bytes = dataBytes([kept ? "" : JSON.stringify({ l: next.l, exp, changes: [] }), `${JSON.stringify(entry)},`], kept ? 0 : 1);
    const until = exp * 1000;
    if (!held || until > held.until) {
      await needData(store, [{ until, bytes }], now);
      held = { bytes, until };
    } else if (bytes > held.bytes) {
      await needData(store, [{ until: held.until, bytes: bytes - held.bytes }], now);
      held = { bytes, until: held.until };
    }
    if ((await writeOver(email.id, before, written, Math.max(1, exp - at))) === "written") return { ok: true, changes: next.changes };
    // Another change landed first: read it, and check this one again against it.
  }
  return refuse("busy");
}
