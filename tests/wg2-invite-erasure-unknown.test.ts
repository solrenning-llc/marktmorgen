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
  // Added after the RED: a field holding a record that no longer reads is still the person's, so it is deleted (its field,
  // schedule and checkout mark). Claude 5 on #2685: its link's token is in the record, so the link cannot be deleted and the
  // erasure is not finished: it throws after deleting what it can, never "ok" with the link kept (the link runs out at its
  // own expiry). Changed from { result: 1, deletes: 3 } on purpose.
  is("a field whose record does not read is deleted, and the erasure is not finished", await attempt((n) => ["not json", ...Array(n - 1).fill(null)]), { result: "threw", deletes: 3 });
  is("an unreadable record \"{\" alike", await attempt((n) => ["{", ...Array(n - 1).fill(null)]), { result: "threw", deletes: 3 });

  part("The deletes' replies are read exactly");
  {
    const real = redis.pipeline.bind(redis);
    redis.run(["HSET", "nl:mv:st1", "x", "y"]);
    const good = JSON.stringify({ e: "person@example.com", p: "prod1", r: 1, t: "tok_reply_lost", kept: 0 });
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands[0]?.[0] === "HMGET") return [[good, null]];
      await real(commands);
      return commands.map(() => null);
    }) as typeof redis.pipeline;
    let result: number | "threw";
    try {
      result = await forgetInvitesPerson({ sid: "sid1", statsId: "st1" }, ["prod1", "prod2"], "person@example.com");
    } catch {
      result = "threw";
    } finally {
      redis.pipeline = real;
    }
    is("deletes answered with nothing: not reported as done", result, "threw");
  }
  done();
}

main();
