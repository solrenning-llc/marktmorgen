/**
 * How often an open room asks whether anything is new: the rules.
 *
 * The room has no socket held open (lib/community-chat.ts): the page asks.
 * Until October 7, 2026 it asked every four seconds for as long as its tab
 * was in front, of a route that read the store, the member and the room
 * each time: a function call and about ten commands to the database for
 * every look. One member with the room open for a working day cost about
 * seventeen cents, a hundred of them more than five hundred dollars a
 * month, on any plan, and nothing was set against it.
 *
 * Three things replace that:
 *
 *   - The look is small and shared. What is asked every few seconds is
 *     "what came after message N", at an address that knows nobody and
 *     that the CDN may answer for everybody in the room at once
 *     (app/api/store/community/chat/new). It is opened by a pass the room's
 *     page is handed (lib/chat-pass.ts), and costs one read of the database
 *     when the CDN has no answer and none when it has.
 *   - The asking follows the room. Every LIVE_MS while people are talking
 *     and the reader is there; every IDLE_MS while the room is quiet; not at
 *     all while the tab is in the background or the page has not been
 *     touched for AWAY_AFTER_MS. Somebody who comes back is asked for at
 *     once.
 *   - It is counted. A member's page is given leave to ask for ten minutes
 *     at a time (lib/chat-grant.ts), at one pace or the other, and each
 *     leave is counted toward the store's visits as what it can cost at the
 *     most (lib/traffic-rules.ts). So the room is covered by the plan like
 *     a page is, charged past it like a page is, and rests with the store's
 *     pages where there is no plan to charge.
 *
 * Nothing here touches the network or reads another file but the room's
 * own limits (lib/community-chat-rules.ts): the page, the routes and the
 * tests read the same figures.
 */
import { MAX_CHAT_TEXT } from "./community-chat-rules";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** While somebody spoke this recently, the room is talking. */
export const TALKING_FOR_MS = 3 * MINUTE;
/** A reader who has not touched the page for this long has walked away from it. */
export const AWAY_AFTER_MS = 20 * MINUTE;

/** How often a talking room is asked about, and a quiet one. */
export const LIVE_MS = 5 * SECOND;
export const IDLE_MS = 30 * SECOND;

/** How long one leave to ask lasts, in minutes: what one count of the room covers, for one member. */
export const ROOM_GRANT_MINUTES = 10;
export const GRANT_MS = ROOM_GRANT_MINUTES * MINUTE;

/** The most looks one leave allows, at each pace. */
export const LIVE_LOOKS = GRANT_MS / LIVE_MS;
export const IDLE_LOOKS = GRANT_MS / IDLE_MS;

/**
 * The bytes of messages one look gathers, with the answer around them. A
 * page that is far behind is brought up to date over the next looks, a
 * little at a time, instead of being sent a whole page of the room at
 * every look (R20 finding 1). The first message is always sent, even when
 * it alone is larger, so a page never sticks: a look sends at most
 * LOOK_BYTES, or one whole message when that message alone is larger, and
 * so at most LOOK_MOST_BYTES.
 */
export const LOOK_BYTES = 2_000;

/** The name a message keeps, in UTF-16 units: the cut say() and parse() make (lib/community-chat.ts). */
export const LOOK_NAME_UNITS = 80;
/** A message's author as kept: a member's key (lib/learn.ts, emailKey) or the shorter CREATOR. */
export const LOOK_KEY_UNITS = 32;

/**
 * The most bytes one message can be sent as in a look, with the answer
 * around it: a text of MAX_CHAT_TEXT units, a name of LOOK_NAME_UNITS and a
 * key of LOOK_KEY_UNITS, every unit at 3 bytes, and the message's number,
 * its time and the cursor at their most digits. Three bytes is the most a
 * unit is sent as once the look has made every lone half of a surrogate
 * pair U+FFFD (wholeUnits, lib/community-chat-rules.ts): a letter of the
 * BMP is at most 3 bytes, a whole pair 4 for its two units, and an escaped
 * quotation mark, backslash, tab or line break 2. About 3.5 kB: a
 * 1,000-letter message in Chinese or Japanese under a long name comes
 * close to it with no abuse at all.
 */
export const LOOK_ONE_MESSAGE_BYTES = (() => {
  const most = Number.MAX_SAFE_INTEGER;
  const units = MAX_CHAT_TEXT + LOOK_NAME_UNITS + LOOK_KEY_UNITS;
  const ascii = JSON.stringify({
    ok: true,
    messages: [{ i: most, a: "k".repeat(LOOK_KEY_UNITS), text: "t".repeat(MAX_CHAT_TEXT), at: most, n: "n".repeat(LOOK_NAME_UNITS) }],
    cursor: most,
  });
  return ascii.length + 2 * units;
})();

/**
 * The most bytes one look sends, and so what a look is priced at
 * (tests/traffic-cost.ts, roomLookCost, once it reads this figure instead
 * of the 2,000 it types; tests/room-look-bounds.test.ts holds ten minutes
 * at this size within ROOM_LIVE_PARTS meanwhile).
 */
export const LOOK_MOST_BYTES = Math.max(LOOK_BYTES, LOOK_ONE_MESSAGE_BYTES);

export type Pace = "live" | "idle" | "stopped";

/**
 * How this reader's page should be asking.
 *
 * `quietMs`: since anything was last said in the room, as far as the page
 * knows. `awayMs`: since this reader last touched the page.
 */
export function paceFor(quietMs: number, awayMs: number): Pace {
  if (!(awayMs < AWAY_AFTER_MS)) return "stopped";
  return quietMs < TALKING_FOR_MS ? "live" : "idle";
}

/** Whether a room whose last message was this long ago is talking. */
export function isTalking(quietMs: number): boolean {
  return quietMs >= 0 && quietMs < TALKING_FOR_MS;
}

/** How long until the next look, at a pace. A stopped page looks at nothing; it checks itself this often. */
export function askEvery(pace: Pace): number {
  return pace === "live" ? LIVE_MS : IDLE_MS;
}

/**
 * How long the CDN may give everybody the same answer, in seconds: a little
 * under how often the readers who share it ask, so that one reader's
 * question answers the next one's.
 */
export function shareFor(pace: "live" | "idle"): number {
  return pace === "live" ? 3 : 10;
}
