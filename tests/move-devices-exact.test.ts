/**
 * Rule 24 (noted by Claude 5 ibqho in the review of #5146): moving an account (lib/auth.ts moveDevices) read the old
 * address's set of remembered browsers loosely (the first element of any answer, its non-text members dropped) and
 * then deleted it. A partial or unknown read deleted browsers the account knew, which were then told about as new.
 * Now the set is read exactly (one reply, every member a browser as noteSignIn writes it); otherwise nothing is moved
 * or deleted. A set read whole is copied and the old one deleted in one trip, as before (the move's priced envelope).
 *
 * Synthetic only: the in-memory Redis.
 */
import { createHash } from "node:crypto";
import { moveDevices } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const key = (email: string) => `nl:auth:devices:${createHash("sha256").update(`nimbus-auth-devices:${email}`).digest("hex").slice(0, 40)}`;
const FROM = "devices-from@example.com";
const TO = "devices-to@example.com";
const KNOWN = ["a".repeat(40), "b".repeat(40)];

const original = redis.pipeline.bind(redis);
let reshape: ((commands: (string | number)[][], answer: unknown[]) => unknown[]) | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const answer = await original(commands);
  return reshape ? reshape(commands, answer) : answer;
}) as typeof redis.pipeline;

const members = (email: string) => ((redis.run(["SMEMBERS", key(email)]) as string[]) ?? []).slice().sort();

async function attempt(change: typeof reshape): Promise<string> {
  redis.clear();
  redis.run(["SADD", key(FROM), ...KNOWN]);
  reshape = change;
  const result = await moveDevices(FROM, TO).then(() => "moved", () => "kept");
  reshape = null;
  return result;
}

async function main(): Promise<void> {
  part("Control: read exactly, copied, then the old set deleted");
  is("moved", await attempt(null), "moved");
  is("the new address knows both browsers", members(TO), KNOWN);
  is("the old set is gone", members(FROM), []);

  part("A read that is not exact: nothing moved, nothing deleted");
  const onSmembers = (make: (answer: unknown[]) => unknown[]) => (commands: (string | number)[][], answer: unknown[]) => (commands[0]?.[0] === "SMEMBERS" ? make(answer) : answer);
  for (const [label, change] of [
    ["an extra reply", onSmembers((answer) => [...answer, "extra"])],
    ["no reply", onSmembers(() => [])],
    ["a member that is not a browser", onSmembers((answer) => [[...(answer[0] as string[]), "not-a-browser"]])],
    ["a member that is not text", onSmembers((answer) => [[...(answer[0] as string[]), 7]])],
  ] as [string, typeof reshape][]) {
    is(`${label}: kept`, await attempt(change), "kept");
    is(`${label}: the old set is still there`, members(FROM), KNOWN);
  }

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
