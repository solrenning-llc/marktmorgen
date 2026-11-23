/**
 * One-time values and a session's second step are read in their exact shape (CX-123 rule 24; #4055, #4057, #4058,
 * Codex G). A move link, Google's sign-in state and a team invitation are spent by GETDEL (or GET then DEL), and a
 * session's second step is read by two GETs; each took its reply by destructuring, so an answer with one reply more
 * (a valid value and something after it) was taken as the value: a link spent, an invitation accepted, a passkey's
 * mark read as a live second step. Now an answer of any other shape proves nothing: no value is taken, and a mark
 * that does not read throws, so the team's door stays shut. Controls: the exact answers still work.
 * Synthetic store, passkey and Redis (tests/redis-stub.ts), replies bent on purpose; no email leaves.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keepGoogleState, openSession, sessionMark, takeGoogleState } from "@/lib/auth";
import { takeOnce } from "@/lib/redis-take-once";
import { liveSecondStep } from "@/lib/second-step-gate";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { inviteMember, putMember, readTeam, setRequireTwoStep, spendInvite, teamTwoStepBlocks } from "@/lib/team";
import { UnknownReplyError } from "@/lib/redis-reply";
import { makePasskey } from "./passkey-world";
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

type Commands = (string | number)[][];
const original = redis.pipeline.bind(redis);

/**
 * Runs `work` with the answers bent: `bend` sees each pipeline's commands and the stand-in's own replies, and answers
 * the pipeline (or throws, as a Redis without GETDEL does); it returns undefined to leave the answer as it is.
 */
