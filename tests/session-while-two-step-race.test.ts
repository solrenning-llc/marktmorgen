/**
 * A session opened without a second step stays a decision of the moment it opens (#3947, #4032, Codex G). The
 * emailed link (lib/signin-finish.ts) and a team invitation (app/api/auth/join/route.ts) both read "no two-step
 * login" (and, for the invitation, "no account") and only then open the session; two-step login turned on in another
 * browser in between used to leave a full session with no code asked. Here the stand-in Redis holds the session's
 * own write until the app is turned on by the real setup (startSetup, finishSetup), which is exactly the late
 * interleaving: the route then must take its session back and answer as for an account with the app.
 * Controls: no change in between still opens the session; an app already on still asks for its code.
 * Synthetic records; no email leaves (Resend is a stand-in, with a key literal of tests/resend-fixture-credentials.ts).
 */
import { NextRequest } from "next/server";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { finishSetup, holdSignIn, sendRescue, startSetup, TWO_STEP_COOKIE, twoStepOn } from "@/lib/two-step";
import { keepRecoveryAddress, sendLostEmailLink } from "@/lib/recovery-address";
import { POST as lostConfirm } from "@/app/api/auth/lost/confirm/route";
import { POST as rescueRoute } from "@/app/api/auth/rescue/route";
import { SESSION_COOKIE } from "@/lib/auth";
import { finishProvenSignIn } from "@/lib/signin-finish";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { inviteMember, readTeam } from "@/lib/team";
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

const codeTo = (to: string) => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
const nowCode = (secret: string) => codeAt(base32Decode(secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS));

/** Two-step login turned on for an address by the real setup, as another browser of the same person would. */
async function turnOn(email: string, backup: string, session: string): Promise<void> {
  const started = await startSetup(email, session, backup);
  if (typeof started === "string") throw new Error(`setup: ${started}`);
  const finished = await finishSetup(email, session, nowCode(started.secret), codeTo(backup));
  if (typeof finished === "string") throw new Error(`finish: ${finished}`);
}

const SESSION_KEY = /^nl:auth:session:[0-9a-f]{40}$/;

/** Sessions the stand-in holds for an address, read from the store itself. */
function sessionsOf(email: string): number {
  const [, keys] = redis.run(["SCAN", 0, "MATCH", "nl:auth:session:*", "COUNT", 1_000_000]) as [string, string[]];
  return keys.filter((key) => SESSION_KEY.test(key) && redis.run(["GET", key]) === email).length;
}

/**
 * Runs `meanwhile` once, just before the first write of a new session (the `SET nl:auth:session:…` of openSession):
 * after every read the route decided on, before the session exists.
 */
function beforeSessionOpens(meanwhile: () => Promise<void>): () => boolean {
  const original = redis.pipeline.bind(redis);
  let fired = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!fired && commands.some((c) => c[0] === "SET" && typeof c[1] === "string" && SESSION_KEY.test(c[1]))) {
      fired = true;
      redis.pipeline = original as typeof redis.pipeline;
      await meanwhile();
    }
    return original(commands);
  }) as typeof redis.pipeline;
  return () => {
    redis.pipeline = original as typeof redis.pipeline;
    return fired;
  };
}

/** Makes the first pipeline after the session's write throw, once: the read done once the session is open fails. */
function failReadAfterOpen(): () => boolean {
  const original = redis.pipeline.bind(redis);
  let opened = false;
  let failed = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (opened && !failed) {
      failed = true;
      redis.pipeline = original as typeof redis.pipeline;
      throw new Error("Redis stand-in: unavailable");
    }
    if (commands.some((c) => c[0] === "SET" && typeof c[1] === "string" && SESSION_KEY.test(c[1]))) opened = true;
    return original(commands);
  }) as typeof redis.pipeline;
  return () => {
    redis.pipeline = original as typeof redis.pipeline;
    return failed;
  };
}

