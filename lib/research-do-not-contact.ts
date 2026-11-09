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
 *   - one small count a day of the requests the public form took, which
 *     expires after two days, and one count of every request it ever took.
 *
 * An entry is written by one script (ADD_DO_NOT_CONTACT), so a failed write
 * takes no place. The public form (app/api/privacy/do-not-contact,
 * RESEARCH_STOP_PER_HOUR a connection) is measured by its own counts, of
 * requests taken, new or already listed alike: at most
 * RESEARCH_DO_NOT_CONTACT_PUBLIC_MAX ever and RESEARCH_STOP_NEW_PER_DAY a
 * day. It never reads the list's size, so neither its answer nor the next one
 * says who is listed. The operator (app/api/operator/do-not-contact), for
 * whoever emails support to object, adds only while the list's size, plus
 * what the public form may still add, stays within RESEARCH_DO_NOT_CONTACT_MAX:
 * so the list never holds more than that, whoever adds.
 *
 * Research messages go out only through sendResearchMessage
 * (lib/research-outreach.ts), which asks doNotContactState first and sends
 * nothing unless the contact is clear; tests/research-do-not-contact-sending.test.ts
 * holds every other file that sends email as one that does not send research.
 * The operator looks a contact up before writing by hand on the same page
 * (app/api/operator/do-not-contact/check).
 *
 * It is kept when the person asks to be deleted: it exists so we never
 * contact them again (lib/person-data.ts). It is never read for anything else.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { cleanResearchName, normalizeResearchContact } from "@/lib/research-contact";

export { CONTACT_FIELD_MAX_BYTES, CONTACT_MAX_LENGTH, NAME_MAX_LENGTH, cleanResearchName, normalizeResearchContact } from "@/lib/research-contact";

export const DO_NOT_CONTACT_KEY = "nl:research:dnc";
/** The day's count of requests the public form took, the UTC date (as 2026-11-09) after this prefix. */
export const DO_NOT_CONTACT_DAY_PREFIX = "nl:research:dnc:day:";
/** The count of every request the public form ever took, new or already listed. */
export const DO_NOT_CONTACT_PUBLIC_KEY = "nl:research:dnc:public";
/** How long a day's count is kept: two days, so it outlives its day wherever the clock stands. */
export const DO_NOT_CONTACT_DAY_SECONDS = 2 * 86_400;

/** The most entries the list holds, whoever adds them. */
export const RESEARCH_DO_NOT_CONTACT_MAX = 10_000;
/** The most requests the public form ever takes (so the most entries it adds); the rest of the list is the operator's, for requests sent by email. */
export const RESEARCH_DO_NOT_CONTACT_PUBLIC_MAX = 9_000;
/** Requests the public form may take in a day (UTC), new or already listed, for everyone together. */
export const RESEARCH_STOP_NEW_PER_DAY = 100;

/** Requests one connection may make to join the list in an hour (essentialLimitState, scope "research-stop"). */
export const RESEARCH_STOP_PER_HOUR = 5;

/**
 * KEYS[1] the list, KEYS[2] the public form's day, KEYS[3] its count ever.
 * ARGV: the contact, the name, "public" or "operator", the list's ceiling,
 * the public form's ceiling, its day's ceiling and the day count's lifetime.
 *
 * Public: -1 at its ceiling, -2 at the day's, both from its own counts and
 * before the contact is looked for; otherwise both counts rise, whatever
 * follows, and the answer is HSETNX's (1 written, 0 already listed, its
 * first name kept), which the route says the same way.
 * Operator: 0 when listed; -1 when one more entry, with what the public form
 * may still add, would pass the list's ceiling; 1 when written.
 * lib/redis-memory.ts models it, answer for answer with redis-server 7.0.15 run by hand on
 * 9 November 2026 (tests/research-do-not-contact-operator.test.ts).
 */
