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
 * person's token, still good, is given again on their next press of the same lesson with no new hold.
 */
export const PLAY_TICKET_SECONDS = 2 * 60;
/** A token given again only while it has at least this long left. */
export const PLAY_REUSE_MIN_SECONDS = 2 * 60;
