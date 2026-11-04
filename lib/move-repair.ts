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
import { listPasskeys, movePasskeys, pendingNow } from "@/lib/passkeys";
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
    await endAllSessions(away);
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
 * looked (scripts/move-repair.mjs, with the address typed again). Its two
 * addresses are logged out.
 */
export async function clearBrokenMoveByHand(email: string, confirm: string): Promise<boolean> {
  const broken = await readBrokenMove(email);
  if (!broken || confirm.trim().toLowerCase() !== email.trim().toLowerCase()) return false;
  await clearBrokenMove(broken.from, broken.to);
  await endAllSessions(broken.from);
  await endAllSessions(broken.to);
  return true;
}
