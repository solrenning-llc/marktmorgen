/**
 * Only the calendar reading is synthetic (tests/calendar-add-limit.test.ts): each
 * "add" that reaches it stands for one read of a remote calendar address
 * (lib/calendar-sync.ts addFeed -> safeFetch -> parseIcs). Route, sign-in,
 * the studio's figures and the counters are real.
 */
export const state = { adds: 0, removals: 0, rotations: 0 };
export const MAX_FEED_URL = 1000;
const view = { feeds: [], token: null };
export async function addFeed() {
  state.adds += 1;
  return { ok: true, view, busyTimes: 0 };
}
export async function removeFeed() {
  state.removals += 1;
  return view;
}
export async function newFeedToken() {
  state.rotations += 1;
  return view;
}
