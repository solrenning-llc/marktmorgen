/**
 * The list of community sends waiting to go out, read exactly (CX-123 rule 24, review of #3306): a reply to its
 * SMEMBERS in any shape but a plain list of strings is unknown, so advanceAnnouncements throws UnknownReplyError (the
 * mail job logs it, app/api/cron/mail/route.ts) and never reads it as "nothing waiting", which would leave every
 * waiting send quietly unsent. An empty list answered as one is still nothing to do. Synthetic data only.
 */
import { advanceAnnouncements } from "@/lib/community-mail";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const QUEUE = "nl:cm:mailq";

async function main() {
  const original = redis.pipeline;
  let queueReply: unknown = null;
  let answered = false;
  const after: string[] = [];
  redis.pipeline = async commands => {
    if (commands.length === 1 && commands[0][0] === "SMEMBERS" && commands[0][1] === QUEUE && answered) {
      if (queueReply instanceof Error) throw queueReply;
      return queueReply as unknown[];
    }
    for (const c of commands) after.push(String(c[0]));
    return original.call(redis, commands);
  };
  const load = async () => null;
  try {
    part("A queue that cannot be read is unknown, never empty");
    const odd: unknown[] = [null, {}, [], [null], ["nl"], [{}], [[1]], [[null]], [["a", 2]], [[], []], [new Array(1)]];
    for (const reply of odd) {
      answered = true; queueReply = reply; after.length = 0;
      let thrown: unknown = null;
      let result: unknown = undefined;
      try { result = await advanceAnnouncements(load, Date.now() + 5000); } catch (error) { thrown = error; }
      is(`an unreadable queue (${JSON.stringify(reply)}) throws UnknownReplyError`, thrown instanceof UnknownReplyError, true);
      is("nothing is counted as moved on it", result, undefined);
      is("nothing is claimed, read or sent on it", after, []);
    }

    part("An empty queue answered as one is nothing to do");
    answered = false; after.length = 0;
    await original.call(redis, [["DEL", QUEUE]]);
    is("an empty queue moves nothing", await advanceAnnouncements(load, Date.now() + 5000), 0);

    part("A send that is not there is taken out of the queue");
    const id = "d".repeat(24);
    await original.call(redis, [["SADD", QUEUE, id]]);
    is("a waiting id with no record moves nothing", await advanceAnnouncements(load, Date.now() + 5000), 0);
    is("and leaves the queue", (await original.call(redis, [["SISMEMBER", QUEUE, id]]))[0], 0);
  } finally { redis.pipeline = original; }
  done();
}
void main();
