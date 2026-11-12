/**
 * Independent review of PR #2556 (audit SG2): paths where a session that
 * should be logged out stays open while what the person is told says
 * otherwise, or where the logout runs although the request was not kept.
 *
 *   A  app/api/auth/move/route.ts: a successful move ignores endAllSessions()
 *      answering null (unknown) for the old and the new address, and the
 *      studio then says "Every session the old one had open is closed."
 *   B  lib/two-step.ts cancelReset / STILL_LOCKED: the email says the
 *      sessions "stay locked", but the lock is only a key that lapses on the
 *      reset day, while the session lasts 30 days; nothing tries again.
 *   C  lib/two-step.ts resetIfDue (dropAppSessions): an "app" mark left on
 *      an unread session holds again as soon as an app is turned on again.
 *   D  lib/passkeys.ts scheduleRemoval: the logout now runs before the
 *      removal is written; a lock lost in between logs the owner's passkey
 *      sessions out with no removal kept and no email.
 *
 * Synthetic only: the Redis stand-in with one reply made malformed, a fetch
 * stub for the email provider.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { emailForSession, openSession, sendMoveLink } from "@/lib/auth";
import { POST as moveRoute } from "@/app/api/auth/move/route";
import { claimHandle, storeForEmail } from "@/lib/store";
import { RESET_DAYS, cancelReset, enterLocked, finishSetup, holdSignIn, lockedUntil, resetIfDue, startSetup } from "@/lib/two-step";
import { liveSecondStep } from "@/lib/second-step-gate";
import { pendingNow, scheduleRemoval } from "@/lib/passkeys";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { makePasskey } from "./passkey-world";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_reset_notices_only_a_stand_in";
type Mail = { to: string; subject: string; text: string };
const mails: Mail[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), subject: String(body.subject ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
function malform(match: (command: Command) => boolean, bad: unknown): void {
  redis.pipeline = async (commands: Command[]) => (await real(commands)).map((reply, i) => (match(commands[i]) ? bad : reply));
}
const restore = () => {
  redis.pipeline = real;
};
const on = (verb: string, prefix: string) => (command: Command) => command[0] === verb && String(command[1]).startsWith(prefix);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ORIGIN = "https://marktmorgen.com";
const form = (url: string, fields: Record<string, string>) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
const codeTo = (to: string) => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
const lastTo = (to: string) => [...mails].reverse().find((m) => m.to === to);

async function turnOnApp(email: string, session: string, backup: string): Promise<void> {
  const setup = await startSetup(email, session, backup);
  if (typeof setup === "string") throw new Error(setup);
  const secret = base32Decode(setup.secret)!;
  const finished = await finishSetup(email, session, codeAt(secret, Math.floor(Date.now() / 1000 / STEP_SECONDS)), codeTo(backup));
  if (typeof finished === "string") throw new Error(finished);
}

async function main(): Promise<void> {
  redis.clear();
  const quiet = console.error;
  console.error = () => {};

  part("A: a move whose sessions could not be read is never said as every session closed");
  const FROM = "rv-from@example.com";
  const TO = "rv-to@example.com";
  await claimHandle(FROM, "rv-from", "Rv", "");
  const asker = await openSession(FROM);
  const stray = await openSession(FROM);
  // A session the new address had open before the move: "nothing opened there earlier stays open into this account".
  const before = await openSession(TO);
  mails.length = 0;
  await sendMoveLink(FROM, TO, ORIGIN, asker);
  const token = /confirm-move\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === TO)?.text ?? "")?.[1] ?? "";
  malform(on("SMEMBERS", "nl:auth:sessions:"), { 0: "x" });
  const moved = (await moveRoute(form(`${ORIGIN}/api/auth/move`, { token }))).headers.get("location") ?? "";
  restore();
  const saidClosed = moved.endsWith("/studio?address=moved");
  is("(the store did move to the new address)", Boolean(await storeForEmail(TO)), true);
  is(
    "said as moved with every old session closed only when the sessions really are closed",
    saidClosed ? [await emailForSession(stray), await emailForSession(before)] : "not said as closed",
    saidClosed ? [null, null] : "not said as closed",
  );

  part("B: Cancel with the locked sessions unread: never told they stay locked past the day the lock lapses");
  const LOST = "rv-lost@example.com";
  const owner = "e".repeat(64);
  await turnOnApp(LOST, owner, "rv-lost-backup@example.org");
  const entered = await enterLocked(await holdSignIn(LOST));
  if (!entered) throw new Error("not let in");
  malform(on("SMEMBERS", "nl:2fa:lockedset:"), null);
  await cancelReset(LOST, "studio");
  restore();
  const told = lastTo(LOST)?.text ?? "";
  is("(the email says they stay locked)", told.includes("stay locked for them"), true);
  // The reset day passes (two-step login stays on: the request was canceled).
  advance((RESET_DAYS + 1) * 86_400_000);
  const later = Date.now() + (RESET_DAYS + 1) * 86_400_000;
  is(
    "a session said to stay locked is still locked, or logged out, once the reset day is past",
    (await emailForSession(entered.session)) === null || (await lockedUntil(entered.session, later)) > 0,
    true,
  );

  part("C: the app turned off with its sessions unread: their mark never holds again for a new app");
  const APP = "rv-app@example.com";
  const setupSession = "f".repeat(64);
  await turnOnApp(APP, setupSession, "rv-app-backup@example.org");
  // A browser that got in with the old phone's code.
  const oldPhone = await openSession(APP, "app");
  const opened = await enterLocked(await holdSignIn(APP));
  if (!opened) throw new Error("not let in");
  malform(on("SMEMBERS", "nl:auth:sessions:"), "x");
  const off = await resetIfDue(APP, Date.now() + (RESET_DAYS + 1) * 86_400_000);
  restore();
  is("(two-step login turned off after the days)", off, true);
  // The owner sets up a new phone.
  await turnOnApp(APP, "9".repeat(64), "rv-app-backup@example.org");
  is("the old phone's browser has no second step with the new app", await liveSecondStep(APP, oldPhone), null);

  part("D: a removal that was not kept never logs the owner's passkey sessions out");
  const PK = "rv-pk@example.com";
  await makePasskey(PK, "cred-rv-p").keep();
  await makePasskey(PK, "cred-rv-q").keep();
  const ownerByP = await openSession(PK, "passkey", "cred-rv-p");
  const byLink = await openSession(PK);
  const lockKey = `nl:pk:lock:${sha(`nimbus-passkey-lock:${PK}`).slice(0, 40)}`;
  // The account's lock lapses (its five seconds) while the sessions are being read: whatever comes after it is fenced off.
  redis.pipeline = async (commands: Command[]) => {
    const replies = await real(commands);
    if (commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:auth:second:"))) await real([["DEL", lockKey]]);
    return replies;
  };
  const asked = await scheduleRemoval(PK, "cred-rv-p", byLink).then(
    (at) => (at === null ? "none" : "set"),
    (error: unknown) => (error instanceof Error ? error.name : "thrown"),
  );
  restore();
  const kept = (await pendingNow(PK))?.ids.includes("cred-rv-p") ?? false;
  is(
    "the passkey's sessions are logged out only when the removal was kept",
    [asked, (await emailForSession(ownerByP)) === null ? "logged out" : "open", kept],
    (await emailForSession(ownerByP)) === null ? [asked, "logged out", true] : [asked, "open", kept],
  );

  console.error = quiet;
  done();
}

main().catch((error) => {
  console.log(String((error as Error)?.stack ?? error));
  process.exitCode = 1;
});
