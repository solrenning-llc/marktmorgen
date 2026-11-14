/**
 * lib/team.ts moveMemberships read the old address's index of teams (SMEMBERS) with `Array.isArray(ids) ? … : []`:
 * a reply in any other shape (no reply, an error object, a number, a list with a non-text) was taken for "on no
 * team", and the index was then deleted (DEL) with nothing copied to the new address, so a teammate who moved their
 * sign-in lost every store they help run (Claude 4 nuvem R's MEDIUM, forwarded to Claude 3; rule 24). Now only an
 * exact list of texts is read; anything else throws UnknownReplyError and nothing is deleted or written.
 * Synthetic Redis only.
 */
import { createHash } from "node:crypto";
import { moveMemberships } from "@/lib/team";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const indexKey = (email: string) => `nl:team:of:${sha(`nimbus-team-of:${email}`).slice(0, 40)}`;
type Command = (string | number)[];

async function main(): Promise<void> {
  console.error = () => {};
  const FROM = "mover@example.com";
  const TO = "moved@example.com";
  const SID = "a".repeat(24);
  const real = redis.pipeline.bind(redis);
  for (const [label, reply] of [
    ["no reply", []],
    ["an error object", [{ error: "ERR synthetic" }]],
    ["a number", [3]],
    ["a list with a non-text", [[SID, 7]]],
    ["a text", ["x"]],
  ] as const) {
    part(label);
    redis.clear();
    await real([["SADD", indexKey(FROM), SID]]);
    const writes: Command[] = [];
    redis.pipeline = (async (commands: Command[]) => {
      if (commands.length === 1 && commands[0][0] === "SMEMBERS" && commands[0][1] === indexKey(FROM)) return reply;
      writes.push(...commands.filter((c) => ["DEL", "SREM", "SADD", "SET", "HSET"].includes(String(c[0]))));
      return real(commands);
    }) as never;
    let threw = false;
    try {
      await moveMemberships(FROM, TO);
    } catch {
      threw = true;
    }
    redis.pipeline = real as never;
    is("the move of memberships stops as unknown", threw, true);
    is("nothing is deleted or written", writes.length, 0);
    is("the old address still lists its team", (await real([["SMEMBERS", indexKey(FROM)]]))[0], [SID]);
  }
  part("control: an exact empty list is no team, and the index is cleared");
  redis.clear();
  let threw = false;
  try {
    await moveMemberships(FROM, TO);
  } catch {
    threw = true;
  }
  is("an exact empty list moves nothing and does not throw", threw, false);
  done();
}

void main();
