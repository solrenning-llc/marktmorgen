/**
 * A follow-up message that races the trim of its own request (lib/community-dm.ts,
 * send; Claude 6's review of #3266). The sender's second message decides
 * "still a request" from its first checks, and is written a few round trips
 * later. If another stranger's request trims this one in that window, the trim
 * deletes the conversation and its lines; the late write must not recreate a
 * conversation that nothing of the recipient's points at, and the sender's next
 * message must not then reach her inbox without her yes.
 *
 * "Already talking" is the pair in the recipient's inbox, never a conversation
 * that merely exists: anything else from a stranger, with requests on, is a
 * request, and its line is (re)written with ZADD NX, keeping its first place.
 *
 * Driven through the real send, inbox, conversationsOf and forgetDmPerson; the
 * race is made by running the other stranger's send when the follow-up reads
 * its conversation's length (the step after its checks).
 */
import { MAX_REQUESTS, accept, conversationsOf, forgetDmPerson, inbox, parseDmSetting, requestCount, send, thread } from "@/lib/community-dm";
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
redis.pipeline = (async (commands: Command[]) => {
  if (hook && commands[0]?.[0] === "LLEN" && String(commands[0]?.[1]).includes(hookOn)) {
    const run = hook;
    hook = null;
    await run();
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

const name = (prefix: string, i: number) => `${prefix}${String(i).padStart(3, "0")}`;

async function main(): Promise<void> {
  redis.clear();
  const id = "cmrace";

  part("A follow-up that races the trim of its own request");
  {
    tick();
    is("ana's first message is a request", await send(id, setting, "ana", "bea", "first", ROOM), { ok: true, asked: true });
    for (let i = 1; i < MAX_REQUESTS; i += 1) {
      tick();
      await send(id, setting, name("s", i), "bea", `hi ${i}`, ROOM);
    }
    is("bea's request list is full, ana's the oldest", await requestCount(id, "bea"), MAX_REQUESTS);
    // ana writes again; in the window after her checks, zed's request trims hers.
    hookOn = "ana";
    hook = async () => {
      tick();
      await send(id, setting, "zed", "bea", "zed here", ROOM);
    };
    tick();
    const second = await send(id, setting, "ana", "bea", "second", ROOM);
    is("ana's second message is still a request", second, { ok: true, asked: true });
    const [queued] = await redis.pipeline([["ZSCORE", `nl:cm:${id}:dm:q:bea`, "ana.bea"]]);
    is("ana is back in bea's request list", typeof queued === "string", true);
    is("ana is not among bea's conversations", (await inbox(id, "bea")).some((c) => c.other === "ana"), false);
    const copy = await conversationsOf(id, "bea");
    is("bea's copy holds the conversation with ana's second message", copy.some((c) => c.messages.some((m) => m.text === "second")), true);

    tick();
    is("ana's third message is a request too", await send(id, setting, "ana", "bea", "third", ROOM), { ok: true, asked: true });
    is("and never reaches bea's inbox without her yes", (await inbox(id, "bea")).some((c) => c.other === "ana"), false);

    await forgetDmPerson(id, "bea");
    const [chat, read, line] = await redis.pipeline([
      ["EXISTS", `nl:cm:${id}:dm:ana.bea`],
      ["EXISTS", `nl:cm:${id}:dm:r:ana.bea`],
      ["ZSCORE", `nl:cm:${id}:dm:i:ana`, "ana.bea"],
    ]);
    is("after forgetting bea, her conversation with ana is gone, with its marks and ana's line", [chat, read, line], [0, 0, null]);
  }

  part("A conversation that exists with no line of the recipient's is a request, not talking");
  {
    redis.clear();
    tick();
    await send(id, setting, "cal", "dee", "hello", ROOM);
    // The request line alone is lost (as a trim that raced would leave it).
    await redis.pipeline([["ZREM", `nl:cm:${id}:dm:q:dee`, "cal.dee"]]);
    tick();
    is("cal's next message is a request again", await send(id, setting, "cal", "dee", "again", ROOM), { ok: true, asked: true });
    is("it is in dee's request list", (await inbox(id, "dee", true)).some((c) => c.other === "cal"), true);
    is("not in her conversations", (await inbox(id, "dee")).some((c) => c.other === "cal"), false);
  }

  part("An accept inside the window leaves the pair in both lists: a later trim never deletes the accepted conversation");
  {
    redis.clear();
    tick();
    await send(id, setting, "eli", "fay", "hello fay", ROOM);
    is("fay accepts", await accept(id, "fay", "eli.fay"), true);
    // What a follow-up's ZADD NX leaves when the accept landed inside its window: the line is back beside the inbox.
    tick();
    await redis.pipeline([["ZADD", `nl:cm:${id}:dm:q:fay`, Math.floor(clock / 1000), "eli.fay"]]);
    is("the thread is not pending: she accepted it", (await thread(id, "fay", "eli.fay"))?.pending, false);
    for (let i = 1; i <= MAX_REQUESTS; i += 1) {
      tick();
      await send(id, setting, name("g", i), "fay", `hi ${i}`, ROOM);
    }
    const [chat, line, listed] = await redis.pipeline([
      ["EXISTS", `nl:cm:${id}:dm:eli.fay`],
      ["ZSCORE", `nl:cm:${id}:dm:q:fay`, "eli.fay"],
      ["ZSCORE", `nl:cm:${id}:dm:i:fay`, "eli.fay"],
    ]);
    is("the trim took only the stray request line", [chat, line === null, typeof listed === "string"], [1, true, true]);
    is("the accepted conversation keeps its message", (await thread(id, "fay", "eli.fay"))?.messages.map((m) => m.text), ["hello fay"]);
    is("fay's request list holds the newest MAX_REQUESTS", await requestCount(id, "fay"), MAX_REQUESTS);
  }

  Date.now = realNow;
  done();
}

void main();
