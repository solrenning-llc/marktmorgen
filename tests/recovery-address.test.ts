/**
 * Losing the inbox one logs in with (lib/recovery-address.ts, added
 * 13 October 2026). Checked:
 *
 *   - a recovery address is kept only once a code sent to it is typed, and
 *     never the sign-in address itself;
 *   - asking from /signin/lost answers the same for an address with no
 *     account, and emails nobody then;
 *   - for an account with one, a link goes to the recovery address and the
 *     sign-in address is told;
 *   - the link lets them in at once, with what matters locked for a week;
 *   - logging in with the sign-in inbox ends that, logging the locked session out;
 *   - once the week has passed unanswered, the recovery address opens everything;
 *   - with two-step login on, the link leads to the code page, which cannot
 *     send it to the recovery address again, and a right code opens everything;
 *   - moving the sign-in address carries the recovery address.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { emailForSession } from "@/lib/auth";
import { studioAccess } from "@/lib/studio-route";
import { LOCK_DAYS, confirmRecoveryAddress, keepRecoveryAddress, moveRecoveryAddress, recoveryAddress, recoveryLockUntil, sendLostEmailLink, startRecoveryAddress } from "@/lib/recovery-address";
import { finishSetup, lockedUntil, startSetup } from "@/lib/two-step";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { POST as lostRoute } from "@/app/api/auth/lost/route";
import { POST as lostConfirm } from "@/app/api/auth/lost/confirm/route";
import { POST as callback } from "@/app/api/auth/callback/route";
import { POST as codeRoute } from "@/app/api/auth/code/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";
const mails: { to: string; text: string; subject: string }[] = [];
const acceptedMails: { to: string; text: string; subject: string }[] = [];
let recoveryResponse: { to: string; kind: "refused" | "unknown" } | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string; subject?: string };
    const message = { to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? ""), subject: String(body.subject ?? "") };
    mails.push(message);
    if (recoveryResponse?.to === message.to) {
      if (recoveryResponse.kind === "refused") return new Response("{}", { status: 400 });
      throw new Error("Synthetic recovery POST response lost after possible acceptance");
    }
    acceptedMails.push(message);
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const lastTo = (to: string) => [...mails].reverse().find((m) => m.to === to)?.text ?? "";
const codeTo = (to: string) => /Your code: (\d{6})/.exec(lastTo(to))?.[1] ?? "";
const linkTo = (to: string) => /signin\/lost\/confirm\?token=([0-9a-f]{64})/.exec(lastTo(to))?.[1] ?? "";
const post = (url: string, fields: Record<string, string>, cookie = "") =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields) });
const cookieOf = (response: Response, name: string) => (response.headers.get("set-cookie") ?? "").match(new RegExp(`${name}=([^;]*)`))?.[1] ?? "";
async function linkFor(email: string): Promise<string> {
  const token = createHash("sha256").update(String(Math.random())).digest("hex");
  await redis.pipeline([["SET", `nl:auth:link:${createHash("sha256").update(`nimbus-auth-link:${token}`).digest("hex").slice(0, 40)}`, email, "EX", 900]]);
  return token;
}

const ME = "maker@example.com";
const SESSION = "c".repeat(64);

async function main(): Promise<void> {
  redis.clear();

  part("Setting it");
  is("not the sign-in address itself", await startRecoveryAddress(ME, SESSION, "Maker@example.com"), "same");
  is("a code goes to it", [await startRecoveryAddress(ME, SESSION, "spare@example.org"), codeTo("spare@example.org").length], ["sent", 6]);
  is("a wrong code keeps nothing", [await confirmRecoveryAddress(ME, SESSION, "000000" === codeTo("spare@example.org") ? "111111" : "000000"), await recoveryAddress(ME)], ["wrong", ""]);
  is("the right one keeps it", [await confirmRecoveryAddress(ME, SESSION, codeTo("spare@example.org")), await recoveryAddress(ME)], [{ address: "spare@example.org" }, "spare@example.org"]);

  part("Asking for a way in");
  const before = mails.length;
  const nobody = await lostRoute(post("https://marktmorgen.com/api/auth/lost", { email: "nobody@example.com" }));
  is("an address with no account: the same answer, and nobody emailed", [nobody.headers.get("location"), mails.length], ["https://marktmorgen.com/signin/lost?status=sent", before]);
  const asked = await lostRoute(post("https://marktmorgen.com/api/auth/lost", { email: ME }));
  is("an account with one: the link goes to the recovery address, and the sign-in address is told", [asked.headers.get("location"), linkTo("spare@example.org").length, lastTo(ME).includes("recovery address")], ["https://marktmorgen.com/signin/lost?status=sent", 64, true]);

  part("In at once, with what matters locked");
  const entered = await lostConfirm(post("https://marktmorgen.com/api/auth/lost/confirm", { token: linkTo("spare@example.org") }));
  const session = cookieOf(entered, "nl_session");
  is("in, at the studio", [entered.headers.get("location"), await emailForSession(session)], ["https://marktmorgen.com/studio", ME]);
  is("locked for a week", Math.round(((await lockedUntil(session)) - Date.now()) / 86_400_000), LOCK_DAYS);
  const access = async (need: string) => {
    const answer = await studioAccess(new NextRequest("https://marktmorgen.com/api/store/x", { method: "POST", headers: { cookie: `nl_session=${session}` } }), need as never);
    return answer.ok ? "open" : (answer as { reason: string }).reason;
  };
  is("exports and payments wait; products do not", [await access("export"), await access("payments"), (await access("products")) !== "locked"], ["locked", "locked", true]);
  is("the link works once", (await lostConfirm(post("https://marktmorgen.com/api/auth/lost/confirm", { token: linkTo("spare@example.org") }))).headers.get("location"), "https://marktmorgen.com/signin?status=expired");

  part("The sign-in inbox answers");
  await callback(post("https://marktmorgen.com/api/auth/callback", { token: await linkFor(ME) }));
  is("logging in with it logs the locked session out", await emailForSession(session), null);
  is("and the next recovery login starts a new week", Math.round(((await recoveryLockUntil(ME)) - Date.now()) / 86_400_000), LOCK_DAYS);

  part("A week unanswered");
  const set = await recoveryLockUntil(ME);
  is("still locked a day before", await recoveryLockUntil(ME, set - 86_400_000), set);
  is("after it, the recovery address opens everything", await recoveryLockUntil(ME, set + 1), 0);

  part("With two-step login on");
  const TWO = "two@example.com";
  const started = await startSetup(TWO, SESSION, "two.spare@example.org");
  if (typeof started === "string") throw new Error(started);
  const backupCode = codeTo("two.spare@example.org");
  const setUp = await finishSetup(TWO, SESSION, codeAt(base32Decode(started.secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS)), backupCode);
  if (typeof setUp === "string") throw new Error(setUp);
  is("the address confirmed while turning it on is the account's recovery address", await recoveryAddress(TWO), "two.spare@example.org");
  await lostRoute(post("https://marktmorgen.com/api/auth/lost", { email: TWO }));
  const held = await lostConfirm(post("https://marktmorgen.com/api/auth/lost/confirm", { token: linkTo("two.spare@example.org") }));
  const hold = cookieOf(held, "nl_2fa");
  is("the link leads to the code page", [held.headers.get("location"), hold.length], ["https://marktmorgen.com/signin/code", 64]);
  const again = await codeRoute(post("https://marktmorgen.com/api/auth/code", { action: "rescue" }, `nl_2fa=${hold}`));
  is("which cannot send it to the recovery address again", again.headers.get("location"), "https://marktmorgen.com/signin/code?status=rescue-none");
  const next = codeAt(base32Decode(started.secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS) + 1);
  const full = await codeRoute(post("https://marktmorgen.com/api/auth/code", { code: next }, `nl_2fa=${hold}`));
  is("and a right code opens everything", [full.headers.get("location"), await lockedUntil(cookieOf(full, "nl_session"))], ["https://marktmorgen.com/studio", 0]);

  part("Moving the sign-in address");
  await moveRecoveryAddress(ME, "new@example.com");
  is("the recovery address goes with it", [await recoveryAddress(ME), await recoveryAddress("new@example.com")], ["", "spare@example.org"]);
  await moveRecoveryAddress("new@example.com", "spare@example.org");
  is("moved onto the recovery address itself, there is none left", await recoveryAddress("spare@example.org"), "");

  part("The security warning tells only what the sender confirmed");
  // The official test transport uses the REAL guard with a synthetic review,
  // usage response and budget ACK adapter. These are provider HTTP outcomes,
  // not an alias of sendEmail or a proof of the budget Lua.
  for (const outcome of ["accepted", "refused", "unknown"] as const) {
    redis.clear();
    mails.length = 0;
    acceptedMails.length = 0;
    const owner = `${outcome}.owner@example.test`;
    const backup = `${outcome}.backup@example.test`;
    await keepRecoveryAddress(owner, backup);
    recoveryResponse = outcome === "accepted" ? null : { to: backup, kind: outcome };
    const commands: (string | number)[][] = [];
    const pipeline = redis.pipeline.bind(redis);
    redis.pipeline = async batch => {
      commands.push(...batch.map(command => [...command]));
      return pipeline(batch);
    };
    let answer: void;
    try {
      answer = await sendLostEmailLink(owner, "192.0.2.73", "https://marktmorgen.com");
    } finally {
      redis.pipeline = pipeline;
      recoveryResponse = null;
    }
    is(`${outcome}: no result exposes the account or provider outcome`, answer, undefined);
    is(`${outcome}: one recovery POST and one security warning, without retries`, mails.map(message => message.to), [backup, owner]);
    is(`${outcome}: both existing subjects stay unchanged`, mails.map(message => message.subject), ["Get back into your Marktmorgen account", "Somebody asked to log in to your Marktmorgen account through its recovery address"]);
    is(`${outcome}: the warning is accepted even when recovery acceptance is unknown`, acceptedMails.map(message => message.to), outcome === "accepted" ? [backup, owner] : [owner]);
    const warning = acceptedMails.find(message => message.to === owner)?.text ?? "";
    const warningTime = /When: ([^\n]+) UTC/.exec(warning)?.[1] ?? "";
    is(`${outcome}: the existing UTC warning time stays present`, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(warningTime), true);
    const hidden = `${backup[0]}•••@e•••.test`;
    is(`${outcome}: exact security message, with the old accepted text unchanged`, warning, [
      outcome === "accepted"
        ? `A link was sent to your recovery address (${hidden}) because somebody said they can no longer open this inbox.`
        : `Somebody asked to log in through your recovery address (${hidden}). We could not confirm that the email link was sent.`,
      "",
      `When: ${warningTime} UTC`,
      "",
      "If this was you, there is nothing to do. If it was not, log in with this inbox or a passkey: that ends anything opened through the recovery address.",
    ].join("\n"));
    const token = linkTo(backup);
    const key = `nl:auth:rec:link:${createHash("sha256").update(`nimbus-rec-link:${token}`).digest("hex").slice(0, 40)}`;
    is(`${outcome}: one original token remains, with its original fifteen-minute TTL`, commands.filter(command => command[0] === "SET" && String(command[1]).startsWith("nl:auth:rec:link:")), [["SET", key, owner, "EX", 900]]);
    is(`${outcome}: no token is deleted or replaced after a refused or uncertain send`, commands.some(command => command[0] === "DEL" || command[0] === "GETDEL"), false);
  }

  done();
}

void main();
