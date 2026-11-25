import { createHmac } from "node:crypto";
import { deriveKey, deriveLegacyKey } from "@/lib/secret-box";
/**
 * How much the creator research list may hold (nl:creators:responses).
 *
 * The form takes answers from anyone, signed in or not, so what it keeps
 * needs a ceiling checked before each write (MR: a ceiling before every
 * spend; unknown cost is never zero). Two numbers bound it:
 *
 *   - RESEARCH_ANSWER_MAX_BYTES: one answer as stored, in UTF-8 bytes, as
 *     Redis counts them. Every real answer fits: each field at its limit
 *     (lib/creator-research.ts LIMITS, 3,840 characters in all) at three
 *     bytes a character, with its id, date and consent, stays under it. Only
 *     characters JSON has to escape six bytes at a time (control characters)
 *     can pass it, and such an answer is refused as too long.
 *   - RESEARCH_MAX_ANSWERS: answers the list holds at once (the daily job
 *     lets those older than 24 months go, lib/creator-research-store.ts).
 *     Counted and written in one step (KEEP_RESEARCH_ANSWER), so answers sent
 *     at once, a lost reply or a failed step can never leave it past the
 *     ceiling: nothing is written and then taken back.
 *
 * Together, RESEARCH_MAX_BYTES, kept under one backup part less its 1 KiB of
 * room (lib/backup-parts.ts refuses a key past it and the whole run stops),
 * so the list can never stop the backup. tests/creator-research-room.test.ts
 * holds both.
 */
export const RESEARCH_ANSWER_MAX_BYTES = 12_288;
/**
 * New answers the list takes in one UTC day, from everyone together, well under RESEARCH_MAX_ANSWERS: whoever
 * rotates connections can spend at most one day's share, never fill the list that stays closed for up to 24 months
 * (Claude 7 on #3584). Real creators answer a handful a day.
 */
export const RESEARCH_ANSWERS_PER_DAY = 40;
export const RESEARCH_MAX_ANSWERS = 320;
/**
 * A day takes at most one RESEARCH_DAY_SHARE-th of the room still free (never more than RESEARCH_ANSWERS_PER_DAY,
 * never less than one), counted in the same step as the write (KEEP_RESEARCH_ANSWER), so days of rotating connections
 * fill the list ever more slowly (Claude 3's LOW 1 on #3584): answering every day's cap in full takes it to 80% on
 * the 28th day and full on the 73rd, instead of full on the 8th, and the owner is told at RESEARCH_WARN_AT. An empty
 * list's day takes 18 (each answer counted against the room then free); RESEARCH_ANSWERS_PER_DAY stays the fixed
 * ceiling, checked before the write.
 */
export const RESEARCH_DAY_SHARE = 16;
/**
 * Places of the list kept for answers from signed-in Marktmorgen accounts, one an account (the row's reservedFor,
 * researchAccountMark): a flood from rotating connections never reaches them, so a creator with an account can always
 * answer (Claude 3's LOW 1 on #3584). Anonymous answers share the other RESEARCH_MAX_ANSWERS - RESEARCH_RESERVED under
 * the day's share. A place frees itself when its answer goes (the 24-month pruning, an erasure), as the count is the
 * rows themselves. A prospect with no account can still be crowded out by a flood; an email confirmation before keeping
 * (a named follow-up) is what would reach them.
 */
export const RESEARCH_RESERVED = 64;
/** The label of the key a reserved answer's account mark is made with (researchAccountMark). */
const MARK_LABEL = "creator-research-reserve/v1";
/** The kept length past which every answer kept tells the owner, in the log, how full the list is (80%). */
export const RESEARCH_WARN_AT = Math.floor(RESEARCH_MAX_ANSWERS * 0.8);

