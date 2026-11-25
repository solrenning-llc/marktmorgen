/**
 * Codex X6's three LOWs on #4491 (focal re-check @768e6afd06, still on @4a7ece9f66), in lib/two-step.ts endLocked
 * and keepLocked, after a request to turn off two-step login is called off:
 *
 * 1. Every logout confirmed: the clean-up deleted the account's whole set of locked sessions. A session let in
 *    without the second step between the set's read (SMEMBERS) and that DEL lost its place in the set, the only way
 *    to it, so a later call-off could not log it out. Now only the sessions read are taken out (SREM), with their locks.
 * 2. That clean-up was not caught: when it failed, the call-off answered a generic error and the owner was not told,
 *    although every session was logged out. Now a failed clean-up is logged and the call-off goes on, as the other path.
 * 3. The account's kept mark answered as a whole in another shape (an empty list of replies) still counted the month's
 *    report of lists past their ceiling, although nothing says the list was written. Now only three replies count it.
 *
 * Synthetic only: the Redis stand-in, a stand-in email provider.
 */
import { emailForSession, sessionKeyOf } from "@/lib/auth";
import { cancelReset, enterLocked, finishSetup, holdSignIn, startSetup } from "@/lib/two-step";
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
const restore = () => {
  redis.pipeline = real;
};
const codeTo = (to: string) => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
const lastTo = (to: string) => [...mails].reverse().find((m) => m.to === to)?.text ?? "";

async function turnOnApp(email: string, session: string, backup: string): Promise<void> {
  const setup = await startSetup(email, session, backup);
  if (typeof setup === "string") throw new Error(setup);
  const secret = base32Decode(setup.secret)!;
  const finished = await finishSetup(email, session, codeAt(secret, Math.floor(Date.now() / 1000 / STEP_SECONDS)), codeTo(backup));
  if (typeof finished === "string") throw new Error(finished);
}

const quiet = console.error;
async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};

  part("LOW 1: a session let in while the call-off runs keeps its place in the set");
  {
    const OWNER = "x6-new@example.com";
    await turnOnApp(OWNER, "b".repeat(64), "x6-new-backup@example.org");
    const first = await enterLocked(await holdSignIn(OWNER));
    if (!first) throw new Error("not let in");
    let setKey = "";
    const late = "c".repeat(64);
    redis.pipeline = (async (commands: Command[]) => {
      const reply = await real(commands);
      // Right after the set is read, another session is let in without the second step and joins it.
      if (!setKey && commands[0]?.[0] === "SMEMBERS" && String(commands[0][1]).startsWith("nl:2fa:lockedset:")) {
        setKey = String(commands[0][1]);
        await real([["SADD", setKey, late]]);
      }
      return reply;
    }) as typeof redis.pipeline;
    let answer: unknown;
    try {
      answer = await cancelReset(OWNER, "studio");
    } finally {
      restore();
    }
    is("control: the session read is logged out, and the owner told so", [answer, await emailForSession(first.session), lastTo(OWNER).includes("were logged out")], [true, null, true]);
    is("the session that joined meanwhile is still in the set", Number((await real([["SISMEMBER", setKey, late]]))[0]), 1);
    is("and the session read is not", Number((await real([["SISMEMBER", setKey, first.session]]))[0]), 0);
  }

  part("LOW 2: a clean-up that fails after every logout was confirmed does not turn the call-off into an error");
  {
    const OWNER = "x6-clean@example.com";
    await turnOnApp(OWNER, "d".repeat(64), "x6-clean-backup@example.org");
    const entered = await enterLocked(await holdSignIn(OWNER));
    if (!entered) throw new Error("not let in");
    let failed = 0;
    redis.pipeline = (async (commands: Command[]) => {
      // The clean-up of the set after every logout was confirmed: it touches the account's set of locked sessions.
      const cleanUp = commands.some((c) => (c[0] === "DEL" || c[0] === "SREM") && commands.some((d) => String(d[1]).startsWith("nl:2fa:lockedset:")));
      if (cleanUp && commands.every((c) => c[0] === "DEL" || c[0] === "SREM")) {
        failed += 1;
        throw new Error("Redis request failed with status 503 (synthetic)");
      }
      return real(commands);
    }) as typeof redis.pipeline;
    let answer: unknown;
    try {
      answer = await cancelReset(OWNER, "studio").catch((error: unknown) => `threw: ${String(error)}`);
    } finally {
      restore();
    }
    is("control: the clean-up was tried and failed", failed > 0, true);
    is("the call-off still answers that they were logged out", answer, true);
    is("the session is logged out", await emailForSession(entered.session), null);
    is("and the owner is told", lastTo(OWNER).includes("were logged out"), true);
  }

  part("LOW 3: a kept mark answered as a whole in another shape does not count the month's report");
  {
    const OWNER = "x6-star@example.com";
    await turnOnApp(OWNER, "e".repeat(64), "x6-star-backup@example.org");
    const entered = await enterLocked(await holdSignIn(OWNER));
    if (!entered) throw new Error("not let in");
    const month = new Date().toISOString().slice(0, 7);
    const starKey = `nl:2fa:keptstar:${month}`;
    const before = Number((await real([["GET", starKey]]))[0] ?? 0);
    const sessionKey = await sessionKeyOf(entered.session);
    redis.pipeline = (async (commands: Command[]) => {
      // The logout is not confirmed (the session's DEL answering in another shape), so the account is kept locked.
      if (commands[0]?.[0] === "DEL" && commands[0][1] === sessionKey) return commands.map(() => "1");
      // And the kept mark's three commands come back as an empty list of replies: answered, in another shape.
      if (commands[0]?.[0] === "SET" && String(commands[0][1]).endsWith(":kept")) return [];
      return real(commands);
    }) as typeof redis.pipeline;
    let answer: unknown;
    try {
      answer = await cancelReset(OWNER, "studio");
    } finally {
      restore();
    }
    is("control: the mark is not confirmed, so the owner is never told they stay locked", answer, "not-kept");
    is("the month's report of lists past their ceiling is not counted", Number((await real([["GET", starKey]]))[0] ?? 0), before);
  }

  console.error = quiet;
  done();
}

main().catch((error: unknown) => {
  console.error = quiet;
  console.error(error);
  process.exit(1);
});
