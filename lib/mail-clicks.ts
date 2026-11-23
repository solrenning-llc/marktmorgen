/**
 * Which links in a sequence's emails somebody used — only for somebody who
 * allowed it (added 11 October 2026).
 *
 * A sequence could send an email only to some of the people in it, read from
 * what the list keeps (lib/flow-rules.ts). The condition creators reach for
 * first — "if they used the link in the last email, send this; if not, that"
 * — needs to know who used a link, and the emails had promised to say
 * nothing about who anybody is (lib/mail-links.ts). Counting it for everyone
 * would break that promise, and in Europe it needs the reader's consent.
 *
 * So it is asked for, apart from joining: a second box, empty, under the box
 * that joins the list, which only shows once that one is ticked. Somebody who
 * ticks it gets, in a sequence's emails, links to the creator's store that
 * carry one more parameter: a key made from their unsubscribe token, which
 * cannot be turned back into it. When that link opens a page of the store,
 * the page (components/mail-click.tsx) says which email it came from, and
 * the key is taken out of the address bar. Nothing else is counted: no
 * pixel, no open, no link to anywhere but the store, no one-off email.
 *
 *   nl:mail:mk:<key>               the unsubscribe token it was made from
 *   nl:mail:clk:<list>:<person>    the emails whose links they used (a set),
 *                                  gone 90 days after the last one
 *
 * Taken back in one press from a line at the foot of every email they get
 * while it is on (app/unsubscribe, an `l` link), which deletes what was
 * counted at once; and by unsubscribing, which takes it back too.
 * Somebody who never allowed it, or took it back, counts as not having used
 * any link, so an email "for those who did not" still reaches them.
 */
import { createHash } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor, stringList, UnknownReplyError } from "@/lib/redis-reply";
import { UNSUB_TOKEN, leadsKey, mailable, readUnsubToken, takeBackClicks } from "@/lib/contacts";
import { suppressedKey, suppressionPrint } from "@/lib/suppression";

/** How long a used link is remembered after the last one, in days. */
export const CLICK_DAYS = 90;
export const LINK_KEY = /^[0-9a-f]{24}$/;
/** Only a sequence's emails are counted (lib/mail-links.ts, stepCampaign). */
export const STEP_CAMPAIGN = /^s-[0-9a-f]{16}-[0-9a-f]{16}$/;
/** The parameter the key travels in. */
export const LINK_PARAM = "mk";

const KEY_SECONDS = 400 * 86_400;
export const keyIndex = (key: string) => `nl:mail:mk:${key}`;
const person = (email: string) => createHash("sha256").update(`nimbus-clk:${normaliseEmail(email)}`).digest("hex").slice(0, 32);
const usedKey = (listId: string, email: string) => `nl:mail:clk:${listId}:${person(email)}`;

/**
 * Keeps a click only while both the link marker and the consent row are still
 * exactly the ones noteClick read. A revocation either runs first and this
 * writes nothing, or runs second and deletes the click.
 */
const NOTE_CLICK_IF_ALLOWED = `-- marktmorgen:mail-click-if-allowed:v1
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call("HGET", KEYS[2], ARGV[2]) ~= ARGV[3] then return 0 end
redis.call("SADD", KEYS[3], ARGV[4])
redis.call("EXPIRE", KEYS[3], ARGV[5])
return 1`;

/**
 * Writes a reader's key only while they still allow their link use to be seen (Codex G-20261121-0033): the address is
 * not deleted from the store (its print absent from the store's deletion hash), and their row on the list still holds
 * this token, the permission and a yes not taken back. A sequence reads its readers, then writes their keys; a
 * deletion, an unsubscribe or the permission taken back that finished in between deletes the key before this would
 * write it, so a plain SET wrote it back for KEY_SECONDS with nothing left to delete it. KEYS[1] the store's deletion
 * prints, KEYS[2] the list's rows, KEYS[3] the key's marker; ARGV the print, the address, the token, the seconds.
 * 1 written; 0 not allowed any more, or a row it cannot read, which writes nothing (the safe side). Billed 1 + 3; lib/redis-memory.ts runs it the
 * same way.
 */
