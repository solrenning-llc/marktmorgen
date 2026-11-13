/**
 * Repairing a move that could be neither finished nor undone
 * (app/api/auth/move, lib/auth.ts markBrokenMove; security review of
 * 1daa9131e). Until it is repaired both addresses count as moving: nothing
 * is added to them, and a login without a second step is refused.
 *
 * The repair puts the ways in (passkeys, with what waits to be removed, and
 * two-step login) back with the address that holds the store, logs out the
 * other address and clears the record. It runs at the next login of either
 * address and before the next move. A store left on both addresses is
 * settled by where its handle points (lib/store.ts settleDoubledStore). It
 * leaves the record in place, for a person to look at with
 * scripts/move-repair.mjs, when it cannot tell which address holds the store,
 * when a move of either is running, or when both addresses hold ways in of
 * the same kind: it never merges two addresses' ways in.
 */
import { clearBrokenMove, endAllSessions, moveRunning, readBrokenMove } from "@/lib/auth";
import { listPasskeys, movePasskeys, pendingNow, repointPasskeys } from "@/lib/passkeys";
import { moveTwoStep, twoStepOn } from "@/lib/two-step";
import { settleDoubledStore, storeForEmail } from "@/lib/store";

/** True when this address holds no broken move any more (repaired now, or there was none). */
export async function repairMove(email: string): Promise<boolean> {
  const broken = await readBrokenMove(email);
  if (!broken) return true;
  const { from, to } = broken;
  try {
    if ((await moveRunning(from)) || (await moveRunning(to))) return false;
    const [atFrom, atTo] = await Promise.all([storeForEmail(from), storeForEmail(to)]);
    if (!atFrom && !atTo) return false;
    const home = atFrom && atTo ? await settleDoubledStore(from, to) : atFrom ? from : to;
    if (!home) return false;
    const away = home === from ? to : from;
    const holdsKeys = async (address: string) => (await listPasskeys(address)).length > 0 || (await pendingNow(address)) !== null;
    if (await holdsKeys(away)) {
      if (await holdsKeys(home)) return false;
      await movePasskeys(away, home);
    }
    if (await twoStepOn(away)) {
      if (await twoStepOn(home)) return false;
      await moveTwoStep(away, home);
    }
    // An index a lost answer left on the other address is pointed back at the list's (C3-117).
    await repointPasskeys(home);
    // The record is the lock on both addresses: it is cleared only once the away address's
    // sessions are known to be logged out. An unknown logout (null) keeps it for a later try (rule 30).
    if ((await endAllSessions(away)) === null) return false;
    await clearBrokenMove(from, to);
    return true;
  } catch (error) {
    console.error("repairing a broken move failed", error);
    return false;
  }
}

/** What a person looking at a broken move needs to see (scripts/move-repair.mjs). */
export async function describeMove(email: string): Promise<Record<string, unknown>> {
  const broken = await readBrokenMove(email);
  const addresses = broken ? [broken.from, broken.to] : [email];
  const each = await Promise.all(
    addresses.map(async (address) => ({
      address,
      store: Boolean(await storeForEmail(address)),
      passkeys: (await listPasskeys(address)).length,
      removalWaiting: (await pendingNow(address)) !== null,
      app: await twoStepOn(address),
      moveRunning: await moveRunning(address),
    })),
  );
  return { broken, addresses: each };
}

/**
 * Clears a broken move's record without repairing it, for a person who has
 * looked (scripts/move-repair.mjs, with the address typed again). Refused
 * while the state is split, the store on one address and its ways in on the
 * other: clearing it would let a login by the emailed link into the store
 * with no second step again. Its two addresses are logged out first, and the
 * record is cleared only once both logouts are confirmed ("logout" otherwise).
 */
export async function clearBrokenMoveByHand(
  email: string,
  confirm: string,
): Promise<"cleared" | "none" | "confirm" | "split" | "running" | "logout"> {
  const broken = await readBrokenMove(email);
  if (!broken) return "none";
  if (confirm.trim().toLowerCase() !== email.trim().toLowerCase()) return "confirm";
  // Never while a move of either address is running: its own record is this one (app/api/auth/move).
  if ((await moveRunning(broken.from)) || (await moveRunning(broken.to))) return "running";
  const holds = async (address: string) => ({
    store: Boolean(await storeForEmail(address)),
    ways: (await listPasskeys(address)).length > 0 || (await pendingNow(address)) !== null || (await twoStepOn(address)),
  });
  const [a, b] = await Promise.all([holds(broken.from), holds(broken.to)]);
  if ((a.store && !a.ways && b.ways) || (b.store && !b.ways && a.ways)) return "split";
  // The record is the lock on both addresses: it is cleared only once both are known to be
  // logged out. An unknown or failed logout keeps it for a later try (rule 30).
  const loggedOut = async (address: string) => {
    try {
      return (await endAllSessions(address)) !== null;
    } catch (error) {
      console.error("logging out a broken move's address failed", error);
      return false;
    }
  };
  const fromOut = await loggedOut(broken.from);
  const toOut = await loggedOut(broken.to);
  if (!fromOut || !toOut) return "logout";
  await clearBrokenMove(broken.from, broken.to);
  return "cleared";
}
