/**
 * Marktmorgen's own do-not-contact list for its research outreach (owner's
 * decision 13, 9 November 2026). The privacy policy (Research outreach)
 * promises that a person who asks us to stop is never contacted again for
 * research, and that we keep only the contact detail they gave and, if they
 * gave it, their name. This is that list, and nothing more:
 *
 *   - one hash for the company, a field a contact detail in one normalized
 *     form ("email:" or "link:"), its value the name given or "";
 *   - one count of the places taken, so the list never holds more than
 *     RESEARCH_DO_NOT_CONTACT_MAX entries (a fixed, bounded company cost:
 *     tests/plan-cost-registry.ts, NOT_A_COST).
 *
 * A person joins it from /privacy/do-not-contact, with no account (the route
 * app/api/privacy/do-not-contact, RESEARCH_STOP_PER_HOUR a connection), and
 * support adds whoever emails to object through the same page.
 *
 * No code sends a research message today. Whatever does, later, asks
 * mayContactForResearch first and sends nothing unless it says yes; it says
 * no for a contact it cannot read and for a list it cannot read.
 *
 * It is kept when the person asks to be deleted: it exists so we never
 * contact them again (lib/person-data.ts). It is never read for anything else.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";

export const DO_NOT_CONTACT_KEY = "nl:research:dnc";
export const DO_NOT_CONTACT_COUNT_KEY = "nl:research:dnc:n";

/** The most entries the list holds; past it the page says so and points to support. */
export const RESEARCH_DO_NOT_CONTACT_MAX = 10_000;

/** Requests one connection may make to join the list in an hour (essentialLimitState, scope "research-stop"). */
export const RESEARCH_STOP_PER_HOUR = 5;

/** The longest contact detail and name taken, as the creator research form takes them (lib/creator-research.ts, LIMITS). */
export const CONTACT_MAX_LENGTH = 300;
export const NAME_MAX_LENGTH = 80;

const EMAIL = /^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * A contact detail in the one form the list keeps and checks: an email
 * address in lower case, or a link to a site or profile as its host (without
 * "www.") and path, in lower case, without its query, fragment or trailing
 * slash. Anything else is null: it is neither kept nor contacted.
 */
export function normalizeResearchContact(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase();
  if (!text || text.length > CONTACT_MAX_LENGTH) return null;
  if (EMAIL.test(text)) return `email:${text}`;
  if (/\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.replace(/^www\./, "");
  if (!HOST.test(host)) return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `link:${host}${path}`;
}

/** The name as given, its spaces closed up and control characters taken out, at most NAME_MAX_LENGTH characters. */
function cleanName(raw: string): string {
  return String(raw ?? "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX_LENGTH);
}

/** One reply of a one-command pipeline, read from its own slot (lib/redis-reply.ts). */
async function one(command: (string | number)[], what: string): Promise<unknown> {
  const replies = repliesFor(await redisPipeline([command]), 1);
  if (!replies) throw new UnknownReplyError(what);
  return replies[0];
}

/** Whether a reply is exactly 0 or 1, as HEXISTS and HSETNX answer. */
function bit(reply: unknown, what: string): 0 | 1 {
  if (reply === 0 || reply === 1) return reply;
  throw new UnknownReplyError(what);
}

export type DoNotContactResult = "added" | "listed" | "full";

/**
 * Puts a contact detail on the list, with the name given (or none). "listed"
 * when it is already there (the first name given stays), "full" when the list
 * holds RESEARCH_DO_NOT_CONTACT_MAX entries. Throws when the contact detail
 * does not read (check it with normalizeResearchContact first) or when a
 * reply is not in its exact shape: then nothing is said as done.
 */
export async function addToDoNotContact(input: { contact: string; name: string }): Promise<DoNotContactResult> {
  const contact = normalizeResearchContact(input.contact);
  if (!contact) throw new Error("Not a contact detail the do-not-contact list keeps");
  if (!isRedisConfigured()) throw new Error("The do-not-contact list cannot be reached");
  if (bit(await one(["HEXISTS", DO_NOT_CONTACT_KEY, contact], "the do-not-contact check"), "the do-not-contact check") === 1) return "listed";
  // A place is taken before the entry is written, so the list can never hold more than its ceiling.
  const taken = countOf(await one(["INCR", DO_NOT_CONTACT_COUNT_KEY], "the do-not-contact count"));
  if (taken === null || taken < 1) throw new UnknownReplyError("the do-not-contact count");
  if (taken > RESEARCH_DO_NOT_CONTACT_MAX) {
    await one(["DECR", DO_NOT_CONTACT_COUNT_KEY], "the do-not-contact count");
    return "full";
  }
  const written = bit(await one(["HSETNX", DO_NOT_CONTACT_KEY, contact, cleanName(input.name)], "the do-not-contact entry"), "the do-not-contact entry");
  if (written === 1) return "added";
  // Written by another request in between: the place is given back.
  await one(["DECR", DO_NOT_CONTACT_COUNT_KEY], "the do-not-contact count");
  return "listed";
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
    return bit(await one(["HEXISTS", DO_NOT_CONTACT_KEY, normalized], "the do-not-contact check"), "the do-not-contact check") === 0;
  } catch {
    return false;
  }
}