export const MAIL_CLICK_KEY_LIVE = `-- marktmorgen:mail-click-key-live:v1
if redis.call("HGET", KEYS[1], ARGV[1]) then return 0 end
local raw = redis.call("HGET", KEYS[2], ARGV[2])
if not raw then return 0 end
local ok, row = pcall(cjson.decode, raw)
if not ok or type(row) ~= "table" then return 0 end
if row["t"] ~= ARGV[3] or row["agreed"] ~= true or row["unsub"] == true or type(row["clicks"]) ~= "string" or row["clicks"] == "" then return 0 end
redis.call("SET", KEYS[3], ARGV[3], "EX", ARGV[4])
return 1`;

/**
 * The Redis commands one reader's key costs, as Upstash bills a script (1 + every redis.call inside it): the EVAL, its
 * print HGET, its row HGET and its SET. Priced on every monthly email (tests/plan-cost-registry.ts, "mail-click-keys")
 * and measured in tests/mail-click-key-consent-race.test.ts.
 */
export const MAIL_CLICK_KEY_COMMANDS = 4;

/** The key a reader's links carry, from their unsubscribe token; it cannot be turned back into it. */
export function linkKeyOf(token: string): string {
  return createHash("sha256").update(`nimbus-mk:${token}`).digest("hex").slice(0, 24);
}

/**
 * Makes these readers' keys lead back to them, for the emails about to go: each written only while that reader still
 * allows it (MAIL_CLICK_KEY_LIVE). Answers the keys written, by token; a reader whose key was not written gets links
 * with no key, as somebody who never allowed it. A reply it cannot read throws, and the batch is tried again.
 */
export async function rememberLinkKeys(listId: string, readers: { email: string; token: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const asked = readers.filter((reader) => UNSUB_TOKEN.test(reader.token));
  if (!asked.length || !isRedisConfigured()) return out;
  const replies = repliesFor(await redisPipeline(asked.map(({ email, token }) => [
    "EVAL", MAIL_CLICK_KEY_LIVE, "3", suppressedKey(listId), leadsKey(listId), keyIndex(linkKeyOf(token)),
    suppressionPrint(listId, email), email, token, String(KEY_SECONDS),
  ])), asked.length);
  if (!replies || replies.some((reply) => reply !== 0 && reply !== 1)) throw new UnknownReplyError("a reader's link key");
  asked.forEach(({ token }, i) => {
    if (replies[i] === 1) out.set(token, linkKeyOf(token));
  });
  return out;
}

/**
 * Notes that the reader behind `key` used a link in the email `campaign`.
 * Only while they allow it and are still on the list. Says whether it was
 * noted.
 */
export async function noteClick(key: string, campaign: string): Promise<boolean> {
  if (!LINK_KEY.test(key) || !STEP_CAMPAIGN.test(campaign) || !isRedisConfigured()) return false;
  const [token] = await redisPipeline([["GET", keyIndex(key)]]);
  if (typeof token !== "string") return false;
  const found = await readUnsubToken(token);
  if (!found || !found.contact.clicks || !mailable(found.contact)) return false;
  const used = usedKey(found.listId, found.email);
  const kept = repliesFor(await redisPipeline([[
    "EVAL", NOTE_CLICK_IF_ALLOWED, "3", keyIndex(key), leadsKey(found.listId), used,
    token, found.email, found.raw, campaign, String(CLICK_DAYS * 86_400),
  ]]), 1);
  if (!kept || (kept[0] !== 0 && kept[0] !== 1)) throw new UnknownReplyError("a consented link use");
  return kept[0] === 1;
}

/** Which of these people used a link in the email `campaign`. */
export async function usedLinkIn(listId: string, campaign: string, emails: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!emails.length || !isRedisConfigured()) return out;
  const answers = await redisPipeline(emails.map((email) => ["SISMEMBER", usedKey(listId, email), campaign]));
  // A missing or malformed answer is not evidence that somebody did not use
  // the link.  Callers use absence from this set for an `unclicked` branch,
  // so fail the whole read and let the sequence retry without sending.
  if (answers.length !== emails.length || answers.some((answer) => answer !== 0 && answer !== 1)) {
    throw new Error("link use could not be read");
  }
  emails.forEach((email, i) => {
    if (answers[i] === 1) out.add(email);
  });
  return out;
}

