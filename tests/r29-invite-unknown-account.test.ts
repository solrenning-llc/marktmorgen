/**
 * R29 finding 2 (sessions, CX-123 rule 24): a team invitation (seven days) logs in only an address that has no
 * account yet (app/api/auth/join/route.ts, lib/account-exists.ts hasAccount). hasAccount read the address's own
 * stores through lib/store.ts accountStores, which takes an owner record in an unknown shape (and an account set in
 * an unknown shape) as "no store": the invitation then opened a full session INTO an existing creator's account, the
 * "seven-day key to an existing account" the route says it never is.
 *
 * Now the owner record and the account set are read in their exact shape (GET: a string or null; SMEMBERS: a list
 * of strings): a confirmed absence is "no store", a record is an account, and anything else is UnknownReplyError,
 * which the route turns into invite-error before the invitation is spent.
 *
 * Synthetic: in-memory Redis, Resend and Stripe answered by stand-ins.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, emailForSession } from "@/lib/auth";
import { hasAccount } from "@/lib/account-exists";
import { accountStores, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { inviteMember } from "@/lib/team";
import { POST as join } from "@/app/api/auth/join/route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_invite_two_step_only_a_stand_in";
const mails: { to: string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const host = new URL(String(input instanceof Request ? input.url : input)).hostname;
  if (host === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), subject: String(body.subject ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  if (host === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);

/** The one pipeline that reads an address's own stores: GET of its owner record, SMEMBERS of its account set. */
const isAccountRead = (commands: Command[]) =>
  commands.length === 2 &&
  commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:store:owner:") &&
  commands[1][0] === "SMEMBERS" && String(commands[1][1]).startsWith("nl:account:stores:");

/** Answers the next account read (only that one) with `odd(real replies)`. */
function armOnce(odd: (out: unknown[]) => unknown): void {
  let armed = true;
  redis.pipeline = (async (commands: Command[]) => {
    const out = await real(commands);
    if (!armed || !isAccountRead(commands)) return out;
    armed = false;
    return odd(out);
  }) as typeof redis.pipeline;
}

const tokenFor = (to: string) => /signin\/join\?token=([0-9a-f]{64})/.exec(mails.filter((m) => m.to === to).at(-1)?.text ?? "")?.[1] ?? "";
let nextIp = 10;
const tap = (token: string) =>
  join(new NextRequest("https://marktmorgen.com/api/auth/join", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `203.0.113.${nextIp++}` },
    body: new URLSearchParams({ token }),
  }));
