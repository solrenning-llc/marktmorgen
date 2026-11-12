/**
 * Only the calendar reading is synthetic (tests/calendar-add-limit.test.ts): each
 * "add" that reaches it stands for one read of a remote calendar address
 * (lib/calendar-sync.ts addFeed -> safeFetch -> parseIcs). Route, sign-in,
 * the studio's figures and the counters are real. `busy` stands for a removal
 * or a new address that lost every try to another change (issue #3984).
 */
export const state = { adds: 0, removals: 0, rotations: 0, busy: false };
export const MAX_FEED_URL = 1000;
export const BUSY_SENTENCE = "Your calendars were being changed somewhere else at the same moment, so nothing was changed. Try again.";
export class CalendarChangeBusyError extends Error {
  constructor() {
    super(BUSY_SENTENCE);
  }
}
const view = { feeds: [], token: null };
export async function addFeed() {
  state.adds += 1;
  return { ok: true, view, busyTimes: 0 };
}
export async function removeFeed() {
  if (state.busy) throw new CalendarChangeBusyError();
  state.removals += 1;
  return view;
}
export async function newFeedToken() {
  if (state.busy) throw new CalendarChangeBusyError();
  state.rotations += 1;
  return view;
}
