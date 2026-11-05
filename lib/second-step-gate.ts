/**
 * Who may add a new way in to an account: a passkey, or an authenticator app.
 *
 * An account that already has a second step (a passkey, or an app turned on)
 * gets a new one only from a session that was opened with one of them
 * (lib/auth.ts sessionSecondStep): an emailed link proves only the inbox, so
 * a session it opens, however fresh, does not add a passkey or an app, for
 * the owner as for anybody. An account with neither adds its first one from
 * any fresh session, as before. Somebody who lost theirs removes it from a
 * session without the step, which waits REMOVAL_DAYS with an email to the
 * account (lib/passkeys.ts scheduleRemoval), or asks to turn the app off
 * without a code, which waits as long (lib/two-step.ts enterLocked).
 */
import { type SecondStep, isMoving, sessionMark } from "@/lib/auth";
import { holdsPasskeys, listPasskeys, pendingNow, pendingRemoval } from "@/lib/passkeys";
import { twoStepOn } from "@/lib/two-step";

/**
 * The second step a session really has now, which every check of one goes
 * through (the team's door, adding a passkey or an app, removing a passkey at
 * once, "Keep it", the team's switch, Cancel under Two-step login):
 *   - removals whose wait ran out are applied first, which logs out the
 *     sessions those passkeys opened;
 *   - a session opened with a passkey that is gone has none;
 *   - a session opened with a passkey that is set to be removed has none
 *     either (owner, security review of f4fdf43d0): whoever holds that
 *     passkey may not be its owner, so it opens the account as an emailed
 *     link would, and nothing more.
 */
export async function liveSecondStep(email: string, session: string | undefined, now = Date.now()): Promise<SecondStep | null> {
  const pending = await pendingRemoval(email, now);
  const mark = await sessionMark(session, email);
  // The app's marks hold only while the app is still on (turning it off also takes them: lib/auth.ts dropSecondStep).
  if (mark === "app" || mark === "recovery") return (await twoStepOn(email)) ? mark : null;
  if (!mark?.startsWith("passkey")) return null;
  const id = mark.slice("passkey:".length);
  if (!id || pending?.ids.includes(id)) return null;
  return (await listPasskeys(email)).some((p) => p.id === id) ? "passkey" : null;
}

/**
 * Whether a session with this second step (null: none) may press "Keep it"
 * (owner C3-95): only one with a valid second step, from another passkey or
 * the app's code. An emailed link may not, and neither may the session of
 * the very passkey that is set to be removed (liveSecondStep gives it none).
 */
export function mayKeepPasskey(step: SecondStep | null): boolean {
  return step !== null;
}

/**
 * Whether the account has a passkey or an authenticator app turned on, after
 * any removal that has waited its days. An address in the middle of a move
 * counts as having one (lib/auth.ts markMoving): its ways in have left and
 * not settled, and nothing may be added in that gap.
 */
export async function hasSecondStep(email: string, now = Date.now()): Promise<boolean> {
  if (await isMoving(email)) return true;
  await pendingRemoval(email, now);
  const [app, keys] = await Promise.all([twoStepOn(email), listPasskeys(email)]);
  return app || keys.length > 0;
}

/** Whether this session may add a passkey or turn on an app for this account. Never while the address is moving. */
export async function mayAddSecondStep(email: string, session: string | undefined, now = Date.now()): Promise<boolean> {
  if (await isMoving(email)) return false;
  if ((await liveSecondStep(email, session, now)) !== null) return true;
  return !(await hasSecondStep(email, now));
}

/**
 * The same question, asked again under the passkeys' or the two-step lock
 * just before the write (lib/passkeys.ts addPasskey, lib/two-step.ts
 * finishSetup): it takes no lock and applies nothing, reading what is there
 * now, and a removal not yet applied counts as still waiting.
 */
export async function mayAddNow(email: string, session: string | undefined): Promise<boolean> {
  if (await isMoving(email)) return false;
  const [mark, app, keys, waiting] = await Promise.all([sessionMark(session, email), twoStepOn(email), listPasskeys(email), pendingNow(email)]);
  const id = mark?.startsWith("passkey:") ? mark.slice("passkey:".length) : "";
  const valid = mark === "app" || mark === "recovery" ? app : id !== "" && keys.some((p) => p.id === id) && !waiting?.ids.includes(id);
  if (valid) return true;
  return !(app || keys.length > 0 || waiting !== null);
}

/**
 * Whether an address holds any way in of its own: a passkey, an
 * authenticator app with its recovery codes, or a passkey removal waiting.
 * An account is never moved onto such an address (security review of
 * da5191515): its ways in would join the account's.
 */
export async function holdsSecondStep(email: string): Promise<boolean> {
  const [app, keys, moving] = await Promise.all([twoStepOn(email), holdsPasskeys(email), isMoving(email)]);
  return app || keys || moving;
}
