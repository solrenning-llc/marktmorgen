/**
 * The invite rules with the program open, for tests/invite-accept-post.test.ts only (its alias file): the program is
 * paused in the code (INVITE_PROGRAM_OPEN false, lib/creator-invite-rules.ts), so the path that keeps an accepted
 * invite on the browser can only be exercised with it opened here. The flag itself is never changed.
 */
export * from "../lib/creator-invite-rules";
export const INVITE_PROGRAM_OPEN = true;
