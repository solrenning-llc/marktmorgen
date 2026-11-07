/**
 * A member's trace deleted from a community answers exactly how many entries
 * went, or the deletion is unknown (Claude 6's note on #2576): a reply that is
 * not one whole count no longer reads as "nothing was there", which reported
 * the person deleted while their trace may still be kept, and gave its room
 * back as nothing. Synthetic records; no outside request.
 */
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => {
  throw new Error("No outside request in this test");
}) as typeof fetch;

async function main(): Promise<void> {
  const pipe = redis.pipeline.bind(redis);
  const answering = (shape: unknown[] | undefined) => {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const isTrace = commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][3] ?? "").includes(":tr:");
      return isTrace && shape !== undefined ? shape : isTrace ? [undefined] : pipe(commands);
    }) as typeof redis.pipeline;
  };
  for (const [label, shape] of [
    ["a reply with nothing in it", undefined],
    ["a count that is text", ["3"]],
    ["a negative count", [-1]],
    ["a count that is not whole", [1.5]],
    ["two replies for one script", [2, 2]],
  ] as [string, unknown[] | undefined][]) {
    part(label);
    redis.clear();
    answering(shape);
    const answer = await forgetCommunityPerson("communityx1", "whoabc", "member@example.com", []).then((n) => `done ${n}`, (error: Error) => error.name);
    redis.pipeline = pipe;
    is(`${label}: the deletion is unknown, never "nothing was there"`, answer, "UnknownReply");
  }

  part("A confirmed count");
  redis.clear();
  answering([0]);
  const none = await forgetCommunityPerson("communityx1", "whoabc", "member@example.com", []).then((n) => `done ${n}`, (error: Error) => error.name);
  redis.pipeline = pipe;
  is("a confirmed zero is nothing there", none, "done 0");
  done();
}

void main();