export const ADD_DO_NOT_CONTACT = `-- marktmorgen:research-dnc-add:v2
local taken = tonumber(redis.call('GET', KEYS[3]) or '0')
if ARGV[3] == 'public' then
  if taken >= tonumber(ARGV[5]) then return -1 end
  if tonumber(redis.call('GET', KEYS[2]) or '0') >= tonumber(ARGV[6]) then return -2 end
  redis.call('INCR', KEYS[3])
  if redis.call('INCR', KEYS[2]) == 1 then redis.call('EXPIRE', KEYS[2], tonumber(ARGV[7])) end
  return redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2])
end
if ARGV[3] ~= 'operator' then return redis.error_reply('ERR unknown mode') end
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 0 end
local left = tonumber(ARGV[5]) - taken
if left < 0 then left = 0 end
if redis.call('HLEN', KEYS[1]) + 1 + left > tonumber(ARGV[4]) then return -1 end
return redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2])`;

export type DoNotContactResult = "added" | "listed" | "full" | "busy";
/** Who adds: the public form, inside its own counts, or the operator, above them. */
export type DoNotContactBy = "public" | "operator";

const RESULTS: Record<string, DoNotContactResult> = { "1": "added", "0": "listed", "-1": "full", "-2": "busy" };

/**
 * Puts a contact detail on the list, with the name given (or none), in one
 * script: "added", "listed" when it is already there, "full" at a ceiling and
 * "busy" at the public form's day (for the public form, both said before the
 * contact is looked for). Throws when the contact detail does not read (check
 * it with normalizeResearchContact first) or when the reply is not one of
 * those: then nothing is said as done.
 */
export async function addToDoNotContact(
  input: { contact: string; name: string },
  by: DoNotContactBy = "operator",
  now: Date = new Date(),
): Promise<DoNotContactResult> {
  const contact = normalizeResearchContact(input.contact);
  if (!contact) throw new Error("Not a contact detail the do-not-contact list keeps");
  if (!isRedisConfigured()) throw new Error("The do-not-contact list cannot be reached");
  if (by !== "public" && by !== "operator") throw new Error("Not who adds");
  const day = `${DO_NOT_CONTACT_DAY_PREFIX}${now.toISOString().slice(0, 10)}`;
  const replies = repliesFor(
    await redisPipeline([[
      "EVAL", ADD_DO_NOT_CONTACT, 3, DO_NOT_CONTACT_KEY, day, DO_NOT_CONTACT_PUBLIC_KEY, contact, cleanResearchName(input.name), by,
      RESEARCH_DO_NOT_CONTACT_MAX, RESEARCH_DO_NOT_CONTACT_PUBLIC_MAX, RESEARCH_STOP_NEW_PER_DAY, DO_NOT_CONTACT_DAY_SECONDS,
    ]]),
    1,
  );
  const reply = replies?.[0];
  const result = typeof reply === "number" && Number.isInteger(reply) ? RESULTS[String(reply)] : undefined;
  if (!result || (by === "operator" && result === "busy")) throw new UnknownReplyError("the do-not-contact entry");
  return result;
}

/** Where a contact stands: on the list, clear of it, unknown (a list or a reply it cannot read), or not a contact it reads. */
export type DoNotContactState = "listed" | "clear" | "unknown" | "contact";

export async function doNotContactState(contact: string): Promise<DoNotContactState> {
  const normalized = normalizeResearchContact(contact);
  if (!normalized) return "contact";
  if (!isRedisConfigured()) return "unknown";
  try {
    const replies = repliesFor(await redisPipeline([["HEXISTS", DO_NOT_CONTACT_KEY, normalized]]), 1);
    const reply = replies?.[0];
    return reply === 1 ? "listed" : reply === 0 ? "clear" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Whether Marktmorgen may contact this person for its research: yes only when
 * the contact detail reads and the list answers, in its exact shape, that it
 * is not on it. sendResearchMessage (lib/research-outreach.ts) asks the same.
 */
export async function mayContactForResearch(contact: string): Promise<boolean> {
  return (await doNotContactState(contact)) === "clear";
}
