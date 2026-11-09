/**
 * Marktmorgen's own do-not-contact list for its research outreach (owner's
 * decision 13, 9 November 2026). The privacy policy (Research outreach)
 * promises that a person who asks us to stop is never contacted again for
 * research, and that we keep only the contact detail they gave and, if they
 * gave it, their name. This is that list, and nothing more:
 *
 *   - one hash for the company, a field a contact detail in one normalized
 *     form ("email:" or "link:", lib/research-contact.ts), its value the name
 *     given or "";
 *   - one small count a day of the entries the public form added, which
 *     expires after two days.
 *
 * An entry is written by one script that reads the list's size, the day's
 * count and the entry together (ADD_DO_NOT_CONTACT), so the list never holds
 * more than RESEARCH_DO_NOT_CONTACT_MAX entries and a failed write takes no
 * place. The public form (app/api/privacy/do-not-contact, RESEARCH_STOP_PER_HOUR
 * a connection) stops at RESEARCH_DO_NOT_CONTACT_PUBLIC_MAX and at
 * RESEARCH_STOP_NEW_PER_DAY new entries a day; past either it answers the same
 * whether or not the contact is already listed. The room above the public
 * ceiling is the operator's (app/api/operator/do-not-contact), for whoever
 * emails support to object.
 *
 * No code sends a research message today. Whatever does, later, asks
 * mayContactForResearch first and sends nothing unless it says yes; it says
 * no for a contact it cannot read and for a list it cannot read
 * (tests/research-do-not-contact-truth.test.ts fails on a sender that does not).
 *
 * It is kept when the person asks to be deleted: it exists so we never
 * contact them again (lib/person-data.ts). It is never read for anything else.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { cleanResearchName, normalizeResearchContact } from "@/lib/research-contact";

export { CONTACT_FIELD_MAX_BYTES, CONTACT_MAX_LENGTH, NAME_MAX_LENGTH, cleanResearchName, normalizeResearchContact } from "@/lib/research-contact";

export const DO_NOT_CONTACT_KEY = "nl:research:dnc";
/** The day's count of entries the public form added, the UTC date (as 2026-11-09) after this prefix. */
export const DO_NOT_CONTACT_DAY_PREFIX = "nl:research:dnc:day:";
/** How long a day's count is kept: two days, so it outlives its day wherever the clock stands. */
export const DO_NOT_CONTACT_DAY_SECONDS = 2 * 86_400;

/** The most entries the list holds, whoever adds them. */
export const RESEARCH_DO_NOT_CONTACT_MAX = 10_000;
/** The most entries the public form fills the list to; the rest is the operator's, for requests sent by email. */
export const RESEARCH_DO_NOT_CONTACT_PUBLIC_MAX = 9_000;
/** New entries the public form may add in a day (UTC), for everyone together. */
export const RESEARCH_STOP_NEW_PER_DAY = 100;

/** Requests one connection may make to join the list in an hour (essentialLimitState, scope "research-stop"). */
export const RESEARCH_STOP_PER_HOUR = 5;

/**
 * KEYS[1] the list, KEYS[2] the day's count. ARGV: the contact, the name, the
 * ceiling, the day's ceiling (0 for none: the operator) and the day count's
 * lifetime. Answers -1 when the list is at its ceiling and -2 when the day's
 * new entries are, before it looks for the contact, so neither says who is
 * listed; 0 when the contact is already there (its first name stays); 1 when
 * written, counted in the day when there is a day's ceiling.
 * lib/redis-memory.ts models it, answer for answer with redis-server 7.0.15 run by hand on
 * 9 November 2026 (tests/research-do-not-contact-operator.test.ts).
 */
export const ADD_DO_NOT_CONTACT = `-- marktmorgen:research-dnc-add:v1
if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then return -1 end
local perDay = tonumber(ARGV[4])
if perDay > 0 and tonumber(redis.call('GET', KEYS[2]) or '0') >= perDay then return -2 end
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 0 then return 0 end
if perDay > 0 and redis.call('INCR', KEYS[2]) == 1 then redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5])) end
return 1`;

export type DoNotContactResult = "added" | "listed" | "full" | "busy";

/** How far an add may fill the list: the operator's (the default) or the public form's. */
export type DoNotContactCeiling = { most: number; perDay: number };
export const OPERATOR_CEILING: DoNotContactCeiling = { most: RESEARCH_DO_NOT_CONTACT_MAX, perDay: 0 };
export const PUBLIC_CEILING: DoNotContactCeiling = { most: RESEARCH_DO_NOT_CONTACT_PUBLIC_MAX, perDay: RESEARCH_STOP_NEW_PER_DAY };

const RESULTS: Record<string, DoNotContactResult> = { "1": "added", "0": "listed", "-1": "full", "-2": "busy" };

/**
 * Puts a contact detail on the list, with the name given (or none), in one
 * script: "added", "listed" when it is already there, "full" at the
 * ceiling's entries and "busy" at the day's, both said before the contact is
 * looked for. Throws when the contact detail does not read (check it with
 * normalizeResearchContact first) or when the reply is not one of those:
 * then nothing is said as done.
 */
export async function addToDoNotContact(
  input: { contact: string; name: string },
  ceiling: DoNotContactCeiling = OPERATOR_CEILING,
  now: Date = new Date(),
): Promise<DoNotContactResult> {
  const contact = normalizeResearchContact(input.contact);
  if (!contact) throw new Error("Not a contact detail the do-not-contact list keeps");
  if (!isRedisConfigured()) throw new Error("The do-not-contact list cannot be reached");
  const most = Math.min(ceiling.most, RESEARCH_DO_NOT_CONTACT_MAX);
  if (!Number.isSafeInteger(most) || most < 1 || !Number.isSafeInteger(ceiling.perDay) || ceiling.perDay < 0) throw new Error("Not a ceiling");
  const day = `${DO_NOT_CONTACT_DAY_PREFIX}${now.toISOString().slice(0, 10)}`;
  const replies = repliesFor(
    await redisPipeline([["EVAL", ADD_DO_NOT_CONTACT, 2, DO_NOT_CONTACT_KEY, day, contact, cleanResearchName(input.name), most, ceiling.perDay, DO_NOT_CONTACT_DAY_SECONDS]]),
    1,
  );
  const reply = replies?.[0];
  const result = typeof reply === "number" && Number.isInteger(reply) ? RESULTS[String(reply)] : undefined;
  if (!result) throw new UnknownReplyError("the do-not-contact entry");
  return result;
}

/** Whether a reply is exactly 0 or 1, as HEXISTS answers. */
function bit(reply: unknown): 0 | 1 {
  if (reply === 0 || reply === 1) return reply;
  throw new UnknownReplyError("the do-not-contact check");
}

/**
 * Whether Marktmorgen may contact this person for its research: yes only when
 * the contact detail reads and the list answers, in its exact shape, that it
 * is not on it. Every research message is checked here before it is sent.
 */
export async function mayContactForResearch(contact: string): Promise<boolean> {
  const normalized = normalizeResearchContact(contact);
  if (!normalized || !isRedisConfigured()) return false;
  try {
    const replies = repliesFor(await redisPipeline([["HEXISTS", DO_NOT_CONTACT_KEY, normalized]]), 1);
    if (!replies) return false;
    return bit(replies[0]) === 0;
  } catch {
    return false;
  }
}
