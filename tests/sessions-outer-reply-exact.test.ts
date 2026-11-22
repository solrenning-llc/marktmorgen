/**
 * Issue #4059 (Codex G, MÉDIO; rule 24): "log out of all devices" (lib/auth.ts endAllSessions), "log out of the other
 * devices" (endOtherSessions) and dropSecondStep (a passkey removed, the app turned off) read the account's sessions
 * set from a one-command SMEMBERS pipeline as `[members]`, taking the first element whatever the outer answer was. An
 * outer answer with an extra element, with none, or sparse was read as the whole set: the sessions it listed were
 * closed, their place in the set removed, and a count returned, although the answer did not say what the set holds.
 * Now the outer answer must be exactly one reply (repliesFor); any other shape closes nothing, keeps the set, and is
 * "not known" (null, or SessionsUnknownError for dropSecondStep), never a count.
 *
 * Synthetic only: the in-memory Redis.
 */
import { SessionsUnknownError, dropSecondStep, emailForSession, endAllSessions, endOtherSessions, openSession } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const original = redis.pipeline.bind(redis);
/** How the sessions set's one-command SMEMBERS answer is reshaped as it is read, while set. */
let reshape: ((reply: unknown[]) => unknown[]) | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const answer = await original(commands);
  if (reshape && commands.length === 1 && commands[0]?.[0] === "SMEMBERS" && String(commands[0]?.[1]).startsWith("nl:auth:sessions:")) {
    return reshape(answer);
  }
  return answer;
}) as typeof redis.pipeline;

const SHAPES: [string, (reply: unknown[]) => unknown[]][] = [
  ["an extra reply after the set", (reply) => [...reply, "extra"]],
  ["no reply at all", () => []],
  ["a sparse answer", (reply) => {
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = reply[0];
    return sparse;
  }],
];

const setOf = (email: string) => {
  const key = redis.keys().find((one) => one.startsWith("nl:auth:sessions:"));
  void email;
  return key ? ((redis.run(["SMEMBERS", key]) as string[]) ?? []).length : 0;
};

async function main(): Promise<void> {
  for (const [label, run] of [
    ["endAllSessions", async (email: string, keep: string) => { void keep; return endAllSessions(email); }],
    ["endOtherSessions", async (email: string, keep: string) => endOtherSessions(email, keep)],
  ] as const) {
    for (const [shape, change] of SHAPES) {
      redis.clear();
      const email = "sessions-outer@example.com";
      part(`${label}: ${shape}`);
      const keep = await openSession(email);
      const other = await openSession(email);
      reshape = change;
      const answer = await run(email, keep);
      reshape = null;
      is("not known: null, never a count", answer, null);
      is("the other session is still open", await emailForSession(other), email);
      is("both stay in the account's set", setOf(email), 2);
    }
    redis.clear();
    const email = "sessions-outer@example.com";
    part(`${label}: control, the exact one-reply answer`);
    const keep = await openSession(email);
    await openSession(email);
    is("closed and counted", typeof (await run(email, keep)), "number");
  }

  for (const [shape, change] of SHAPES) {
    redis.clear();
    const email = "sessions-outer@example.com";
    part(`dropSecondStep: ${shape}`);
    const one = await openSession(email, "app");
    reshape = change;
    const dropped = await dropSecondStep(email, () => true).then(
      (count) => `closed ${count}`,
      (error: unknown) => (error instanceof SessionsUnknownError ? "unknown" : String(error)),
    );
    reshape = null;
    is("the set is unknown: nothing is closed", dropped, "unknown");
    is("the session is still open", await emailForSession(one), email);
    is("it stays in the account's set", setOf(email), 1);
  }
  redis.clear();
  part("dropSecondStep: control, the exact one-reply answer");
  await openSession("sessions-outer@example.com", "app");
  is("read, and the session with the mark closed", await dropSecondStep("sessions-outer@example.com", () => true), 1);

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
