/**
 * Taking a team invitation does not skip two-step login (393 security audit
 * SG1, 506 [SG1], MM-SA-20). A seven-day invitation link logs in only an
 * address that has no account yet; an address with two-step login on is an
 * account whose login asks for its code, even with no store, team or passkey
 * of its own, so the invitation only puts it on the team (lib/account-exists.ts,
 * app/api/auth/join/route.ts).
 */
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { hasAccount } from "@/lib/account-exists";
import { finishSetup, startSetup } from "@/lib/two-step";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { inviteMember, readTeam } from "@/lib/team";
import { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { POST as join_ } from "@/app/api/auth/join/route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_invite_two_step_only_a_stand_in";
const mails: { to: string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const host = new URL(url).hostname;
  if (host === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), subject: String(body.subject ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  if (host === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
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

  part("The invitation taken, through the route itself (review of #2101, inbox C4-20)");
  let ip = 0;
  const take = async (token: string) => {
    ip += 1;
    const response = await join_(
      new NextRequest("https://marktmorgen.com/api/auth/join", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `203.0.113.${ip}` },
        body: new URLSearchParams({ token }),
      }),
    );
    const cookies = response.headers.getSetCookie?.() ?? [];
    return { where: response.headers.get("location") ?? "", session: cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`)) };
  };
  // The token travels only in the invitation email (lib/team.ts): read from the email the stand-in kept.
  const tokenTo = (to: string) => /\/signin\/join\?token=([0-9a-f]{64})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
  const helperToken = tokenTo(HELPER);
  const helper = await take(helperToken);
  is("an address with two-step login on is put on the team and sent to log in the usual way, with no session opened", [new URL(helper.where).searchParams.get("status"), helper.session], ["invite-joined", false]);
  const NEW = "first.timer@join.example";
  const fresh = await inviteMember(shop, NEW, "editor", "https://marktmorgen.com");
  if (!fresh.ok) throw new Error("no second invitation");
  const newcomer = await take(tokenTo(NEW));
  is("an address with no account is logged in by the tap, the store open", [newcomer.session, new URL(newcomer.where).searchParams.get("team")], [true, "joined"]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const members = (await readTeam(shop.sid)).members.map((m) => m.email).sort();
  is("both are on the team after the tap", members.includes(HELPER) && members.includes(NEW), true);
  is("and the owner was told of each, by email", mails.filter((m) => m.to === CREATOR).length >= 2, true);
  const again = await take(helperToken);
  is("an invitation already taken opens nothing", [again.session, (new URL(again.where).searchParams.get("status") ?? "").startsWith("invite-")], [false, true]);

  done();
}

void main();
