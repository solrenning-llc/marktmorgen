/**
 * A team invitation accepted twice at once adds one member (Claude 7's race hunt). spendInvite takes the token with
 * GETDEL, so only one of two clicks (two tabs, a double click on the emailed link) holds the claim, and the team record
 * is read and written under the team's lock (withTeam). A guard, not a fix: this holds on main and keeps it so.
 * Real MemoryRedis; the invitation email is kept by a stand-in for the provider.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { inviteMember, readTeam, spendInvite } from "@/lib/team";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_invite_two_step_only_a_stand_in";
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const host = new URL(String(input instanceof Request ? input.url : input)).hostname;
  if (host === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  if (host === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;
const tokenTo = (to: string) => /\/signin\/join\?token=([0-9a-f]{64})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";

test("the same invitation accepted twice at once: one member joins, the other click is told it expired", async () => {
  redis.clear();
  const CREATOR = "creator@inviterace.example";
  const HELPER = "helper@inviterace.example";
  await claimHandle(CREATOR, "invite-race", "Invite Race", "");
  await ensureStatsId(CREATOR);
  await ensureStoreId(CREATOR);
  await ensureListId(CREATOR);
  await setStripeAccount(CREATOR, "acct_1InviteRaceXXXX", true);
  await setSubscription(CREATOR, { customerId: "cus_inviterace", subscriptionId: "sub_inviterace", active: true, tier: "creator", period: paidPeriod() });
  const shop = (await storeForEmail(CREATOR))!;
  const invited = await inviteMember(shop, HELPER, "editor", "https://marktmorgen.com");
  assert.equal(invited.ok, true, JSON.stringify(invited));
  const token = tokenTo(HELPER);
  assert.match(token, /^[0-9a-f]{64}$/, "the invitation email carries its link");

  const results = await Promise.all([spendInvite(token), spendInvite(token)]);
  assert.equal(results.filter((r) => r.ok).length, 1, "one click joins");
  assert.deepEqual(results.filter((r) => !r.ok).map((r) => !r.ok && r.reason), ["expired"]);
  const team = await readTeam(shop.sid);
  assert.equal(team.members.filter((m) => m.email === HELPER).length, 1, "one member, not two");
  assert.equal(team.invites.length, 0, "the invitation is spent");
});
