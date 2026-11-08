/**
 * A private message's checks before it is written, read in their exact shape
 * (CX-123 rule 24).
 *
 * lib/community-dm.ts send read the recipient's "declined" set with
 * `Number(declined) === 1`: a SISMEMBER reply that was missing, null, text or
 * cut short read as "not declined", so a message reached somebody who had
 * declined that sender (privacy). The same pipeline read the recipient's
 * conversation count (ZCARD, the MAX_CONVERSATIONS cap) and whether the two
 * already talk (EXISTS) with Number(...): an unknown count let a new
 * conversation past the cap, and an EXISTS answered as text "1" made a
 * stranger's first message skip the request list.
 *
 * Each is called here as the messages route calls it, on the in-memory store,
 * with only that one read answered differently. What is checked: an unknown
 * reply throws UnknownReplyError and nothing is written (the route answers
 * 503 and nothing is sent); a confirmed decline still refuses, a confirmed
 * full inbox still refuses a new conversation, and confirmed replies still
 * send as before.
 */
import { MAX_CONVERSATIONS, decline, inbox, parseDmSetting, send } from "@/lib/community-dm";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

type Command = (string | number)[];
let odd: unknown = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  if (odd !== null && commands[0]?.[0] === "SISMEMBER") return odd;
  return pipeline(commands);
}) as typeof redis.pipeline;

/** What a send answered with one reply set to `reply`: its result, or "unknown" when it threw UnknownReplyError. */
async function sendWith(reply: unknown, id: string, from: string, to: string, text: string): Promise<unknown> {
  const setting = parseDmSetting({ on: true, between: true, ask: true });
  odd = reply;
  try {
    return await send(id, setting, from, to, text, ROOM);
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`;
  } finally {
    odd = null;
  }
}

/** Everything a person could see: their conversations and their requests. */
async function seen(id: string, who: string): Promise<number> {
  return (await inbox(id, who)).length + (await inbox(id, who, true)).length;
}

async function main(): Promise<void> {
  redis.clear();
  const id = "cmproofdm01";
  const setting = parseDmSetting({ on: true, between: true, ask: true });

  part("A declined sender, with the SISMEMBER answered in another shape");
  {
    is("first message is a request", await send(id, setting, "ana", "ben", "hello", ROOM), { ok: true, asked: true });
    const [req] = await inbox(id, "ben", true);
    is("ben declines", await decline(id, "ben", req.pair, ROOM), true);
    is("ana is now refused (confirmed decline, as before)", await send(id, setting, "ana", "ben", "again", ROOM), { ok: false, reason: "declined" });
    for (const [what, reply] of [
      ["a hole", [undefined, 0, 0, null, null]],
      ["nothing", [null, 0, 0, null, null]],
      ["text", ["1", 0, 0, null, null]],
      ["a fraction", [0.5, 0, 0, null, null]],
      ["cut short", []],
    ] as [string, unknown][]) {
      const got = await sendWith(reply, id, "ana", "ben", `again (${what})`);
      is(`declined read as ${what}: unknown, never delivered`, [got, await seen(id, "ben")], ["unknown", 0]);
    }
  }

  part("The recipient's conversation count (ZCARD, the MAX_CONVERSATIONS cap) in another shape");
  {
    for (const [what, reply] of [
      ["a hole", [0, 0, undefined, null, null]],
      ["nothing", [0, 0, null, null, null]],
      ["text", [0, 0, String(MAX_CONVERSATIONS), null, null]],
      ["below zero", [0, 0, -1, null, null]],
      ["a fraction", [0, 0, 1.5, null, null]],
      ["cut short", [0, 0]],
      ["cut short of the request check", [0, 0, 0]],
      ["cut short of the inbox check", [0, 0, 0, null]],
    ] as [string, unknown][]) {
      const got = await sendWith(reply, id, "cara", "dan", `hello (${what})`);
      is(`count read as ${what}: unknown, no conversation past the cap`, [got, await seen(id, "dan")], ["unknown", 0]);
    }
    is("a confirmed full inbox still refuses a new conversation", await sendWith([0, 0, MAX_CONVERSATIONS, null, null], id, "cara", "dan", "hello"), { ok: false, reason: "full" });
    is("nothing reached dan", await seen(id, "dan"), 0);
  }

  part("Whether the two already talk (EXISTS) in another shape");
  {
    for (const [what, reply] of [
      ["text", [0, "1", 0, null, null]],
      ["nothing", [0, null, 0, null, null]],
      ["a hole", [0, undefined, 0, null, null]],
    ] as [string, unknown][]) {
      const got = await sendWith(reply, id, "eve", "fay", `hello (${what})`);
      is(`EXISTS read as ${what}: unknown, never in fay's conversations`, [got, await seen(id, "fay")], ["unknown", 0]);
    }
  }

  part("The pair's place in the recipient's request list (ZSCORE) in another shape");
  {
    for (const [what, reply] of [
      ["a number", [0, 1, 0, 5, null]],
      ["empty text", [0, 1, 0, "", null]],
      ["text that is not a number", [0, 1, 0, "soon", null]],
      ["a list", [0, 1, 0, ["1"], null]],
      ["a hole", [0, 1, 0, undefined, null]],
    ] as [string, unknown][]) {
      const got = await sendWith(reply, id, "gus", "hal", `hello (${what})`);
      is(`request check read as ${what}: unknown, never in hal's conversations`, [got, await seen(id, "hal")], ["unknown", 0]);
    }
  }

  part("The pair's place in the recipient's inbox (ZSCORE) in another shape");
  {
    for (const [what, reply] of [
      ["a number", [0, 1, 0, null, 5]],
      ["empty text", [0, 1, 0, null, ""]],
      ["text that is not a number", [0, 1, 0, null, "soon"]],
      ["a list", [0, 1, 0, null, ["1"]]],
      ["a hole", [0, 1, 0, null, undefined]],
    ] as [string, unknown][]) {
      const got = await sendWith(reply, id, "ivy", "jon", `hello (${what})`);
      is(`inbox check read as ${what}: unknown, never in jon's conversations`, [got, await seen(id, "jon")], ["unknown", 0]);
    }
  }

  part("Confirmed replies still send as before");
  {
    is("a stranger's first message is a request", await send(id, setting, "hal", "ivy", "hello", ROOM), { ok: true, asked: true });
    is("it is in ivy's requests, not her conversations", [(await inbox(id, "ivy")).length, (await inbox(id, "ivy", true)).length], [0, 1]);
    is("the creator writes without asking", await send(id, setting, "creator", "gus", "welcome", ROOM), { ok: true, asked: false });
  }
  done();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
