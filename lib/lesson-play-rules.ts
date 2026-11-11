/**
 * The paces of a press of Play on a lesson video (app/api/store/course/play/route.ts; pre-review of the video hours
 * ceiling, 9 November 2026). Each only refuses: what a press costs is PLAY_REQUEST_UNITS of the store's public
 * requests, taken before its hold (tests/plan-cost-registry.ts), and what it holds is the plan's own hours
 * (lib/watch.ts, holdPlayback). Counted in fixed windows of PLAY_WINDOW_SECONDS from a counter's first press, so a
 * refusal is over within that hour.
 */
export const PLAY_WINDOW_SECONDS = 60 * 60;
/** Presses one connection may make in a window, every store and lesson together. */
export const PLAYS_PER_CONNECTION_WINDOW = 60;
/** Presses one signed-in person (a student or the store's own) may make in a window, in one store. */
export const PLAYS_PER_LEARNER_WINDOW = 20;
/** Presses of a free preview by people who are neither, in one store and window, all connections together. */
export const PREVIEW_PLAYS_PER_STORE_WINDOW = 30;
/**
 * The store's public requests one press is counted as: its reads of the store, the listing, the course, the access
 * and the gate, its three paces, the video's record, the hold and its give-back, and a ticket kept and taken, priced
 * at most at this many later pages (tests/plan-cost-registry.test.ts holds it).
 */
export const PLAY_REQUEST_UNITS = 2;
/**
 * How long the ticket a press leaves for the page it sends the browser back to lasts, and is taken once; a signed-in
 * person's token, still good, is given again on their next press of the same lesson with no new hold, and their press
 * of another lesson in the store gets a token for it ending with that one, with no new hold either.
 */
export const PLAY_TICKET_SECONDS = 2 * 60;
/** A token given again only while it has at least this long left. */
export const PLAY_REUSE_MIN_SECONDS = 2 * 60;
/**
 * One live hold a person a store (review of #3402, security M1: a student pressing different lessons held a block
 * each, and so the store's whole video time, without watching). A signed-in person's press with no live token first
 * claims their place for at most PLAY_CLAIM_SECONDS (SET NX), so presses at once cannot each hold a block; a press
 * that finds the place claimed waits for the other's token PLAY_CLAIM_POLL_MS at a time, at most PLAY_CLAIM_WAIT_MS
 * (PLAY_CLAIM_READS reads), and is given it, or says the video could not be loaded.
 */
export const PLAY_CLAIM_SECONDS = 60;
export const PLAY_CLAIM_POLL_MS = 250;
export const PLAY_CLAIM_WAIT_MS = 750;
export const PLAY_CLAIM_READS = PLAY_CLAIM_WAIT_MS / PLAY_CLAIM_POLL_MS;
/**
 * The most a press of Play holds and signs for, its token's life (the owner's decision 16, relayed by Claude 1 on
 * 9 November 2026: on the Store's video hours, a shorter time for each lesson opened, the worst month's cost and the
 * visible 4 hours unchanged). Before, a press asked for the lesson's whole length and LESSON_PAUSE_SECONDS, up to
 * four hours: one press of a 3 h 45 min lesson held the Store's whole month, and its unused part came back only an
 * interval and a reading after the token ran out. Half an hour, because:
 *
 *   - a lesson of up to 15 minutes, with its 15 minutes of pauses (lib/learn.ts, lessonTokenSeconds), still plays
 *     whole on one press: a shorter block would cut short lessons too;
 *   - it is six units of HOLD_UNIT_SECONDS: the Store's 4 hours (48 units) let eight students play at once, where one
 *     long lesson took them all, and an unused block keeps at most half an hour from the others until it is read back;
 *   - a student watching without a stop presses about twice an hour, far inside PLAYS_PER_LEARNER_WINDOW.
 *
 * The cost does not move: what is held is still the plan's own hours, and every press takes PLAY_REQUEST_UNITS of
 * the store's public requests before its hold (tests/plan-cost-registry.ts).
 */
export const PLAY_BLOCK_SECONDS = 30 * 60;
