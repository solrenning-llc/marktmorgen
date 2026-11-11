/**
 * A private-message request trimmed off a full request list takes its
 * conversation with it (rule 30: a person's data copy and erasure leave
 * nothing behind).
 *
 * lib/community-dm.ts send kept the newest MAX_REQUESTS requests with
 * ZREMRANGEBYRANK on the recipient's request list. The request that fell off
 * left its conversation (the recipient's key in its name, a message addressed
 * to them) and its read marks in Redis, and the sender's inbox still listed the
 * pair. Nothing of the recipient's pointed at it any more, so their data copy
 * (conversationsOf) silently left it out and forgetDmPerson reported done while
 * the message was still stored.
 *
 * Driven here through the real send, accept, conversationsOf and forgetDmPerson
 * on the in-memory store. What is checked:
 *   - 101 requests to one member: the oldest one is gone whole (conversation,
 *     read marks, the sender's inbox line); every conversation still stored
 *     with them is in their copy; after forgetDmPerson nothing anywhere names
 *     them (the store's data-room counter aside, which keys room by slot).
 *   - Controls: under the cap nothing is removed; an accepted conversation is
 *     never removed by a later request; a send that is not a request trims
 *     nothing.
 *   - The removal read or written in another shape fails closed: send throws
 *     UnknownReplyError, the new message is not written, and every conversation
 *     still stored stays reachable from the recipient's lists, so a retry, the
 *     copy and the erasure still find it.
 */
import { MAX_REQUESTS, accept, conversationsOf, forgetDmPerson, inbox, parseDmSetting, requestCount, send } from "@/lib/community-dm";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

type Command = (string | number)[];

const setting = parseDmSetting({ on: true, between: true, ask: true });

// One second further for every message, so the newest request is always the last one sent.
let clock = Date.UTC(2026, 10, 8, 12, 0, 0);
const realNow = Date.now;
Date.now = () => clock;
const tick = () => {
  clock += 1000;
};

