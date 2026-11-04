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
import { type SecondStep, sessionMark } from "@/lib/auth";
import { listPasskeys, pendingRemoval } from "@/lib/passkeys";
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
  if (mark === "app" || mark === "recovery") return mark;
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

/** Whether the account has a passkey or an authenticator app turned on, after any removal that has waited its days. */
export async function hasSecondStep(email: string, now = Date.now()): Promise<boolean> {
  await pendingRemoval(email, now);
  const [app, keys] = await Promise.all([twoStepOn(email), listPasskeys(email)]);
  return app || keys.length > 0;
}

/** Whether this session may add a passkey or turn on an app for this account. */
export async function mayAddSecondStep(email: string, session: string | undefined, now = Date.now()): Promise<boolean> {
  if ((await liveSecondStep(email, session, now)) !== null) return true;
  return !(await hasSecondStep(email, now));
}
