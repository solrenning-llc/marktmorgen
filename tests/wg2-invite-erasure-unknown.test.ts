/**
 * CX-123 rule 24 on lib/move-members.ts, forgetInvitesPerson (Claude 4, C4-20261106-2890-HOLD-175, proof
 * claude4/sweep-proofs e912d71c, sweepA4 P5): deleting a person reads their invitations with one HMGET. A reply
 * not in its exact shape is unknown, never "no invitations": the eraser throws, so lib/person-erasure.ts lists it
 * as not finished, instead of reporting 0 records while the invitation, its link and its schedule stay.
 */
import { forgetInvitesPerson } from "@/lib/move-members";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function attempt(reply: (fields: number) => unknown): Promise<{ result: number | "threw"; deletes: number }> {
  const real = redis.pipeline.bind(redis);
  let deletes = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "HMGET") return [reply(commands[0].length - 2)];
    deletes += commands.length;
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    return { result: await forgetInvitesPerson({ sid: "sid1", statsId: "st1" }, ["prod1", "prod2"], "person@example.com"), deletes };
  } catch {
    return { result: "threw", deletes };
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  part("An HMGET reply out of shape is unknown: the eraser does not report 0");
  for (const [label, reply] of [
    ["no reply at all", () => undefined],
    ["a text instead of a list", () => "OK"],
    ["a shorter list", () => [null]],
    ["a longer list", (n: number) => Array(n + 1).fill(null)],
    ["a field that is neither text nor null", (n: number) => Array(n).fill(7)],
  ] as [string, (n: number) => unknown][]) {
    is(label, (await attempt(reply)).result, "threw");
  }
  part("Controls");
  is("no invitation on either product: 0, nothing deleted", await attempt((n) => Array(n).fill(null)), { result: 0, deletes: 0 });
  // Added after the RED: a field holding a record that no longer reads is still the person's, so it is deleted and counted.
  is("a field whose record does not read is still deleted and counted", await attempt((n) => ["not json", ...Array(n - 1).fill(null)]), { result: 1, deletes: 3 });
  done();
}

main();
