/**
 * R29 finding 2, rule 30 siblings (security review of #3348, LOW): a team invitation (seven days) logs in only an
 * address that has no account yet (app/api/auth/join/route.ts, lib/account-exists.ts hasAccount). #3348 made the
 * address's own stores exact; the two other reads on the same path still took an unknown reply as "no account":
 *
 *   - two-step login (lib/two-step.ts twoStepOn): a record read in an odd shape was "off";
 *   - places on other teams (lib/team.ts memberStores): a team record, or the store behind it, read in an odd shape
 *     was skipped.
 *
 * A teammate with no store of their own and two-step login on, with both reads odd at once, was logged in by the
 * invitation without their code; a teammate without two-step, with only the team read odd, was logged in as well.
 * Now both are read in their exact shape: a confirmed absence is "none", a record is an account, anything else is
 * UnknownReplyError, which the route answers with invite-error before the invitation is spent.
 *
 * Synthetic: in-memory Redis, Resend and Stripe answered by stand-ins.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, emailForSession } from "@/lib/auth";
import { hasAccount } from "@/lib/account-exists";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { inviteMember, memberStores } from "@/lib/team";
import { finishSetup, startSetup, twoStepOn } from "@/lib/two-step";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
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
type Odd = (out: unknown[]) => unknown;
const real = redis.pipeline.bind(redis);

const codeTo = (to: string) => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
const nowCode = (secret: string) => codeAt(base32Decode(secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS));
async function turnOn(email: string, backup: string, session: string): Promise<void> {
  const started = await startSetup(email, session, backup);
  if (typeof started === "string") throw new Error(`setup: ${started}`);
  const finished = await finishSetup(email, session, nowCode(started.secret), codeTo(backup));
  if (typeof finished === "string") throw new Error(`finish: ${finished}`);
}

/** A single-command GET pipeline of a key that `key` accepts. */
const isGet = (commands: Command[], key: (k: string) => boolean) => commands.length === 1 && commands[0][0] === "GET" && key(String(commands[0][1]));
/** The two-step record of an address: nl:2fa:<40 hex>, not the setup or lock keys beside it. */
const twoStepRecord = (k: string) => /^nl:2fa:[0-9a-f]{40}$/.test(k);