async function bent<T>(bend: (commands: Commands, replies: () => Promise<unknown[]>) => Promise<unknown[] | undefined>, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Commands) => {
    let ran: unknown[] | null = null;
    const replies = async () => (ran ??= await original(commands));
    const answer = await bend(commands, replies);
    return answer ?? (await replies());
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

/** GETDEL not served (it throws), the GET and DEL then answered by `get` and `del` (undefined: as the stand-in does). */
const fallback = (get?: (r: unknown[]) => unknown[], del?: (r: unknown[]) => unknown[]) =>
  async (commands: Commands, replies: () => Promise<unknown[]>) => {
    if (commands[0][0] === "GETDEL") throw new Error("ERR unknown command 'GETDEL'");
    if (commands[0][0] === "GET" && get) return get(await replies());
    if (commands[0][0] === "DEL" && del) return del(await replies());
    return undefined;
  };
const getdel = (answer: (r: unknown[]) => unknown[]) =>
  async (commands: Commands, replies: () => Promise<unknown[]>) => (commands[0][0] === "GETDEL" ? answer(await replies()) : undefined);

async function main(): Promise<void> {
  redis.clear();

  part("takeOnce: only an exact answer takes the value (#4055, #4057)");
  const KEY = "nl:test:take-once";
  const take = async (bend?: Parameters<typeof bent>[0]) => {
    await original([["SET", KEY, "value"]]);
    const got = bend ? await bent(bend, () => takeOnce(KEY)) : await takeOnce(KEY);
    await original([["DEL", KEY]]);
    return got;
  };
  is("control: GETDEL, one reply", await take(), "value");
  is("control: GET then DEL, one reply each, 1 removed", await take(fallback()), "value");
  is("GETDEL with one reply more is no value", await take(getdel((r) => [...r, "extra"])), null);
  is("GETDEL with no reply is no value", await take(getdel(() => [])), null);
  is("GET with one reply more is no value", await take(fallback((r) => [...r, "extra"])), null);
  is("DEL with one reply more is no value", await take(fallback(undefined, (r) => [...r, 1])), null);
  is("DEL answering the text \"1\" is no value", await take(fallback(undefined, () => ["1"])), null);
  is("DEL answering 0 (another taker won) is no value", await take(fallback(undefined, () => [0])), null);

  part("Google's sign-in state (#4055)");
  await keepGoogleState("state-a", "verifier-a");
  is("one reply more: nothing taken", await bent(getdel((r) => [...r, "extra"]), () => takeGoogleState("state-a")), null);
  await keepGoogleState("state-b", "verifier-b");
  is("control: the state is taken once", [await takeGoogleState("state-b"), await takeGoogleState("state-b")], ["verifier-b", null]);
  const source = readFileSync(join(process.cwd(), "lib/auth.ts"), "utf8");
  is("the move link is spent the same way", /const raw = await takeOnce\(await moveKey\(token\)\);/.test(source), true);

  part("A team invitation (#4057)");
  const OWNER = "owner@exact-take.example";
  await claimHandle(OWNER, "exact-take", "Exact Take", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1ExactTakeXXXX", true);
  await setSubscription(OWNER, { customerId: "cus_exacttake", subscriptionId: "sub_exacttake", active: true, tier: "creator", period: paidPeriod() });
  const shop = (await storeForEmail(OWNER))!;
  const tokenTo = (to: string) => /\/signin\/join\?token=([0-9a-f]{64})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
  const onTeam = async (email: string) => (await readTeam(shop.sid)).members.some((m) => m.email === email);
  const BENT = "bent@exact-take.example";
  if (!(await inviteMember(shop, BENT, "editor", "https://marktmorgen.com")).ok) throw new Error("no invitation");
  is("one reply more: expired, and nobody added", [await bent(getdel((r) => [...r, "extra"]), () => spendInvite(tokenTo(BENT))), await onTeam(BENT)], [{ ok: false, reason: "expired" }, false]);
  const PLAIN = "plain@exact-take.example";
  if (!(await inviteMember(shop, PLAIN, "editor", "https://marktmorgen.com")).ok) throw new Error("no invitation");
  const plain = await spendInvite(tokenTo(PLAIN));
  is("control: an exact answer adds them", [plain.ok, await onTeam(PLAIN)], [true, true]);

  part("A session's second step (#4058)");
  const MATE = "mate@exact-take.example";
  await putMember(shop, MATE, "editor");
  await setRequireTwoStep(shop, true, OWNER);
  const key = makePasskey(MATE, "cred-exact-1");
  await key.keep();
  const session = await openSession(MATE, "passkey", "cred-exact-1");
  const marks = async (commands: Commands, replies: () => Promise<unknown[]>, answer: (r: unknown[]) => unknown[]) =>
    commands.length === 2 && commands.every((c) => c[0] === "GET") && String(commands[0][1]).startsWith("nl:auth:session:") ? answer(await replies()) : undefined;
  const thrown = async (work: () => Promise<unknown>) => work().then((value) => ({ value }), (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : String(error)));
  is("control: the mark is read", await sessionMark(session, MATE), "passkey:cred-exact-1");
  is("control: a live second step, and the team's door is open", [await liveSecondStep(MATE, session), await teamTwoStepBlocks(shop, MATE, "editor", session)], ["passkey", false]);
  is("one reply more: unknown, never a mark", await bent((c, r) => marks(c, r, (x) => [...x, "extra"]), () => thrown(() => sessionMark(session, MATE))), "unknown");
  is("one reply less: unknown", await bent((c, r) => marks(c, r, (x) => x.slice(0, 1)), () => thrown(() => sessionMark(session, MATE))), "unknown");
  is("a mark of another kind: unknown", await bent((c, r) => marks(c, r, (x) => [x[0], 7]), () => thrown(() => sessionMark(session, MATE))), "unknown");
  is("one reply more: no live second step", await bent((c, r) => marks(c, r, (x) => [...x, "extra"]), () => thrown(() => liveSecondStep(MATE, session))), "unknown");
  is("one reply more: the team's door stays shut", await bent((c, r) => marks(c, r, (x) => [...x, "extra"]), () => teamTwoStepBlocks(shop, MATE, "editor", session)), true);
  is("control: a session that is gone has no mark", await sessionMark("f".repeat(64), MATE), null);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
