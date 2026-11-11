/**
 * The figures of 543 [CM2] (lib/community-approval.ts): how long a post or a
 * comment waits for the creator's approval, how many wait at most, and how
 * many first posts of a new member can be held. Plain numbers, nothing from
 * the server, so the store's words and the studio can say them.
 */

/** How long an item waits for an answer before it is refused by itself. */
export const HELD_DAYS = 30;
/** How long the author's note stays at most after that. */
export const TOLD_DAYS = 30;
/** How long an item's record is kept at most, from when it was sent: waiting, then the note, and a day's margin. */
export const KEEP_DAYS = HELD_DAYS + TOLD_DAYS + 1;
/** The most that wait in one community at once. */
export const MAX_HELD = 200;
/** The most one member has waiting, with the notes about the ones that were not published. */
export const MAX_MINE = 10;
/** The most "first posts of new members" can be. */
export const MAX_FIRST = 5;
/** The creator's sentence to the author of what they removed. */
export const MAX_WHY = 200;
