/**
 * Repairing a move that could be neither finished nor undone
 * (app/api/auth/move, lib/auth.ts markBrokenMove; security review of
 * 1daa9131e). Until it is repaired both addresses count as moving: nothing
 * is added to them, and a login without a second step is refused.
 *
 * The repair puts the ways in (passkeys, with what waits to be removed, and
 * two-step login) back with the address that holds the store, logs out the
 * other address and clears the record. It runs at the next login of either
 * address and before the next move. It leaves the record in place, for a
 * person to look at, when it cannot tell which address holds the store (both
 * or neither do), when a move of either is running, or when both addresses
 * hold ways in of the same kind: it never merges two addresses' ways in.
 */
import { clearBrokenMove, endAllSessions, moveRunning, readBrokenMove } from "@/lib/auth";
import { listPasskeys, movePasskeys, pendingNow } from "@/lib/passkeys";
import { moveTwoStep, twoStepOn } from "@/lib/two-step";
import { storeForEmail } from "@/lib/store";

/** True when this address holds no broken move any more (repaired now, or there was none). */
export async function repairMove(email: string): Promise<boolean> {
  const broken = await readBrokenMove(email);
  if (!broken) return true;
  const { from, to } = broken;
  try {
    if ((await moveRunning(from)) || (await moveRunning(to))) return false;
    const [atFrom, atTo] = await Promise.all([storeForEmail(from), storeForEmail(to)]);
    if (Boolean(atFrom) === Boolean(atTo)) return false;
    const home = atFrom ? from : to;
    const away = atFrom ? to : from;
    const holdsKeys = async (address: string) => (await listPasskeys(address)).length > 0 || (await pendingNow(address)) !== null;
    if (await holdsKeys(away)) {
      if (await holdsKeys(home)) return false;
      await movePasskeys(away, home);
    }
    if (await twoStepOn(away)) {
      if (await twoStepOn(home)) return false;
      await moveTwoStep(away, home);
    }
    await endAllSessions(away);
    await clearBrokenMove(from, to);
    return true;
  } catch (error) {
    console.error("repairing a broken move failed", error);
    return false;
  }
}
