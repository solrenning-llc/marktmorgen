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
export const RESEARCH_MAX_ANSWERS = 320;
export const RESEARCH_MAX_BYTES = RESEARCH_ANSWER_MAX_BYTES * RESEARCH_MAX_ANSWERS;

/** An answer's size as stored, in UTF-8 bytes. */
export function answerBytes(row: string): number {
  return new TextEncoder().encode(row).length;
}

/**
 * The answer kept only while the list holds fewer than the ceiling, the count
 * and the write in one step: 0 when full, else the list's new length.
 * KEYS[1] the list; ARGV[1] the ceiling; ARGV[2] the answer as stored.
 */
export const KEEP_RESEARCH_ANSWER = `-- marktmorgen:research-answer-keep:v1
if redis.call("LLEN", KEYS[1]) >= tonumber(ARGV[1]) then return 0 end
return redis.call("LPUSH", KEYS[1], ARGV[2])`;
