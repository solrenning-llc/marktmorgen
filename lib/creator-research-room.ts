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
/** The kept length past which every answer kept tells the owner, in the log, how full the list is (80%). */
export const RESEARCH_WARN_AT = Math.floor(RESEARCH_MAX_ANSWERS * 0.8);

/** The day's cap with `length` answers kept: a share of the room still free, between one and the fixed day's cap. */
export function researchDayCap(length: number): number {
  return Math.max(1, Math.min(RESEARCH_ANSWERS_PER_DAY, Math.floor((RESEARCH_MAX_ANSWERS - length) / RESEARCH_DAY_SHARE)));
}
export const RESEARCH_MAX_BYTES = RESEARCH_ANSWER_MAX_BYTES * RESEARCH_MAX_ANSWERS;

/** An answer's size as stored, in UTF-8 bytes. */
export function answerBytes(row: string): number {
  return new TextEncoder().encode(row).length;
}

/**
 * The answer kept only while the list holds fewer than the ceiling and the
 * day's count is within the day's cap for the room still free
 * (researchDayCap), the count and the write in one step: 0 when full, "busy:<cap>" when
 * the day's share is taken, else the list's new length. KEYS[1] the list;
 * ARGV[1] the ceiling; ARGV[2] the answer as stored; ARGV[3] the day's count
 * with this answer; ARGV[4] RESEARCH_DAY_SHARE; ARGV[5] RESEARCH_ANSWERS_PER_DAY.
 */
export const KEEP_RESEARCH_ANSWER = `-- marktmorgen:research-answer-keep:v2
local length = redis.call("LLEN", KEYS[1])
local max = tonumber(ARGV[1])
if length >= max then return 0 end
local cap = math.max(1, math.min(tonumber(ARGV[5]), math.floor((max - length) / tonumber(ARGV[4]))))
if tonumber(ARGV[3]) > cap then return "busy:" .. cap end
return redis.call("LPUSH", KEYS[1], ARGV[2])`;
