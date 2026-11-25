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
 *
 * Review of #4491 (Claude 5, security): the Redis call right after an unconfirmed logout fails too (clearing the
 * confirmed ones' locks throws, or reading the list throws), and the account's mark ("<set>:kept") answers in another
 * shape or throws. The reset day is called off first, so each of these set the locked sessions free on their day, or
 * told the owner they stay locked when nothing kept them so.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { emailForSession, openSession, sessionKeyOf } from "@/lib/auth";
import { POST as twoStepRoute } from "@/app/api/auth/two-step/route";
import * as manager from "@/components/two-step-manager";
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

  // Review of #4491 (Claude 5, security): the Redis call right after a logout that was not confirmed fails too, as it
  // does when Redis itself is failing (endSession answers false only then). The reset day is called off already, so
  // whatever throws before the account is marked would set the locked sessions free on their day.
  const fail = () => {
    throw new Error("Redis request failed with status 503");
  };
  /** Answers each pipeline with `answer` when it gives one, else as Redis would. */
  const intercept = (answer: (commands: Command[]) => unknown[] | undefined) => {
    redis.pipeline = (async (commands: Command[]) => answer(commands) ?? real(commands)) as typeof redis.pipeline;
  };
  const isKeptSet = (command: Command | undefined) => command?.[0] === "SET" && String(command[1]).endsWith(":kept");
  async function twoLocked(tag: string) {
    const OWNER = `le-${tag}@example.com`;
    await turnOnApp(OWNER, tag.padEnd(64, "0").slice(0, 64), `le-${tag}-backup@example.org`);
    const a = await enterLocked(await holdSignIn(OWNER));
    const b = await enterLocked(await holdSignIn(OWNER));
    if (!a || !b) throw new Error("not let in");
    return { OWNER, a: a.session, b: b.session, keyA: await sessionKeyOf(a.session) };
  }
  async function cancelled(OWNER: string): Promise<unknown> {
    try {
      return await cancelReset(OWNER, "studio");
    } catch (error) {
      return `threw: ${String((error as Error)?.message ?? error)}`;
    } finally {
      restore();
    }
  }
  const pastDay = () => Date.now() + (RESET_DAYS + 1) * 86_400_000;

  part("Review of #4491: A's logout is not confirmed and clearing B's lock throws");
  {
    const { OWNER, a, b, keyA } = await twoLocked("c1");
    intercept((commands) => {
      if (commands[0]?.[0] === "DEL" && commands[0][1] === keyA) return commands.map(() => null);
      if (commands.length === 2 && commands[0]?.[0] === "DEL" && commands[1]?.[0] === "SREM") fail();
      return undefined;
    });
    const ended = await cancelled(OWNER);
    is("kept locked, and said so", [ended, lastTo(OWNER).includes("were logged out")], ["kept-locked", false]);
    is("A is still open, B is logged out", [(await emailForSession(a)) !== null, await emailForSession(b)], [true, null]);
    is("A is still locked once the reset day is past", (await lockedUntil(a, pastDay())) > 0, true);
  }

  part("Review of #4491: reading the account's locked sessions throws");
  {
    const { OWNER, a } = await twoLocked("c2");
    intercept((commands) => (commands[0]?.[0] === "SMEMBERS" ? fail() : undefined));
    const ended = await cancelled(OWNER);
    is("kept locked, and said so", [ended, lastTo(OWNER).includes("were logged out")], ["kept-locked", false]);
    is("A is still open", (await emailForSession(a)) !== null, true);
    is("A is still locked once the reset day is past", (await lockedUntil(a, pastDay())) > 0, true);
  }

  part("Review of #4491: the account's mark answers in another shape once, and is written again");
  {
    const { OWNER, a, keyA } = await twoLocked("c3");
    let marks = 0;
    intercept((commands) => {
      if (commands[0]?.[0] === "DEL" && commands[0][1] === keyA) return commands.map(() => null);
      if (isKeptSet(commands[0]) && (marks += 1) === 1) return [null, 1, 1];
      return undefined;
    });
    const ended = await cancelled(OWNER);
    is("kept locked, and said so", [ended, lastTo(OWNER).includes("stay locked")], ["kept-locked", true]);
    is("A is still locked once the reset day is past", (await lockedUntil(a, pastDay())) > 0, true);
  }

  part("Review of #4491: the account's mark is never confirmed: never said to stay locked");
  {
    const { OWNER, a, keyA } = await twoLocked("c4");
    intercept((commands) => {
      if (commands[0]?.[0] === "DEL" && commands[0][1] === keyA) return commands.map(() => null);
      if (isKeptSet(commands[0])) return commands.map((command) => (isKeptSet(command) ? null : 1));
      return undefined;
    });
    const ended = await cancelled(OWNER);
    const told = lastTo(OWNER);
    is("not kept, and said so", [ended, told.includes("were logged out"), told.includes("stay locked"), told.includes("Log out of all devices"), told.includes("canceled from your studio")], ["not-kept", false, false, true, true]);
    is("A is still open", (await emailForSession(a)) !== null, true);
  }

  part("Review of #4491: the account's mark throws: never said to stay locked");
  {
    const { OWNER, keyA } = await twoLocked("c5");
    intercept((commands) => {
      if (commands[0]?.[0] === "DEL" && commands[0][1] === keyA) return commands.map(() => null);
      if (isKeptSet(commands[0])) fail();
      return undefined;
    });
    const ended = await cancelled(OWNER);
    const told = lastTo(OWNER);
    is("not kept, and said so", [ended, told.includes("were logged out"), told.includes("stay locked"), told.includes("Log out of all devices"), told.includes("canceled from your studio")], ["not-kept", false, false, true, true]);
  }

  part("Review of #4491: Cancel in the studio when the account's mark is never confirmed");
  {
    const { OWNER, keyA } = await twoLocked("c6");
    const ownerBrowser = await openSession(OWNER, "app");
    intercept((commands) => {
      if (commands[0]?.[0] === "DEL" && commands[0][1] === keyA) return commands.map(() => null);
      if (isKeptSet(commands[0])) return commands.map((command) => (isKeptSet(command) ? null : 1));
      return undefined;
    });
    let answer: unknown;
    try {
      const request = new NextRequest("https://marktmorgen.com/api/auth/two-step", {
        method: "POST",
        headers: { "content-type": "application/json", host: "marktmorgen.com", origin: "https://marktmorgen.com", cookie: `nl_session=${ownerBrowser}` },
        body: JSON.stringify({ action: "cancel" }),
      });
      answer = await (await twoStepRoute(request)).json();
    } finally {
      restore();
    }
    is("the studio is told they were neither logged out nor kept locked", answer, { ok: true, loggedOut: false, locked: false });
    const said = (manager as Record<string, unknown>).CANCEL_NOT_LOCKED;
    const source = readFileSync("components/two-step-manager.tsx", "utf8");
    is(
      "and says so inline, without saying they stay locked",
      [typeof said === "string" && said.includes("could not be logged out just now") && !said.includes("stay locked"), source.includes("if (answer.locked === false) setError(CANCEL_NOT_LOCKED);")],
      [true, true],
    );
  }

  console.error = quiet;
  done();
}

main().catch((error) => {
  console.log(String((error as Error)?.stack ?? error));
  process.exitCode = 1;
});