const cookieSet = (response: Response, name: string) =>
  (response.headers.getSetCookie?.() ?? []).some((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`));
const where = (response: Response) => new URL(response.headers.get("location") ?? "https://x.invalid/");

async function main(): Promise<void> {
  redis.clear();
  const linkRequest = () => new NextRequest("https://marktmorgen.com/api/auth/callback", { method: "POST" });

  part("The emailed link (#4032): control, nothing changes in between");
  const CALM = "calm@race.example";
  const calm = await finishProvenSignIn(linkRequest(), CALM, "link", "/studio");
  is("a session opens", [where(calm).pathname, cookieSet(calm, SESSION_COOKIE), sessionsOf(CALM)], ["/studio", true, 1]);

  part("The emailed link: two-step login turned on after the decision, before the session's write");
  const RACED = "raced@race.example";
  const release = beforeSessionOpens(() => turnOn(RACED, "raced.backup@race.example", "a".repeat(64)));
  const raced = await finishProvenSignIn(linkRequest(), RACED, "link", "/studio");
  is("the app was turned on in between", release(), true);
  is("no session cookie; the login waits for the app's code", [where(raced).pathname, cookieSet(raced, SESSION_COOKIE), cookieSet(raced, TWO_STEP_COOKIE)], ["/signin/code", false, true]);
  is("the session opened too late was taken back", sessionsOf(RACED), 0);

  part("The emailed link: control, an app already on asks for its code");
  const on = await finishProvenSignIn(linkRequest(), RACED, "google", "/studio");
  is("to the code, with no session", [where(on).pathname, cookieSet(on, SESSION_COOKIE), sessionsOf(RACED)], ["/signin/code", false, 0]);

  part("The emailed link: the read after opening fails");
  const UNREAD = "unread@race.example";
  const restore = failReadAfterOpen();
  const unread = await finishProvenSignIn(linkRequest(), UNREAD, "link", "/studio");
  is("the read failed", restore(), true);
  is("no session cookie, and none left", [cookieSet(unread, SESSION_COOKIE), sessionsOf(UNREAD)], [false, 0]);

  part("A team invitation (#3947)");
  const CREATOR = "creator@race.example";
  await claimHandle(CREATOR, "race-two-step", "Race Two Step", "");
  await ensureStatsId(CREATOR);
  await ensureStoreId(CREATOR);
  await ensureListId(CREATOR);
  await setStripeAccount(CREATOR, "acct_1RaceTwoStepXXX", true);
  await setSubscription(CREATOR, { customerId: "cus_racetwostep", subscriptionId: "sub_racetwostep", active: true, tier: "creator", period: paidPeriod() });
  const shop = (await storeForEmail(CREATOR))!;
  let ip = 0;
  const tokenTo = (to: string) => /\/signin\/join\?token=([0-9a-f]{64})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
  const take = async (email: string) => {
    const invited = await inviteMember(shop, email, "editor", "https://marktmorgen.com");
    if (!invited.ok) throw new Error(`no invitation for ${email}`);
    ip += 1;
    return join_(
      new NextRequest("https://marktmorgen.com/api/auth/join", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `203.0.113.${ip}` },
        body: new URLSearchParams({ token: tokenTo(email) }),
      }),
    );
  };
  const onTeam = async (email: string) => (await readTeam(shop.sid)).members.some((m) => m.email === email);

  const NEWCOMER = "newcomer@race.example";
  const newcomer = await take(NEWCOMER);
  is("control: an address with no account is logged in by the tap", [where(newcomer).searchParams.get("team"), cookieSet(newcomer, SESSION_COOKIE), sessionsOf(NEWCOMER)], ["joined", true, 1]);

  const HELPER = "helper@race.example";
  const stop = beforeSessionOpens(() => turnOn(HELPER, "helper.backup@race.example", "b".repeat(64)));
  const helper = await take(HELPER);
  is("the app was turned on in between", stop(), true);
  is("on the team, sent to log in the usual way, no session", [where(helper).searchParams.get("status"), cookieSet(helper, SESSION_COOKIE), sessionsOf(HELPER), await onTeam(HELPER)], ["invite-joined", false, 0, true]);

  const OWNER = "owner@race.example";
  const own = beforeSessionOpens(async () => {
    await claimHandle(OWNER, "race-own-store", "Race Own Store", "");
  });
  const owner = await take(OWNER);
  is("a store of its own made in between", own(), true);
  is("on the team, sent to log in the usual way, no session", [where(owner).searchParams.get("status"), cookieSet(owner, SESSION_COOKIE), sessionsOf(OWNER), await onTeam(OWNER)], ["invite-joined", false, 0, true]);

  const SHAKY = "shaky@race.example";
  const shaky = failReadAfterOpen();
  const unknown = await take(SHAKY);
  is("the read after opening failed", shaky(), true);
  is("an error page, no session cookie, and none left", [where(unknown).searchParams.get("status"), cookieSet(unknown, SESSION_COOKIE), sessionsOf(SHAKY)], ["invite-error", false, 0]);

  part("The recovery address's lost-inbox link (#4085)");
  const tokenIn = (to: string, pattern: RegExp) => pattern.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
  const form = (url: string, token: string) =>
    new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `198.51.100.${++ip}` }, body: new URLSearchParams({ token }) });
  const lostLink = async (email: string, backup: string) => {
    await sendLostEmailLink(email, `192.0.2.${++ip}`, "https://marktmorgen.com");
    return tokenIn(backup, /signin\/lost\/confirm\?token=([0-9a-f]{64})/);
  };
  const LOST_CALM = "lost.calm@race.example";
  await keepRecoveryAddress(LOST_CALM, "lost.calm.backup@race.example");
  const lostCalm = await lostConfirm(form("https://marktmorgen.com/api/auth/lost/confirm", await lostLink(LOST_CALM, "lost.calm.backup@race.example")));
  is("control: the link opens a (locked) session", [where(lostCalm).pathname, cookieSet(lostCalm, SESSION_COOKIE), sessionsOf(LOST_CALM)], ["/studio", true, 1]);
  const LOST = "lost@race.example";
  await keepRecoveryAddress(LOST, "lost.backup@race.example");
  const lostToken = await lostLink(LOST, "lost.backup@race.example");
  const lostStop = beforeSessionOpens(() => turnOn(LOST, "lost.backup@race.example", "d".repeat(64)));
  const lost = await lostConfirm(form("https://marktmorgen.com/api/auth/lost/confirm", lostToken));
  is("the app was turned on in between", lostStop(), true);
  is("no session; the login waits for the app's code", [where(lost).pathname, cookieSet(lost, SESSION_COOKIE), cookieSet(lost, TWO_STEP_COOKIE), sessionsOf(LOST)], ["/signin/code", false, true, 0]);

  part("The rescue link, two-step login turned on again meanwhile (#4142)");
  const rescueLink = async (email: string, backup: string, session: string) => {
    await turnOn(email, backup, session);
    if ((await sendRescue(await holdSignIn(email), "https://marktmorgen.com")) !== "sent") throw new Error("no rescue link");
    return tokenIn(backup, /signin\/rescue\?token=([0-9a-f]{64})/);
  };
  const RESCUE_CALM = "rescue.calm@race.example";
  const calmRescue = await rescueRoute(form("https://marktmorgen.com/api/auth/rescue", await rescueLink(RESCUE_CALM, "rescue.calm.backup@race.example", "e".repeat(64))));
  is("control: the link turns two-step login off and opens a session", [where(calmRescue).pathname, cookieSet(calmRescue, SESSION_COOKIE), await twoStepOn(RESCUE_CALM)], ["/studio", true, false]);
  const RESCUE = "rescue@race.example";
  const rescueToken = await rescueLink(RESCUE, "rescue.backup@race.example", "f".repeat(64));
  const again = beforeSessionOpens(() => turnOn(RESCUE, "rescue.backup@race.example", "9".repeat(64)));
  const rescued = await rescueRoute(form("https://marktmorgen.com/api/auth/rescue", rescueToken));
  is("the app was turned on again in between", [again(), await twoStepOn(RESCUE)], [true, true]);
  is("no session; the login waits for the new app's code", [where(rescued).pathname, cookieSet(rescued, SESSION_COOKIE), cookieSet(rescued, TWO_STEP_COOKIE), sessionsOf(RESCUE)], ["/signin/code", false, true, 0]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
