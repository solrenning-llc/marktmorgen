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
import { sessionSecondStep } from "@/lib/auth";
import { listPasskeys, pendingRemoval } from "@/lib/passkeys";
import { twoStepOn } from "@/lib/two-step";

/** Whether the account has a passkey or an authenticator app turned on, after any removal that has waited its days. */
export async function hasSecondStep(email: string, now = Date.now()): Promise<boolean> {
  await pendingRemoval(email, now);
  const [app, keys] = await Promise.all([twoStepOn(email), listPasskeys(email)]);
  return app || keys.length > 0;
}

/** Whether this session may add a passkey or turn on an app for this account. */
export async function mayAddSecondStep(email: string, session: string | undefined, now = Date.now()): Promise<boolean> {
  if ((await sessionSecondStep(session, email)) !== null) return true;
  return !(await hasSecondStep(email, now));
}
