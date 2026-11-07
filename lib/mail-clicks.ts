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
import { type Contact, UNSUB_TOKEN, leadsKey, mailable, parseContact, readUnsubToken } from "@/lib/contacts";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";

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

/** The key a reader's links carry, from their unsubscribe token; it cannot be turned back into it. */
export function linkKeyOf(token: string): string {
  return createHash("sha256").update(`nimbus-mk:${token}`).digest("hex").slice(0, 24);
}

/** Makes these readers' keys lead back to them, for the emails about to go. */
export async function rememberLinkKeys(tokens: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const token of tokens) if (UNSUB_TOKEN.test(token)) out.set(token, linkKeyOf(token));
  if (out.size && isRedisConfigured()) await redisPipeline([...out].map(([token, key]) => ["SET", keyIndex(key), token, "EX", KEY_SECONDS]));
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
  await redisPipeline([
    ["SADD", used, campaign],
    ["EXPIRE", used, CLICK_DAYS * 86_400],
  ]);
  return true;
}

/** Which of these people used a link in the email `campaign`. */
export async function usedLinkIn(listId: string, campaign: string, emails: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!emails.length || !isRedisConfigured()) return out;
  const answers = await redisPipeline(emails.map((email) => ["SISMEMBER", usedKey(listId, email), campaign]));
  emails.forEach((email, i) => {
    if (Number(answers[i]) === 1) out.add(email);
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
  const commands: (string | number)[][] = [
    ["DEL", usedKey(listId, email)],
    ["DEL", keyIndex(linkKeyOf(token))],
  ];
  if (contact.clicks) {
    const { clicks: _was, ...kept } = contact;
    void _was;
    commands.push(["HSET", leadsKey(listId), email, JSON.stringify(kept satisfies Contact)]);
  }
  await redisPipeline(commands);
  return true;
}

/** How many times the erasure reads a row that keeps changing before it gives up. */
const FORGET_TRIES = 3;

/**
 * Deletes the keys (KEYS[2..]) only while the person's list row (KEYS[1],
 * field ARGV[1]) is still what was read: absent when ARGV[2] is "0", exactly
 * ARGV[3] when "1". Answers how many keys went, or -1 when the row changed.
 */
export const FORGET_CLICKS_IF_SAME = `-- marktmorgen:mail-clicks-forget:v1
local raw = redis.call("HGET", KEYS[1], ARGV[1])
if ARGV[2] == "0" then
  if raw then return -1 end
elseif raw ~= ARGV[3] then
  return -1
end
return redis.call("DEL", unpack(KEYS, 2))`;

/**
 * Deletes what is counted of one person's link use on this list, and the key
 * their links carried (lib/person-erasure.ts). Run before the list forgets
 * them, while the token their key was made from can still be read.
 */
export async function forgetClicksPerson(listId: string | null, rawEmail: string): Promise<number> {
  if (!listId || !isRedisConfigured()) return 0;
  const email = normaliseEmail(rawEmail);
  // Every token read on the way is theirs, so a key made from one that was
  // replaced while this ran is erased too.
  const linkKeys = new Set<string>();
  for (let attempt = 0; attempt < FORGET_TRIES; attempt += 1) {
    const [raw] = await redisPipeline([["HGET", leadsKey(listId), email]]);
    // The row is compared where the keys are deleted, so it has to be read as it is.
    if (raw !== null && typeof raw !== "string") throw new UnknownReplyError("a contact's row");
    const token = parseContact(raw)?.t ?? "";
    if (UNSUB_TOKEN.test(token)) linkKeys.add(keyIndex(linkKeyOf(token)));
    const keys = [usedKey(listId, email), ...linkKeys];
    const command = ["EVAL", FORGET_CLICKS_IF_SAME, keys.length + 1, leadsKey(listId), ...keys, email, raw === null ? "0" : "1", raw ?? ""];
    const reply = repliesFor(await redisPipeline([command]), 1)?.[0];
    // The row changed after it was read: read it again.
    if (reply === -1) continue;
    const gone = countOf(reply);
    if (gone === null || gone > keys.length) throw new UnknownReplyError("the deletion of a person's link use");
    return gone;
  }
  throw new Error(`a contact's row changed ${FORGET_TRIES} times while their link use was erased`);
}

/**
 * Which of the store's sequence emails a person used a link in, for the copy
 * of their data (619 [SZ3], lib/person-copy.ts): the emails' ids, as they are
 * kept. Only reads.
 */
export async function clicksOf(listId: string | null, rawEmail: string): Promise<string[]> {
  if (!listId || !isRedisConfigured()) return [];
  const [members] = await redisPipeline([["SMEMBERS", usedKey(listId, normaliseEmail(rawEmail))]]);
  return (Array.isArray(members) ? members : []).map(String).sort();
}
