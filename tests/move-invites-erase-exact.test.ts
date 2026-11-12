/**
 * Erasing a person's membership move invitations reads Redis in its exact
 * shape (unknown is never zero). forgetInvitesPerson is one of the person
 * erasers (lib/person-erasure.ts, ERASERS): an HMGET reply in another shape,
 * a kept invitation that does not read, or a delete reply that is not a count
 * must throw UnknownReplyError, so the erasure reports this part as not done
 * and can be pressed again. Before, each of them answered 0 ("nothing to
 * delete"), the step was recorded as done, and the invitation, its link and
 * its reminder (which emails the person) stayed. Synthetic data only.
 */
import { forgetInvitesPerson, inviteField, linkKey } from "@/lib/move-members";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = (commands: (string | number)[][]) => Promise<unknown[]>;
const original = redis.pipeline.bind(redis) as Pipeline;

const statsId = "moveeraseexact0000000000000001";
const store = { sid: "moveerasesid01", statsId };
const email = "buyer@example.test";
const product = "prod_move1";
const field = inviteField(email, product);
const token = "a".repeat(40);
const invitesKey = `nl:mv:${statsId}`;
const due = `${store.sid}|${field}`;
const invite = JSON.stringify({ e: email, p: product, o: "", r: 1_800_000_000, job: "job1", at: 1, t: token, kept: 0 });

function seed(value = invite): void {
  redis.clear();
  redis.run(["HSET", invitesKey, field, value]);
  redis.run(["SET", linkKey(token), JSON.stringify({ s: statsId, f: field })]);
  redis.run(["ZADD", "nl:mv:due", 1, due]);
}

const state = () => ({
  invite: redis.run(["HGET", invitesKey, field]) !== null,
  link: redis.run(["GET", linkKey(token)]) !== null,
  reminder: redis.run(["ZSCORE", "nl:mv:due", due]) !== null,
});
const kept = { invite: true, link: true, reminder: true };

async function run(swap?: { at: "HMGET" | "HDEL"; reply: (real: unknown[]) => unknown }): Promise<unknown> {
  (redis as unknown as { pipeline: Pipeline }).pipeline = async (commands) => {
    const real = await original(commands);
    return (swap && commands[0]?.[0] === swap.at ? swap.reply(real) : real) as unknown[];
  };
  try {
    return await forgetInvitesPerson(store, [product], email);
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other error: ${String(error)}`;
  } finally {
    (redis as unknown as { pipeline: Pipeline }).pipeline = original;
  }
}

async function main(): Promise<void> {
  part("Healthy erasure is unchanged");
  seed();
  is("their invitation is erased and counted once", await run(), 1);
  is("the invitation, its link and its reminder are gone", state(), { invite: false, link: false, reminder: false });
  redis.clear();
  is("no invitation kept: an exact 0", await run(), 0);

  part("An HMGET reply in another shape is unknown, never nothing to delete");
  const reads: [string, (real: unknown[]) => unknown][] = [
    ["an empty envelope", () => []],
    ["a missing reply", () => [undefined]],
    ["a text reply", () => ["x"]],
    ["a short list", () => [[]]],
    ["a long list", (real) => [[...(real[0] as unknown[]), null]]],
    ["a number in the slot", () => [[7]]],
    ["an envelope that is not a list", () => "OK"],
  ];
  for (const [what, reply] of reads) {
    seed();
    is(`${what} throws UnknownReplyError`, await run({ at: "HMGET", reply }), "unknown");
    is(`${what} leaves the invitation for a retry`, state(), kept);
  }

  part("A kept invitation that does not read is never said to be forgotten");
  seed("{not json");
  is("a broken record throws UnknownReplyError", await run(), "unknown");
  seed(JSON.stringify({ e: email, p: product }));
  is("a record without its link throws UnknownReplyError", await run(), "unknown");

  part("A delete reply in another shape is unknown, never done");
  const writes: [string, (real: unknown[]) => unknown][] = [
    ["an empty envelope", () => []],
    ["a text count", (real) => ["1", real[1], real[2]]],
    ["a count above what was asked", (real) => [5, real[1], real[2]]],
  ];
  for (const [what, reply] of writes) {
    seed();
    is(`${what} throws UnknownReplyError`, await run({ at: "HDEL", reply }), "unknown");
  }
  done();
}

void main();