/** Answers the next read of each matcher (only that one) with its odd reply. */
function arm(...rules: [(commands: Command[]) => boolean, Odd][]): void {
  const left = rules.map((rule) => ({ rule, armed: true }));
  redis.pipeline = (async (commands: Command[]) => {
    const out = await real(commands);
    const hit = left.find((l) => l.armed && l.rule[0](commands));
    if (!hit) return out;
    hit.armed = false;
    return hit.rule[1](out);
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

async function creator(email: string, handle: string, account: string) {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  await ensureListId(email);
  await setStripeAccount(email, account, true);
  await setSubscription(email, { customerId: `cus_${handle.replace(/-/g, "")}`, subscriptionId: `sub_${handle.replace(/-/g, "")}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(email))!;
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  const first = await creator("r29s-first@join.example", "r29s-first", "acct_1R29sFirstXXXXX");
  const second = await creator("r29s-second@join.example", "r29s-second", "acct_1R29sSecondXXXX");

  // MATE: no store of their own, on the first store's team, two-step login on. PLAIN: the same, without two-step.
  const MATE = "r29s-mate@join.example";
  const PLAIN = "r29s-plain@join.example";
  for (const who of [MATE, PLAIN]) {
    await inviteMember(first, who, "editor", "https://marktmorgen.com");
    const joined = await tap(tokenFor(who));
    is(`${who === MATE ? "the teammate" : "the plain teammate"} joined the first team as a new address (preparation)`, String(joined.headers.get("location")).includes("team=joined"), true);
  }
  await turnOn(MATE, "r29s-mate.backup@join.example", "c".repeat(64));

  const teamOfFirst = (commands: Command[]) => isGet(commands, (k) => k === `nl:team:${first.sid}`);
  const idOfFirst = (commands: Command[]) => isGet(commands, (k) => k === `nl:store:id:${first.sid}`);
  const twoStepOf = (commands: Command[]) => isGet(commands, twoStepRecord);

  part("Healthy reads: unchanged");
  is("the teammate with two-step on counts as an account", await hasAccount(MATE), true);
  is("the plain teammate counts as an account", await hasAccount(PLAIN), true);
  is("an address with nothing here is not an account", await hasAccount("r29s-nobody@join.example"), false);
  const TWO_ONLY = "r29s-two-only@join.example";
  await turnOn(TWO_ONLY, "r29s-two-only.backup@join.example", "d".repeat(64));
  is("two-step login on alone (no store, team or passkey) counts as an account", await hasAccount(TWO_ONLY), true);

  // The strict reads live in lib/account-exists.ts with their own key-building: they must read exactly the keys
  // twoStepOn and memberStores read, so a change of key there breaks this test.
  const keysOf = async (run: () => Promise<unknown>) => {
    const keys = new Set<string>();
    redis.pipeline = (async (commands: Command[]) => {
      for (const c of commands) {
        const key = String(c[1] ?? "");
        if ((c[0] === "GET" || c[0] === "SMEMBERS") && (twoStepRecord(key) || key.startsWith("nl:team:") || key.startsWith("nl:store:id:"))) keys.add(`${c[0]} ${key}`);
      }
      return real(commands);
    }) as typeof redis.pipeline;
    await run();
    redis.pipeline = real;
    return [...keys].sort();
  };
  const theirs = await keysOf(async () => { await twoStepOn(MATE); await memberStores(MATE); });
  const ours = await keysOf(() => hasAccount(MATE));
  is("hasAccount reads the very keys twoStepOn and memberStores read (two-step record, team index, team record, store id)", [ours, theirs.length >= 4], [theirs, true]);

  part("hasAccount: an odd read of two-step login or of a team is never \"no account\"");
  const twoStepOdd: [string, Odd][] = [
    ["a number", () => [1]],
    ["a list", () => [["x"]]],
    ["an empty string", () => [""]],
    ["\"QUEUED\"", () => ["QUEUED"]],
    ["\"{}\" (no secret)", () => ["{}"]],
    ["\"null\"", () => ["null"]],
    ["no reply for the command", () => []],
    ["no reply at all", () => null],
  ];
  const teamOdd: [string, Odd][] = [
    ["a number", () => [1]],
    ["\"QUEUED\"", () => ["QUEUED"]],
    ["\"{}\" (no members)", () => ["{}"]],
    ["a list", () => [["x"]]],
    ["no reply for the command", () => []],
    ["no reply at all", () => null],
  ];
  const idOdd: [string, Odd][] = [
    ["a number", () => [1]],
    ["a list", () => [["x"]]],
    ["an empty string", () => [""]],
    ["\"QUEUED\" (no store behind it)", () => ["QUEUED"]],
    ["no reply for the command", () => []],
  ];
  for (const [what, odd] of twoStepOdd) {
    arm([twoStepOf, odd]);
    const name = await errorName(hasAccount(MATE));
    redis.pipeline = real;
    is(`two-step record as ${what}: refused as unknown`, name, "UnknownReplyError");
  }
  for (const [what, odd] of teamOdd) {
    arm([teamOfFirst, odd]);
    const name = await errorName(hasAccount(PLAIN));
    redis.pipeline = real;
    is(`the first store's team record as ${what}: refused as unknown`, name, "UnknownReplyError");
  }
  for (const [what, odd] of idOdd) {
    arm([idOfFirst, odd]);
    const name = await errorName(hasAccount(PLAIN));
    redis.pipeline = real;
    is(`the first store's id record as ${what}: refused as unknown`, name, "UnknownReplyError");
  }
  arm([twoStepOf, () => ["QUEUED"]], [teamOfFirst, () => [1]]);
  const both = await errorName(hasAccount(MATE));
  redis.pipeline = real;
  is("both odd at once (the review's case): refused as unknown, never \"no account\"", both, "UnknownReplyError");

  part("The invitation route: an odd read refuses before anything is spent and never opens a session");
  await inviteMember(second, MATE, "editor", "https://marktmorgen.com");
  const mateToken = tokenFor(MATE);
  await inviteMember(second, PLAIN, "editor", "https://marktmorgen.com");
  const plainToken = tokenFor(PLAIN);
  is("both invitations to the second store are sent (preparation)", [mateToken.length, plainToken.length], [64, 64]);
  const cases: [string, string, [(commands: Command[]) => boolean, Odd][]][] = [
    ["the teammate with two-step on, two-step record \"QUEUED\" and team record a number (the review's case)", mateToken, [[twoStepOf, () => ["QUEUED"]], [teamOfFirst, () => [1]]]],
    ["the teammate with two-step on, two-step record a number and the store id a list", mateToken, [[twoStepOf, () => [1]], [idOfFirst, () => [["x"]]]]],
    ["the plain teammate, team record \"{}\"", plainToken, [[teamOfFirst, () => ["{}"]]]],
    ["the plain teammate, store id \"QUEUED\"", plainToken, [[idOfFirst, () => ["QUEUED"]]]],
  ];
  for (const [what, token, rules] of cases) {
    const who = token === mateToken ? MATE : PLAIN;
    arm(...rules);
    const response = await tap(token);
    redis.pipeline = real;
    const session = sessionOf(response);
    is(`${what}: invite-error, no session`, [response.headers.get("location"), session === "" || (await emailForSession(session)) !== who], ["https://marktmorgen.com/signin?status=invite-error", true]);
  }

  for (const [who, token] of [[MATE, mateToken], [PLAIN, plainToken]] as const) {
    const kept = await tap(token);
    is(`${who === MATE ? "the teammate" : "the plain teammate"}'s invitation was still good: read normally, it only puts them on the team`, [kept.headers.get("location"), kept.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))], ["https://marktmorgen.com/signin?status=invite-joined", false]);
  }

  const NEW = "r29s-new@join.example";
  await inviteMember(second, NEW, "editor", "https://marktmorgen.com");
  const fresh = await tap(tokenFor(NEW));
  const freshSession = sessionOf(fresh);
  is("read normally, an address with no account yet is still logged in with the store open", [String(fresh.headers.get("location")).includes("team=joined"), freshSession !== "" && (await emailForSession(freshSession)) === NEW], [true, true]);

  done();
}

void main();