/** A reply set for the removal path: on a read of a request list's overflow, or on a deletion of a conversation. */
let odd: { on: "read" | "delete" | "unlist"; reply: unknown } | null = null;
const pipeline = redis.pipeline.bind(redis);
const isChat = (key: unknown) => typeof key === "string" && /:dm:(?![iqxr]:)/.test(key);
redis.pipeline = (async (commands: Command[]) => {
  if (odd?.on === "read" && commands.some((c) => c[0] === "ZREVRANGE" && String(c[1]).includes(":dm:q:") && Number(c[2]) > 0)) return odd.reply;
  if (odd?.on === "delete" && commands.some((c) => c[0] === "DEL" && isChat(c[1]))) {
    await pipeline(commands);
    return odd.reply;
  }
  if (odd?.on === "unlist" && commands.length && commands.every((c) => c[0] === "ZREM" && String(c[1]).includes(":dm:q:"))) {
    await pipeline(commands);
    return odd.reply;
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

/** A list with a hole where its first member should be. */
function holed(): string[] {
  const list = ["fin.y000", "fin.y001"];
  delete list[0];
  return list;
}

const name = (prefix: string, i: number) => `${prefix}${String(i).padStart(3, "0")}`;

/** Every key and every value in the store as text, data-room counters aside. */
async function everything(): Promise<{ key: string; text: string }[]> {
  const out: { key: string; text: string }[] = [];
  for (const key of redis.keys()) {
    if (key.startsWith("nl:data:")) continue;
    const [type] = await pipeline([["TYPE", key]]);
    const read: Command =
      type === "zset" ? ["ZREVRANGE", key, 0, -1] : type === "list" ? ["LRANGE", key, 0, -1] : type === "hash" ? ["HGETALL", key] : type === "set" ? ["SMEMBERS", key] : ["GET", key];
    const [value] = await pipeline([read]);
    out.push({ key, text: JSON.stringify(value) });
  }
  return out;
}

/** The keys or values that still name this member. */
async function naming(who: string): Promise<string[]> {
  return (await everything()).filter(({ key, text }) => key.includes(who) || text.includes(who)).map(({ key }) => key);
}

/** The conversations stored with this member: their message lists that exist. */
async function storedWith(id: string, who: string): Promise<string[]> {
  return redis
    .keys()
    .filter((key) => key.startsWith(`nl:cm:${id}:dm:`) && isChat(key))
    .map((key) => key.slice(`nl:cm:${id}:dm:`.length))
    .filter((pair) => pair.split(".").includes(who))
    .sort();
}

/** The pairs with this member that some other person's inbox lists. */
async function listedBy(id: string, who: string): Promise<string[]> {
  const found = new Set<string>();
  for (const key of redis.keys()) {
    if (!key.startsWith(`nl:cm:${id}:dm:i:`) || key.endsWith(`:${who}`)) continue;
    const [members] = await pipeline([["ZREVRANGE", key, 0, -1]]);
    for (const pair of members as string[]) if (pair.split(".").includes(who)) found.add(pair);
  }
  return [...found].sort();
}

/** The pairs reachable from this member's own lists. */
async function reachable(id: string, who: string): Promise<string[]> {
  const [mine, asked] = await pipeline([
    ["ZREVRANGE", `nl:cm:${id}:dm:i:${who}`, 0, -1],
    ["ZREVRANGE", `nl:cm:${id}:dm:q:${who}`, 0, -1],
  ]);
  return [...new Set([...(mine as string[]), ...(asked as string[])])].sort();
}

/** What a send answered: its result, or "unknown" when it threw UnknownReplyError. */
async function sendOdd(on: "read" | "delete" | "unlist", reply: unknown, id: string, from: string, to: string, text: string): Promise<unknown> {
  odd = { on, reply };
  try {
    return await send(id, setting, from, to, text, ROOM);
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`;
  } finally {
    odd = null;
  }
}

/** Fills a member's request list with `count` requests from `prefix` senders. */
async function fill(id: string, prefix: string, to: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    tick();
    const sent = await send(id, setting, name(prefix, i), to, `hello ${to} from ${name(prefix, i)}`, ROOM);
    if (!sent.ok || !sent.asked) throw new Error(`setup send ${i} was not a request: ${JSON.stringify(sent)}`);
  }
}

async function main(): Promise<void> {
  redis.clear();
  const id = "cmr30trim01";

  part("101 requests to one member: the one past the cap goes whole");
  {
    await fill(id, "s", "bea", MAX_REQUESTS + 1);
    const oldest = "bea.s000";
    is("bea holds MAX_REQUESTS requests", await requestCount(id, "bea"), MAX_REQUESTS);
    is("the oldest request is no longer in bea's lists", (await reachable(id, "bea")).includes(oldest), false);
    is("its conversation is gone", (await storedWith(id, "bea")).includes(oldest), false);
    is("its read marks are gone", redis.keys().includes(`nl:cm:${id}:dm:r:${oldest}`), false);
    is("its sender's inbox no longer lists it", (await listedBy(id, "bea")).includes(oldest), false);
    is("every conversation stored with bea is reachable from bea's lists", await storedWith(id, "bea"), await reachable(id, "bea"));
    is("no other inbox lists a pair with bea that bea cannot reach", await listedBy(id, "bea"), await reachable(id, "bea"));
    const copy = await conversationsOf(id, "bea");
    is("bea's copy holds every conversation stored with her", copy.length, (await storedWith(id, "bea")).length);
    is("each one in her copy is a request with its one message", copy.every((c) => c.request && c.messages.length === 1 && !c.messages[0].mine), true);
    is("forgetDmPerson goes through all of them", await forgetDmPerson(id, "bea"), MAX_REQUESTS);
    is("after it, nothing anywhere names bea", await naming("bea"), []);
  }

  part("Control: under the cap nothing is removed");
  {
    await fill(id, "t", "cyd", MAX_REQUESTS);
    is("cyd holds all of them", await requestCount(id, "cyd"), MAX_REQUESTS);
    is("every conversation is still stored", (await storedWith(id, "cyd")).length, MAX_REQUESTS);
    is("and each is reachable", await storedWith(id, "cyd"), await reachable(id, "cyd"));
    is("every sender still lists theirs", (await listedBy(id, "cyd")).length, MAX_REQUESTS);
    is("cyd's copy holds all of them", (await conversationsOf(id, "cyd")).length, MAX_REQUESTS);
  }

  part("Control: an accepted conversation is never removed by later requests");
  {
    tick();
    is("an early request to dan", await send(id, setting, "uma", "dan", "hi dan", ROOM), { ok: true, asked: true });
    is("dan accepts it", await accept(id, "dan", "dan.uma"), true);
    await fill(id, "v", "dan", MAX_REQUESTS + 2);
    is("dan holds MAX_REQUESTS requests", await requestCount(id, "dan"), MAX_REQUESTS);
    is("the accepted conversation is still in dan's inbox", (await inbox(id, "dan")).map((c) => c.pair), ["dan.uma"]);
    is("and still stored", (await storedWith(id, "dan")).includes("dan.uma"), true);
    is("the two oldest requests went whole", [(await storedWith(id, "dan")).includes("dan.v000"), (await storedWith(id, "dan")).includes("dan.v001")], [false, false]);
    is("every conversation stored with dan is reachable", await storedWith(id, "dan"), await reachable(id, "dan"));
    is("no other inbox lists a pair dan cannot reach", await listedBy(id, "dan"), await reachable(id, "dan"));
    is("dan's copy holds every stored conversation", (await conversationsOf(id, "dan")).length, MAX_REQUESTS + 1);
  }

  part("Control: a send that is not a request trims nothing");
  {
    await fill(id, "w", "eve", MAX_REQUESTS);
    tick();
    is("the creator writes to eve without asking", await send(id, setting, "creator", "eve", "welcome", ROOM), { ok: true, asked: false });
    tick();
    const open = parseDmSetting({ on: true, between: true, ask: false });
    is("with requests off a stranger writes straight in", await send(id, open, "xan", "eve", "hi", ROOM), { ok: true, asked: false });
    is("eve still holds all her requests", await requestCount(id, "eve"), MAX_REQUESTS);
    is("and every conversation is stored", (await storedWith(id, "eve")).length, MAX_REQUESTS + 2);
  }

  part("The removal read in another shape fails closed");
  {
    await fill(id, "y", "fin", MAX_REQUESTS);
    for (const [what, reply] of [
      ["cut short", []],
      ["nothing", [null]],
      ["a number in the list", [[1]]],
      ["a hole", [holed()]],
    ] as [string, unknown][]) {
      tick();
      const got = await sendOdd("read", reply, id, "zed", "fin", `hello (${what})`);
      is(`read as ${what}: unknown, the new message not written`, [got, (await storedWith(id, "fin")).includes("fin.zed")], ["unknown", false]);
    }
    is("fin still holds all her requests", await requestCount(id, "fin"), MAX_REQUESTS);
    is("every conversation stored with fin is reachable", await storedWith(id, "fin"), await reachable(id, "fin"));
  }

  part("The removal written in another shape fails closed, and a retry finishes it");
  {
    await fill(id, "g", "gil", MAX_REQUESTS);
    for (const [on, what, reply] of [
      ["delete", "cut short", []],
      ["delete", "nothing", [null, null, null]],
      ["delete", "text", ["1", "1", "1"]],
      ["unlist", "cut short", []],
      ["unlist", "nothing", [null]],
    ] as ["delete" | "unlist", string, unknown][]) {
      // A removal that went through before its reply was lost leaves room: the list is topped up to full again, so
      // every case meets a full list.
      for (let more = 0; (await requestCount(id, "gil")) < MAX_REQUESTS; more += 1) {
        tick();
        await send(id, setting, name(`k${on}${what.length}x`, more), "gil", "one more", ROOM);
      }
      tick();
      const got = await sendOdd(on, reply, id, "hal", "gil", `hello (${on}, ${what})`);
      is(`${on} answered as ${what}: unknown, the new message not written`, [got, (await storedWith(id, "gil")).includes("gil.hal")], ["unknown", false]);
      const reach = await reachable(id, "gil");
      is(`${on} answered as ${what}: every conversation stored with gil is still in her lists`, (await storedWith(id, "gil")).filter((pair) => !reach.includes(pair)), []);
      is(`${on} answered as ${what}: no other inbox lists a pair gil cannot reach`, (await listedBy(id, "gil")).filter((pair) => !reach.includes(pair)), []);
    }
    tick();
    is("with confirmed replies the same send goes through", await send(id, setting, "hal", "gil", "hello again", ROOM), { ok: true, asked: true });
    is("gil holds MAX_REQUESTS requests", await requestCount(id, "gil"), MAX_REQUESTS);
    is("every conversation stored with gil is reachable", await storedWith(id, "gil"), await reachable(id, "gil"));
    is("no other inbox lists a pair gil cannot reach", await listedBy(id, "gil"), await reachable(id, "gil"));
    await forgetDmPerson(id, "gil");
    is("after forgetDmPerson nothing anywhere names gil", await naming("gil"), []);
  }

  Date.now = realNow;
  done();
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
