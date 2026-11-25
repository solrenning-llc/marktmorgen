/**
 * Issue #4287, item 4 (Codex G, hidden #4189; rule 24, defense in depth): "log out of all devices" (lib/auth.ts
 * endAllSessions) and "log out of the other devices" (endOtherSessions) DEL every member of the account's sessions
 * set. Only openSession adds to that set, always a session key, but a member in any other shape was deleted as a key
 * all the same: whatever key it named was gone. Now every member must be a session key
 * (nl:auth:session:<40 hex>); any other member makes the set unknown, so nothing is deleted and the answer is null
 * ("not known"), never a count. The same set is read by dropSecondStep (a passkey removed, the app turned off), which
 * throws SessionsUnknownError on it (Claude 6 z5v4's LEVE on #5144).
 *
 * Synthetic only: the in-memory Redis.
 */
import { SessionsUnknownError, dropSecondStep, emailForSession, endAllSessions, endOtherSessions, openSession } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const original = redis.pipeline.bind(redis);
/** A member added to the account's sessions set as it is read, while set. */
let extra: string | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (extra !== null && commands.length === 1 && commands[0]?.[0] === "SMEMBERS" && String(commands[0]?.[1]).startsWith("nl:auth:sessions:")) {
    const [members] = await original(commands);
    return [[...(members as string[]), extra]];
  }
  return original(commands);
}) as typeof redis.pipeline;

const VICTIM = "nl:store:owner:someone-else";

async function main(): Promise<void> {
  redis.clear();
  const email = "sessions-shape@example.com";

  for (const [label, run] of [
    ["endAllSessions", async (keep: string) => { void keep; return endAllSessions(email); }],
    ["endOtherSessions", async (keep: string) => endOtherSessions(email, keep)],
  ] as const) {
    part(`${label}: a member that is not a session key`);
    const keep = await openSession(email);
    const other = await openSession(email);
    redis.run(["SET", VICTIM, "kept"]);
    extra = VICTIM;
    const answer = await run(keep);
    extra = null;
    is("not known: null, never a count", answer, null);
    is("the key it named is untouched", redis.run(["GET", VICTIM]), "kept");
    is("the other session is still open", await emailForSession(other), email);

    part(`${label}: control, every member a session key`);
    is("closed and counted", typeof (await run(keep)), "number");
  }

  part("dropSecondStep (a passkey removed, the app turned off): a member that is not a session key");
  await openSession(email);
  redis.run(["SET", VICTIM, "kept"]);
  extra = VICTIM;
  const dropped = await dropSecondStep(email, () => true).then(
    (count) => `closed ${count}`,
    (error: unknown) => (error instanceof SessionsUnknownError ? "unknown" : String(error)),
  );
  extra = null;
  is("the set is unknown: nothing is closed", dropped, "unknown");
  is("the key it named is untouched", redis.run(["GET", VICTIM]), "kept");

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
