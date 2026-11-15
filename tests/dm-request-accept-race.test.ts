/**
 * A follow-up request that races its recipient's yes (lib/community-dm.ts, send and accept; Claude 6's note in the
 * focal of #3266). The sender's second message decides "still a request" from its first checks and is written a few
 * round trips later, with ZADD NX on the request list. When the recipient accepts in that window, the line came back
 * beside the conversation in her inbox: her messages page listed the accepted conversation again under "wants to
 * message you", her request count counted it, her data copy called it a request, and the sender was told it went as
 * a request.
 *
 * Now accept writes the inbox line before it takes the request line out, and a request send reads, after its write,
 * whether the pair is in the recipient's inbox; when it is, the stray request line goes and the message is reported
 * as sent into the conversation. Whatever the order of the two writers' commands, no request line is left beside an
 * accepted conversation.
 *
 * Driven through the real send, accept, inbox, requestCount, thread and conversationsOf on the in-memory store; the
 * race is made by running the accept when the follow-up reads its conversation's length (the step after its checks).
 */
import { accept, conversationsOf, inbox, parseDmSetting, requestCount, send, thread } from "@/lib/community-dm";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

type Command = (string | number)[];
const setting = parseDmSetting({ on: true, between: true, ask: true });
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const tick = () => {
  clock += 1000;
};

const pipeline = redis.pipeline.bind(redis);
let hook: (() => Promise<void>) | null = null;
let hookOn = "";
/** Every pipeline the code sends, in order, so the order of accept's two writes can be checked. */
const sent: Command[][] = [];
/** Runs once, just before the follow-up's read of the recipient's inbox for this pair (after its write). */
let hookAfterWrite: { on: string; run: () => Promise<void> } | null = null;
redis.pipeline = (async (commands: Command[]) => {
  sent.push(commands);
  if (hookAfterWrite && commands.length === 1 && commands[0]?.[0] === "ZSCORE" && String(commands[0]?.[1]).includes(":dm:i:") && commands[0]?.[2] === hookAfterWrite.on) {
    const run = hookAfterWrite.run;
    hookAfterWrite = null;
    await run();
  }
  if (hook && commands[0]?.[0] === "LLEN" && String(commands[0]?.[1]).includes(hookOn)) {
    const run = hook;
    hook = null;
    await run();
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const id = "cmaccept";

  part("A follow-up request written after its recipient said yes");
  {
    tick();
    is("eli's first message is a request", await send(id, setting, "eli", "fay", "hello fay", ROOM), { ok: true, asked: true });
    hookOn = "eli";
    hook = async () => {
      tick();
      is("fay accepts while eli's second message is on its way", await accept(id, "fay", "eli.fay"), true);
    };
    tick();
    const second = await send(id, setting, "eli", "fay", "are you there?", ROOM);
    is("eli is told it went into the conversation, not as a request", second, { ok: true, asked: false });
    const [line, listed] = await redis.pipeline([
      ["ZSCORE", `nl:cm:${id}:dm:q:fay`, "eli.fay"],
      ["ZSCORE", `nl:cm:${id}:dm:i:fay`, "eli.fay"],
    ]);
    is("no request line is left beside the accepted conversation", [line, typeof listed === "string"], [null, true]);
    is("fay's requests do not list eli", (await inbox(id, "fay", true)).some((c) => c.other === "eli"), false);
    is("fay's request count does not count eli", await requestCount(id, "fay"), 0);
    is("fay's conversations list eli", (await inbox(id, "fay")).some((c) => c.other === "eli"), true);
    is("the thread holds both messages and is not pending", [(await thread(id, "fay", "eli.fay"))?.messages.map((m) => m.text), (await thread(id, "fay", "eli.fay"))?.pending], [["hello fay", "are you there?"], false]);
    is("fay's data copy calls it a conversation, not a request", (await conversationsOf(id, "fay")).map((c) => c.request), [false]);
  }

  part("The yes lands after the follow-up's write and before its read (the other half of the order)");
  {
    redis.clear();
    tick();
    await send(id, setting, "kit", "lou", "hello lou", ROOM);
    // Run lou's accept when the follow-up reads her inbox for the pair, so its ZADD NX already put the line back.
    hookAfterWrite = { on: "kit.lou", run: async () => {
      tick();
      is("lou accepts once kit's second message is written", await accept(id, "lou", "kit.lou"), true);
    } };
    tick();
    is("kit is told it went into the conversation", await send(id, setting, "kit", "lou", "still there?", ROOM), { ok: true, asked: false });
    const [line, listed] = await redis.pipeline([
      ["ZSCORE", `nl:cm:${id}:dm:q:lou`, "kit.lou"],
      ["ZSCORE", `nl:cm:${id}:dm:i:lou`, "kit.lou"],
    ]);
    is("no request line is left, and the pair is in her inbox", [line, typeof listed === "string"], [null, true]);
    is("lou's request count is 0", await requestCount(id, "lou"), 0);
  }

  part("accept writes the inbox line before it takes the request line out");
  {
    redis.clear();
    tick();
    await send(id, setting, "gus", "hal", "hi hal", ROOM);
    sent.length = 0;
    is("hal accepts", await accept(id, "hal", "gus.hal"), true);
    const writes = sent.flat().filter((c) => (c[0] === "ZADD" || c[0] === "ZREM") && String(c[3] ?? c[2]).includes("gus.hal")).map((c) => `${c[0]} ${String(c[1]).split(":").at(-2)}`);
    is("the inbox line goes in first, then the request line goes", writes, ["ZADD i", "ZREM q"]);
  }

  part("Control: a follow-up with no yes stays a request");
  {
    redis.clear();
    tick();
    await send(id, setting, "ivy", "jan", "hello jan", ROOM);
    tick();
    is("ivy's second message is still a request", await send(id, setting, "ivy", "jan", "again", ROOM), { ok: true, asked: true });
    is("it is in jan's requests, once", await requestCount(id, "jan"), 1);
  }

  Date.now = realNow;
  done();
}

void main();