/** The day's cap with `anonymous` anonymous answers kept: a share of their room still free, between one and the fixed day's cap. */
export function researchDayCap(anonymous: number): number {
  return Math.max(1, Math.min(RESEARCH_ANSWERS_PER_DAY, Math.floor((RESEARCH_MAX_ANSWERS - RESEARCH_RESERVED - anonymous) / RESEARCH_DAY_SHARE)));
}

/** The one-way mark of a signed-in account in its answer (reservedFor): 32 hex characters, never the address. */
export async function researchAccountMark(email: string, legacy = false): Promise<string> {
  // Keyed with this deployment's secret (lib/secret-box.ts), so a mark cannot be found from an address alone
  // (Claude 2's MEDIUM on #3584). With no secret there is no mark: the account answers as anonymous, never unmarked
  // in a reserved place. The person's copy and erasure also look for the mark made under the earlier root (legacy).
  const key = legacy ? deriveLegacyKey(MARK_LABEL) : deriveKey(MARK_LABEL);
  if (!key) return "";
  return createHmac("sha256", key).update(email.trim().toLowerCase()).digest("hex").slice(0, 32);
}
export const RESEARCH_MAX_BYTES = RESEARCH_ANSWER_MAX_BYTES * RESEARCH_MAX_ANSWERS;

/** An answer's size as stored, in UTF-8 bytes. */
export function answerBytes(row: string): number {
  return new TextEncoder().encode(row).length;
}

/**
 * The answer kept, the count and the write in one step: -1 while the
 * person's deletion is under way (KEYS[2], the typed address's mark, or
 * KEYS[3], the signed-in account's, the same as KEYS[2] when anonymous:
 * lib/creator-research-store.ts forgetMarkKey; Codex L-20261120-0837), 0 when full,
 * "busy:<cap>" when the day's share is taken, "already" when the account's
 * reserved place is taken, else the list's new length. The rows are read once
 * (LRANGE, at most RESEARCH_MAX_ANSWERS) to count the reserved ones, marked
 * `"reservedFor":"<mark>"`. A signed-in answer takes a reserved place while
 * fewer than the reserve are taken and none is its account's; past the
 * reserve it goes in as anonymous (ARGV[7], the row without the mark).
 * Anonymous answers keep their room (the ceiling less the reserve) and the
 * day's share of it (researchDayCap). KEYS[1] the list; KEYS[2] and KEYS[3] the
 * deletion marks; ARGV[1] the ceiling;
 * ARGV[2] the answer as stored (with the mark when signed in); ARGV[3] the
 * day's count with this answer; ARGV[4] RESEARCH_DAY_SHARE; ARGV[5]
 * RESEARCH_ANSWERS_PER_DAY; ARGV[6] RESEARCH_RESERVED; ARGV[7] the account's
 * mark, or "" when anonymous; ARGV[8] the answer without the mark.
 */
export const KEEP_RESEARCH_ANSWER = `-- marktmorgen:research-answer-keep:v4
if redis.call("EXISTS", KEYS[2], KEYS[3]) > 0 then return -1 end
local length = redis.call("LLEN", KEYS[1])
local max = tonumber(ARGV[1])
if length >= max then return 0 end
local reserve = tonumber(ARGV[6])
local account = ARGV[7]
local reserved = 0
local rows = redis.call("LRANGE", KEYS[1], 0, -1)
for _, row in ipairs(rows) do
  if string.find(row, '"reservedFor":"', 1, true) then
    reserved = reserved + 1
    if account ~= "" and string.find(row, '"reservedFor":"' .. account .. '"', 1, true) then return "already" end
  end
end
if account ~= "" and reserved < reserve then return redis.call("LPUSH", KEYS[1], ARGV[2]) end
local room = max - reserve
local anonymous = length - reserved
if anonymous >= room then return 0 end
local cap = math.max(1, math.min(tonumber(ARGV[5]), math.floor((room - anonymous) / tonumber(ARGV[4]))))
if tonumber(ARGV[3]) > cap then return "busy:" .. cap end
return redis.call("LPUSH", KEYS[1], ARGV[8])`;
