/**
 * How many moves of the sign-in address one account may finish, counted before a move does anything (Claude 7's
 * review of #3326, MEDIUM, cost). The end of every move sends company emails (app/api/auth/move tellMoved: the old
 * address every time, the new one when something did not come along) and does company Redis work (the recovery
 * address and team places carried or taken off). The asks are paced (app/api/store/address, five an hour per
 * address), but a pace per address is no ceiling: a chain of new addresses starts it again. So the finished moves
 * are counted by the store the account owns, which keeps its id whatever address it moves to.
 */
import { essentialLimitState, type LimitState } from "@/lib/request-guard";
import { ensureStoreId, storeForEmail } from "@/lib/store";

/** Moves of the sign-in address one account may finish in MOVE_WINDOW_SECONDS. */
export const MOVES_PER_30_DAYS = 10;
/** The window of MOVES_PER_30_DAYS, opened by the first move counted: any calendar month meets at most two. */
export const MOVE_WINDOW_SECONDS = 30 * 24 * 60 * 60;
/** Company emails the end of one move sends at the most (app/api/auth/move tellMoved). */
export const MOVE_END_EMAILS = 2;

/**
 * Takes one of the account's finished moves before the move at `from` starts. "within" lets it go on; "exceeded"
 * refuses it; "unknown" when the store, its id or the count could not be read, which moves nothing either (rule 24):
 * a count taken whose answer was lost is spent, never given back or retried. A store made before stores had ids is
 * given one first (lib/store.ts ensureStoreId), so the count never falls back to the address.
 */
export async function takeMove(from: string): Promise<LimitState> {
  let sid: string;
  try {
    const store = await storeForEmail(from);
    if (!store) return "unknown";
    sid = store.sid || ((await ensureStoreId(from))?.sid ?? "");
  } catch {
    return "unknown";
  }
  if (typeof sid !== "string" || !sid) return "unknown";
  return essentialLimitState("move-done", sid, MOVES_PER_30_DAYS, MOVE_WINDOW_SECONDS);
}
