/**
 * Codex G, issue #4265 (hidden #4150, transcribed by Claude 1): an invitation whose last step (the teammate's index SADD) fails
 * after GETDEL and saveTeam succeeded leaves the token spent and the person on the team record, while
 * memberStores (and so the studio and hasAccount) never finds the store. A retry of the same link is "expired".
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { inviteMember, memberStores, readTeam } from "@/lib/team";
import { hasAccount } from "@/lib/account-exists";
import { POST as join_ } from "@/app/api/auth/join/route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_invite_two_step_only_a_stand_in";
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const host = new URL(url).hostname;
  if (host === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  if (host === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let failIndexAdd = false;
redis.pipeline = (async (batch: Command[]) => {
  if (failIndexAdd && batch.some((c) => c[0] === "SADD" && String(c[1]).startsWith("nl:team:of:"))) {
    failIndexAdd = false;
    throw new Error("Redis request failed with status 503");
  }
  return real(batch);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const CREATOR = "creator@zz4150.example";
  await claimHandle(CREATOR, "zzfourshop", "ZZ 4150", "");
  await ensureStatsId(CREATOR);
  await ensureStoreId(CREATOR);
  await ensureListId(CREATOR);
  await setStripeAccount(CREATOR, "acct_1ZzFourOneFive", true);
  await setSubscription(CREATOR, { customerId: "cus_zzfouronefive", subscriptionId: "sub_zzfouronefive", active: true, tier: "creator", period: paidPeriod() });
  const shop = (await storeForEmail(CREATOR))!;
  const NEW = "newcomer@zz4150.example";
  const invited = await inviteMember(shop, NEW, "editor", "https://marktmorgen.com");
  if (!invited.ok) throw new Error("no invitation: " + JSON.stringify(invited));
  const token = /\/signin\/join\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === NEW)?.text ?? "")?.[1] ?? "";

  const take = async (ip: number) =>
    (await join_(new NextRequest("https://marktmorgen.com/api/auth/join", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `203.0.113.${ip}` },
      body: new URLSearchParams({ token }),
    }))).headers.get("location") ?? "";

  part("The invitation's last write (the index SADD) fails once, after GETDEL and saveTeam");
  failIndexAdd = true;
  const first = await take(1);
  is("the route says the invitation failed", new URL(first).searchParams.get("status"), "invite-error");
  const onTeam = (await readTeam(shop.sid)).members.some((m) => m.email === NEW);
  const found = (await memberStores(NEW)).map((m) => m.store.sid);
  is("the team record and the teammate's index agree (both have the store, or neither)", onTeam === found.includes(shop.sid), true);
  // Today the join wrote the team record; a fix may instead leave the person off it (then the link must not be spent).
  if (onTeam) {
    is("on the team record, the person finds that store from their own address (memberStores)", found, [shop.sid]);
    is("and counts as an account (hasAccount reads memberStores)", await hasAccount(NEW), true);
  } else {
    is("off the team record, the same link still joins", new URL(await take(2)).searchParams.get("status") === "invite-expired", false);
    is("and then the team and the index both have them", [(await readTeam(shop.sid)).members.some((m) => m.email === NEW), (await memberStores(NEW)).map((m) => m.store.sid)], [true, [shop.sid]]);
    is("the link, used, does not join twice", new URL(await take(3)).searchParams.get("status"), "invite-expired");
  }
  done();
}

void main();
