/**
 * Review of #2556 at df8030300 (delta from 47161b86e).
 *   1  lib/two-step.ts lockedUntil: once ANY account's locked sessions were kept locked (KEPT_ANY_KEY, up to
 *      31 days), every session of every account without a lock of its own pays emailForSession and three more
 *      commands on each call (the studio page calls it on every load), counted nowhere.
 *   3  lib/two-step.ts moveTwoStep: the new address's sessions unread refuse the move, and the person is told
 *      the new address has its own passkeys or two-step login, which it has not.
 * Synthetic only.
 */
import { NextRequest } from "next/server";
import { openSession, sendMoveLink } from "@/lib/auth";
import { POST as moveRoute } from "@/app/api/auth/move/route";
import { claimHandle } from "@/lib/store";
import { cancelReset, enterLocked, finishSetup, holdSignIn, lockedUntil, startSetup, twoStepOn } from "@/lib/two-step";
import { listPasskeys } from "@/lib/passkeys";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { store as redis } from "./redis-stub";
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

  part("1: what lockedUntil costs a session of another account once any account's locked sessions were kept locked");
  const OTHER = "d2-other@example.com";
  const plain = await openSession(OTHER);
  let counted = 0;
  const counting = async (commands: Command[]) => {
    counted += commands.length;
    return real(commands);
  };
  redis.pipeline = counting;
  await lockedUntil(plain);
  restore();
  const before = counted;
  const LOST = "d2-lost@example.com";
  await turnOnApp(LOST, "e".repeat(64), "d2-lost-backup@example.org");
  const entered = await enterLocked(await holdSignIn(LOST));
  if (!entered) throw new Error("not let in");
  malform(on("SMEMBERS", "nl:2fa:lockedset:"), null);
  await cancelReset(LOST, "studio");
  restore();
  counted = 0;
  redis.pipeline = counting;
  is("(not locked)", await lockedUntil(plain), 0);
  restore();
  is("commands for an unrelated account's session, before and after (the studio page calls it on every load)", [before, counted], [before, before]);

  part("3: a move refused because the new address's sessions could not be read is never said as the address having its own login");
  const FROM = "d2-from@example.com";
  const TO = "d2-to@example.com";
  await claimHandle(FROM, "d2-from", "D2", "");
  const asker = "a".repeat(64);
  await turnOnApp(FROM, asker, "d2-from-backup@example.org");
  const session = await openSession(FROM, "app");
  mails.length = 0;
  await sendMoveLink(FROM, TO, ORIGIN, session);
  const token = /confirm-move\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === TO)?.text ?? "")?.[1] ?? "";
  malform(on("SMEMBERS", "nl:auth:sessions:"), { 0: "x" });
  const moved = (await moveRoute(form(`${ORIGIN}/api/auth/move`, { token }))).headers.get("location") ?? "";
  restore();
  is("(the new address holds no way in of its own)", [await twoStepOn(TO), (await listPasskeys(TO)).length], [false, 0]);
  is("not answered as move-has-login", moved.endsWith("move-has-login") ? "move-has-login" : "other", "other");
  done();
}

main().catch((error) => {
  console.log(String((error as Error)?.stack ?? error));
  process.exitCode = 1;
});
