/**
 * Taking a team invitation does not skip two-step login (393 security audit
 * SG1, 506 [SG1], MM-SA-20). A seven-day invitation link logs in only an
 * address that has no account yet; an address with two-step login on is an
 * account whose login asks for its code, even with no store, team or passkey
 * of its own, so the invitation only puts it on the team (lib/account-exists.ts,
 * app/api/auth/join/route.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { hasAccount } from "@/lib/account-exists";
import { finishSetup, startSetup } from "@/lib/two-step";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { inviteMember } from "@/lib/team";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_invite_two_step_only_a_stand_in";
const mails: { to: string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), subject: String(body.subject ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  if (url.includes("api.stripe.com")) return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const codeTo = (to: string) => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
const nowCode = (secret: string) => codeAt(base32Decode(secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS));

/** Two-step login turned on for an address, with a confirmed recovery address. */
async function turnOn(email: string, backup: string, session: string): Promise<void> {
  const started = await startSetup(email, session, backup);
  if (typeof started === "string") throw new Error(`setup: ${started}`);
  const finished = await finishSetup(email, session, nowCode(started.secret), codeTo(backup));
  if (typeof finished === "string") throw new Error(`finish: ${finished}`);
}

async function main(): Promise<void> {
  redis.clear();

  part("A team invitation does not skip two-step login");
  const CREATOR = "creator@join.example";
  await claimHandle(CREATOR, "join-two-step", "Join Two Step", "");
  await ensureStatsId(CREATOR);
  await ensureStoreId(CREATOR);
  await ensureListId(CREATOR);
  await setStripeAccount(CREATOR, "acct_1JoinTwoStepXXX", true);
  await setSubscription(CREATOR, { customerId: "cus_jointwostep", subscriptionId: "sub_jointwostep", active: true, tier: "creator", period: paidPeriod() });
  const shop = (await storeForEmail(CREATOR))!;
  const HELPER = "helper@join.example";
  await turnOn(HELPER, "helper.backup@join.example", "b".repeat(64));
  const invited = await inviteMember(shop, HELPER, "editor", "https://marktmorgen.com");
  is("the invitation is sent", invited.ok, true);
  // The route reads this before spending the invitation; true sends them to log in the usual way, with no session opened.
  is("an address with two-step login on, and no store, team or passkey, counts as an account", await hasAccount(HELPER), true);
  is("an address with nothing still does not", await hasAccount("nobody@join.example"), false);
  is("and the invitation route asks that very check", readFileSync(join(process.cwd(), "app/api/auth/join/route.ts"), "utf8").includes('import { hasAccount } from "@/lib/account-exists";'), true);

  done();
}

void main();
