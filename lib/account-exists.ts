/**
 * Whether an address already has an account here, for taking a team
 * invitation (app/api/auth/join/route.ts): an existing account is only put on
 * the team and logs in the usual way, so a seven-day invitation link is never
 * a key to it.
 */
import { memberStores } from "@/lib/team";
import { accountStores } from "@/lib/store";
import { listPasskeys } from "@/lib/passkeys";
import { twoStepOn } from "@/lib/two-step";

/**
 * A store of its own, a place on another store's team, a passkey, or two-step
 * login turned on: an address with an authenticator app is an account whose
 * login asks for its code, so an invitation must not open it without one.
 */
export async function hasAccount(email: string): Promise<boolean> {
  const [owned, member, passkeys, twoStep] = await Promise.all([accountStores(email), memberStores(email), listPasskeys(email), twoStepOn(email)]);
  return owned.length > 0 || member.length > 0 || passkeys.length > 0 || twoStep;
}