/** Whether the reader behind this unsubscribe link allows their link use to be seen now. */
export async function countingFor(token: string): Promise<{ email: string; handle: string; listId: string; on: boolean } | null> {
  const found = await readUnsubToken(token);
  return found ? { email: found.email, handle: found.handle, listId: found.listId, on: Boolean(found.contact.clicks) && mailable(found.contact) } : null;
}

/**
 * Takes the permission back: nothing more is counted, what was counted is
 * deleted, and their links stop carrying the key. Says whether it was found.
 */
export async function stopCounting(token: string): Promise<boolean> {
  const found = await readUnsubToken(token);
  if (!found) return false;
  const { listId, email, contact } = found;
  // The permission is taken off the row first, then the key and what was counted are deleted: a sequence writing a
  // key in between (rememberLinkKeys) writes it only while the row still allows it, so this deletion comes after it
  // (Codex G-20261121-0033). Written only over the row as read (lib/contacts.ts): an unsubscribe or a deletion in
  // between is never undone.
  if (contact.clicks) await takeBackClicks(listId, email);
  await redisPipeline([
    ["DEL", usedKey(listId, email)],
    ["DEL", keyIndex(linkKeyOf(token))],
  ]);
  return true;
}

/**
 * Deletes what is counted of one person's link use on this list, and the key
 * their links carried (lib/person-erasure.ts). Run before the list forgets
 * them, while the token their key was made from can still be read.
 */
export async function forgetClicksPerson(listId: string | null, rawEmail: string): Promise<number> {
  if (!listId || !isRedisConfigured()) return 0;
  const email = normaliseEmail(rawEmail);
  const read = repliesFor(await redisPipeline([["HGET", leadsKey(listId), email]]), 1);
  if (!read || (read[0] !== null && typeof read[0] !== "string")) throw new UnknownReplyError("a link-use contact");
  const raw = read[0];
  let token = "";
  if (raw !== null) {
    let value: unknown;
    try { value = JSON.parse(raw as string); } catch { throw new UnknownReplyError("a link-use contact"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new UnknownReplyError("a link-use contact");
    const kept = value as Record<string, unknown>;
    // Legacy Lead rows have no token. rememberLinkKeys only writes a marker
    // for UNSUB_TOKEN, so an absent/invalid field has no possible marker.
    // Still erase the known click set; unknown transport/JSON stays unknown.
    token = typeof kept.t === "string" && UNSUB_TOKEN.test(kept.t) ? kept.t : "";
  }
  const keys = [usedKey(listId, email), ...(UNSUB_TOKEN.test(token) ? [keyIndex(linkKeyOf(token))] : [])];
  const deleted = repliesFor(await redisPipeline([["DEL", ...keys]]), 1);
  const gone = deleted ? countOf(deleted[0]) : null;
  if (gone === null || gone > keys.length) throw new UnknownReplyError("a link-use deletion");
  return gone;
}

/**
 * Which of the store's sequence emails a person used a link in, for the copy
 * of their data (619 [SZ3], lib/person-copy.ts): the emails' ids, as they are
 * kept. Only reads.
 */
export async function clicksOf(listId: string | null, rawEmail: string): Promise<string[]> {
  if (!listId || !isRedisConfigured()) return [];
  const read = repliesFor(await redisPipeline([["SMEMBERS", usedKey(listId, normaliseEmail(rawEmail))]]), 1);
  const members = read ? stringList(read[0]) : null;
  if (!members || members.some((member) => !STEP_CAMPAIGN.test(member)) || new Set(members).size !== members.length) {
    throw new UnknownReplyError("a person's used links");
  }
  return members.slice().sort();
}
