/**
 * Review of #2556 at 47161b86e (delta from b0af1b663). P1 and P3 pass and
 * document what holds; P2 fails: a locked session written in the format
 * before this change (key lapsing on its day) is set free on day 8 although
 * the email said it stays locked until logged out. Synthetic only.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { emailForSession, openSession, sendMoveLink } from "@/lib/auth";
import { POST as moveRoute } from "@/app/api/auth/move/route";
import { claimHandle, storeForEmail } from "@/lib/store";
import { RESET_DAYS, cancelReset, enterLocked, finishSetup, holdSignIn, lockedUntil, startSetup } from "@/lib/two-step";
import { resolveAccess } from "@/lib/studio-route";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
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

async function turnOnApp(email: string, session: string, backup: string): Promise<void> {
  const setup = await startSetup(email, session, backup);
  if (typeof setup === "string") throw new Error(setup);
  const secret = base32Decode(setup.secret)!;
  const finished = await finishSetup(email, session, codeAt(secret, Math.floor(Date.now() / 1000 / STEP_SECONDS)), codeTo(backup));
  if (typeof finished === "string") throw new Error(finished);
}


async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  const DAY = 86_400_000;
  part("P1: kept: an old locked session stays locked past its day; one opened after the mark is set free on its own day");
  const LOST = "pb-lost@example.com";
  await turnOnApp(LOST, "e".repeat(64), "pb-lost-backup@example.org");
  const first = await enterLocked(await holdSignIn(LOST));
  if (!first) throw new Error("not let in");
  malform(on("SMEMBERS", "nl:2fa:lockedset:"), null);
  // The mark (endLocked) and a session's opening read Date.now(), and advance() moved only the in-memory Redis's
  // clock: in the same millisecond a session is not "opened after" the mark and stays locked (the safe side).
  // Here both read the same simulated clock, so the second session is opened exactly 1 s after the mark.
  advance(0);
  const realNow = Date.now;
  Date.now = () => redis.now();
  const c = await cancelReset(LOST, "studio");
  restore();
  advance(1000);
  const second = await enterLocked(await holdSignIn(LOST));
  if (!second) throw new Error("not let in 2");
  const t8 = Date.now() + (RESET_DAYS + 1) * DAY;
  is("cancel answer", c, "kept-locked");
  is("old one locked on day 8, new one's until", [(await lockedUntil(first.session, t8)) > 0, second.until > Date.now()], [true, true]);
  advance((RESET_DAYS + 1) * DAY);
  is("new one free after its own day (two-step turns off then by design)", await lockedUntil(second.session, t8 + 1000), 0);
  Date.now = realNow;
  advance(25 * DAY);
  const t34 = Date.now() + 34 * DAY;
  is("day 34: old one ended (session gone) or still locked", (await emailForSession(first.session)) === null || (await lockedUntil(first.session, t34)) > 0, true);
  is("(old one's session gone by day 34)", await emailForSession(first.session), null);

  part("P2: a locked key in the format written before this change");
  redis.clear();
  const OLD = "pb-old@example.com";
  await turnOnApp(OLD, "e".repeat(64), "pb-old-backup@example.org");
  const legacy = await enterLocked(await holdSignIn(OLD));
  if (!legacy) throw new Error("x");
  const lk = `nl:2fa:locked:${sha(`nimbus-2fa-locked:${legacy.session}`).slice(0, 40)}`;
  await real([["SET", lk, String(legacy.until), "EX", Math.ceil((legacy.until - Date.now()) / 1000)]]);
  malform(on("SMEMBERS", "nl:2fa:lockedset:"), null);
  await cancelReset(OLD, "studio");
  restore();
  advance((RESET_DAYS + 1) * DAY);
  is("legacy-format session said to stay locked: on day 8 still locked or logged out", (await emailForSession(legacy.session)) === null || (await lockedUntil(legacy.session, Date.now() + (RESET_DAYS + 1) * DAY)) > 0, true);

  part("P3: after a move with sessions unread, what the old address's session opens");
  redis.clear();
  const FROM = "pb-from@example.com";
  const TO = "pb-to@example.com";
  await claimHandle(FROM, "pb-from", "Pb", "");
  const asker = await openSession(FROM);
  const stray = await openSession(FROM);
  const before = await openSession(TO);
  mails.length = 0;
  await sendMoveLink(FROM, TO, ORIGIN, asker);
  const token = /confirm-move\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === TO)?.text ?? "")?.[1] ?? "";
  malform(on("SMEMBERS", "nl:auth:sessions:"), { 0: "x" });
  const moved = (await moveRoute(form(`${ORIGIN}/api/auth/move`, { token }))).headers.get("location") ?? "";
  restore();
  const store = await storeForEmail(TO);
  const fromAccess = await resolveAccess(FROM, { pinned: store?.sid ?? "" }, null);
  const fromAny = await resolveAccess(FROM, {}, null);
  const toAccess = await resolveAccess(TO, {}, null);
  is("moved, said open", moved.endsWith("address=moved-sessions-open"), true);
  is("old session alive", await emailForSession(stray), FROM);
  is("old address opens the moved store pinned / any", [fromAccess.ok ? "ok" : fromAccess.reason, fromAny.ok ? "ok" : fromAny.reason], ["gone", "no_store"]);
  is("pre-move session at the new address opens it", [await emailForSession(before), toAccess.ok ? toAccess.access.role : toAccess.reason], [TO, "owner"]);
  done();
}

main().catch((error) => {
  console.log(String((error as Error)?.stack ?? error));
  process.exitCode = 1;
});