const sessionOf = (response: Response) => /nl_session=([0-9a-f]{64})/.exec(response.headers.getSetCookie().join("\n"))?.[1] ?? "";
const errorName = (promise: Promise<unknown>) => promise.then(() => "resolved", (error: unknown) => (error instanceof Error ? error.name : String(error)));

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  const CREATOR = "r29-inviter@join.example";
  await claimHandle(CREATOR, "r29-inviter", "R29 Inviter", "");
  await ensureStatsId(CREATOR);
  await ensureStoreId(CREATOR);
  await ensureListId(CREATOR);
  await setStripeAccount(CREATOR, "acct_1R29InviterXXXX", true);
  await setSubscription(CREATOR, { customerId: "cus_r29inviter", subscriptionId: "sub_r29inviter", active: true, tier: "creator", period: paidPeriod() });
  const shop = (await storeForEmail(CREATOR))!;

  // The invited address is an existing creator, with a store of its own (no passkey, no app).
  const OTHER = "r29-existing@join.example";
  await claimHandle(OTHER, "r29-existing", "R29 Existing", "");

  part("Healthy reads: unchanged");
  is("the existing creator counts as an account", await hasAccount(OTHER), true);
  is("an address with nothing here (a confirmed absent record and an empty set) is not an account", await hasAccount("r29-nobody@join.example"), false);
  const seen: Command[][] = [];
  redis.pipeline = (async (commands: Command[]) => {
    if (isAccountRead(commands)) seen.push(commands);
    return real(commands);
  }) as typeof redis.pipeline;
  await accountStores(OTHER);
  await hasAccount(OTHER);
  redis.pipeline = real;
  is("hasAccount reads the very keys accountStores reads (owner record, account set)", seen.length === 2 && JSON.stringify(seen[0]) === JSON.stringify(seen[1]), true);

  const invited = await inviteMember(shop, OTHER, "editor", "https://marktmorgen.com");
  const token = tokenFor(OTHER);
  is("the invitation is sent (preparation)", [invited.ok, token.length], [true, 64]);

  const TWIN = "r29-existing-twin@join.example";
  await claimHandle(TWIN, "r29-existing-twin", "R29 Existing Twin", "");
  await inviteMember(shop, TWIN, "editor", "https://marktmorgen.com");
  const twin = await tap(tokenFor(TWIN));
  is("read normally, the invitation logs no existing account in (\"log in the usual way\")", [twin.headers.get("location"), twin.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))], ["https://marktmorgen.com/signin?status=invite-joined", false]);

  const NEW = "r29-new@join.example";
  await inviteMember(shop, NEW, "editor", "https://marktmorgen.com");
  const fresh = await tap(tokenFor(NEW));
  const freshSession = sessionOf(fresh);
  is("read normally, an address with no account yet is logged in with the store open", [String(fresh.headers.get("location")).includes("team=joined"), freshSession !== "" && (await emailForSession(freshSession)) === NEW], [true, true]);

  part("hasAccount: an unknown read of the address's own stores is never \"no store\"");
  const unknown: [string, (out: unknown[]) => unknown][] = [
    ["the owner record as a number", (out) => [1, out[1]]],
    ["the owner record as a list", (out) => [["x"], out[1]]],
    ["the owner record as an empty string", (out) => ["", out[1]]],
    ["the owner record missing (one reply for two commands)", (out) => [out[0]]],
    ["the account set as \"QUEUED\"", (out) => [out[0], "QUEUED"]],
    ["the account set as null", (out) => [out[0], null]],
    ["the account set as a number", (out) => [out[0], 7]],
    ["the account set holding a number", (out) => [out[0], [1]]],
    ["no reply at all", () => null],
    ["an empty pipeline reply", () => []],
  ];
  for (const [what, odd] of unknown) {
    armOnce(odd);
    const name = await errorName(hasAccount(OTHER));
    redis.pipeline = real;
    is(`${what}: refused as unknown`, name, "UnknownReplyError");
  }
  // Also for an address with nothing here: a set read oddly is not a confirmed empty set.
  armOnce((out) => [out[0], "QUEUED"]);
  const nobody = await errorName(hasAccount("r29-nobody@join.example"));
  redis.pipeline = real;
  is("an address with nothing here, its set read as \"QUEUED\": refused as unknown, never \"no account\"", nobody, "UnknownReplyError");

  part("The invitation route: an unknown read refuses before anything is spent and never opens a session");
  for (const [what, odd] of unknown) {
    armOnce(odd);
    const response = await tap(token);
    redis.pipeline = real;
    const session = sessionOf(response);
    is(`${what}: invite-error, no session`, [response.headers.get("location"), session === "" || (await emailForSession(session)) !== OTHER], ["https://marktmorgen.com/signin?status=invite-error", true]);
  }

  const kept = await tap(token);
  is("the invitation was still good after every refusal: read normally, it now only puts the creator on the team", [kept.headers.get("location"), sessionOf(kept)], ["https://marktmorgen.com/signin?status=invite-joined", ""]);

  part("Another existing creator's own store record answered \"QUEUED\" (the audit's proof)");
  const THIRD = "r29-existing-third@join.example";
  await claimHandle(THIRD, "r29-existing-third", "R29 Existing Third", "");
  await inviteMember(shop, THIRD, "editor", "https://marktmorgen.com");
  armOnce((out) => ["QUEUED", out[1]]);
  const response = await tap(tokenFor(THIRD));
  redis.pipeline = real;
  const session = sessionOf(response);
  console.log(`        (route answered ${response.headers.get("location")})`);
  is("no session is opened into the existing account (never read as \"no account\")", [session === "" || (await emailForSession(session)) !== THIRD], [true]);
  is("a record that is there counts as an account: the invitation only puts the creator on the team", response.headers.get("location"), "https://marktmorgen.com/signin?status=invite-joined");

  done();
}

void main();
