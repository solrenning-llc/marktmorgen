/**
 * Rule 24 (CX-123) in lib/two-step.ts endLocked: when a request to turn off two-step login is called off (a login
 * with the app's code or a passkey, or Cancel), every session let in without the second step is logged out with
 * endSession, and then its lock and the account's list of them are deleted. endSession answers false when the
 * logout is not confirmed (a DEL answering in another shape, or a failure), but that answer was ignored: the lock
 * went anyway, the session stayed open with nothing locked (payments, exports, settings, the team), and the owner
 * was emailed that "the browsers let in without it were logged out". Found by Claude 3 (nuvem C) in the security
 * audit of sign-in, sessions and the team, 11 November 2026.
 *
 * Expected: a session whose logout is not confirmed keeps its lock and its place in the list, the account is kept
 * locked as when the list cannot be read, and the owner is told they could not be logged out ("kept-locked").
 * Controls: when every logout is confirmed, they are logged out and said so, as before.
 * Synthetic only: the Redis stand-in, with one DEL answered in another shape and not applied; a stand-in email provider.
 */
import { emailForSession, sessionKeyOf } from "@/lib/auth";
import { RESET_DAYS, cancelReset, enterLocked, finishSetup, holdSignIn, lockedUntil, startSetup } from "@/lib/two-step";
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
const restore = () => {
  redis.pipeline = real;
};
/** The logout of this one session (endSession's DEL of its key) answers `shape` for each command and changes nothing. */
function logoutAnswers(key: string, shape: unknown): void {
  redis.pipeline = (async (commands: Command[]) => {
    if (commands[0]?.[0] === "DEL" && commands[0][1] === key) return commands.map(() => shape);
    return real(commands);
  }) as typeof redis.pipeline;
}
const codeTo = (to: string) => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
const lastTo = (to: string) => [...mails].reverse().find((m) => m.to === to)?.text ?? "";

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

  part("Control: every logout confirmed");
  {
    const OWNER = "le-ctl@example.com";
    await turnOnApp(OWNER, "a".repeat(64), "le-ctl-backup@example.org");
    const entered = await enterLocked(await holdSignIn(OWNER));
    if (!entered) throw new Error("not let in");
    is("logged out and said so", [await cancelReset(OWNER, "studio"), await emailForSession(entered.session), lastTo(OWNER).includes("were logged out")], [true, null, true]);
  }

  const shapes: [string, unknown][] = [["\"1\"", "1"], ["null", null], ["\"QUEUED\"", "QUEUED"], ["-1", -1]];
  let n = 0;
  for (const [label, shape] of shapes) {
    part(`A locked session's logout answers ${label} and does not land`);
    const OWNER = `le-${(n += 1)}@example.com`;
    await turnOnApp(OWNER, String(n).repeat(64).slice(0, 64), `le-${n}-backup@example.org`);
    const entered = await enterLocked(await holdSignIn(OWNER));
    if (!entered) throw new Error("not let in");
    logoutAnswers(await sessionKeyOf(entered.session), shape);
    let ended: Awaited<ReturnType<typeof cancelReset>>;
    try {
      ended = await cancelReset(OWNER, "studio");
    } finally {
      restore();
    }
    const open = (await emailForSession(entered.session)) !== null;
    is(`${label}: (the session is still open)`, open, true);
    is(`${label}: not said as logged out`, [ended, lastTo(OWNER).includes("were logged out")], ["kept-locked", false]);
    is(`${label}: still locked now`, (await lockedUntil(entered.session)) > Date.now(), true);
    advance((RESET_DAYS + 1) * 86_400_000);
    const later = Date.now() + (RESET_DAYS + 1) * 86_400_000;
    is(`${label}: still locked once the reset day is past`, (await lockedUntil(entered.session, later)) > 0, true);
  }

  console.error = quiet;
  done();
}

main().catch((error) => {
  console.log(String((error as Error)?.stack ?? error));
  process.exitCode = 1;
});
