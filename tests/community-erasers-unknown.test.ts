// A member's erasure from a community (lib/community-erasure.ts) runs these
// erasers. A lost or off-shape Redis reply is not "nothing to erase": each one
// throws before deleting anything, so lib/person-erasure.ts reports the erasure
// incomplete and it is retried. Only an exact empty reply means nothing there.
// Synthetic Redis only (tests/redis-stub.ts).
import { forgetChatPerson } from "@/lib/community-chat";
import { forgetDmPerson } from "@/lib/community-dm";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const COMMUNITY = "c".repeat(32);
const MEMBER = "a".repeat(32);
const OTHER = "b".repeat(32);
const THIRD = "d".repeat(32);
const base = `nl:cm:${COMMUNITY}`;

const ROOM = `${base}:ch`;
const SPOKE = (who: string) => `${base}:chs:${who}`;
const mine = JSON.stringify({ i: 1, a: MEMBER, text: "Mine", at: 100 });
const theirs = JSON.stringify({ i: 2, a: OTHER, text: "Theirs", at: 101 });

const PAIR = `${MEMBER}.${OTHER}`;
const PAIR2 = `${MEMBER}.${THIRD}`;
const CHAT = (pair: string) => `${base}:dm:${pair}`;
const READ = (pair: string) => `${base}:dm:r:${pair}`;
const INBOX = (who: string) => `${base}:dm:i:${who}`;
const ASKED = (who: string) => `${base}:dm:q:${who}`;
const SHUT = (who: string) => `${base}:dm:x:${who}`;

const original: typeof redis.pipeline = redis.pipeline.bind(redis);
let sent: (string | number)[][] = [];

/** Runs the commands, then answers with this instead: a reply lost or changed after Redis did the work. */
class After {
  constructor(readonly reply: unknown) {}
}

/**
 * Answers each pipeline call with the next scripted reply: `undefined` lets the
 * stand-in answer, an After runs the commands and answers with its reply, and
 * anything else answers without running them.
 */
function script(replies: unknown[]): void {
  let call = 0;
  sent = [];
  redis.pipeline = (async (batch) => {
    sent.push(...batch);
    const reply = replies[call++];
    if (reply === undefined) return original(batch);
    if (reply instanceof After) {
      await original(batch);
      return reply.reply as unknown[];
    }
    return reply as unknown[];
  }) as typeof redis.pipeline;
}

async function refuses(run: () => Promise<number>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  } finally {
    redis.pipeline = original;
  }
}

async function answer(run: () => Promise<number>): Promise<number | "threw"> {
  try {
    return await run();
  } catch {
    return "threw";
  } finally {
    redis.pipeline = original;
  }
}

const deletes = () => sent.filter(([name]) => name === "DEL" || name === "ZREM" || name === "HDEL").length;

function seedRoom(): void {
  redis.clear();
  redis.run(["ZADD", ROOM, 100, mine]);
  redis.run(["ZADD", ROOM, 101, theirs]);
  redis.run(["SET", SPOKE(MEMBER), "1"]);
}

function seedDms(): void {
  redis.clear();
  redis.run(["RPUSH", CHAT(PAIR), JSON.stringify({ a: MEMBER, text: "Hi", at: 1 })]);
  redis.run(["HSET", READ(PAIR), MEMBER, 1]);
  redis.run(["RPUSH", CHAT(PAIR2), JSON.stringify({ a: THIRD, text: "Hello", at: 2 })]);
  redis.run(["ZADD", INBOX(MEMBER), 1, PAIR]);
  redis.run(["ZADD", INBOX(OTHER), 1, PAIR]);
  redis.run(["ZADD", ASKED(MEMBER), 2, PAIR2]);
  redis.run(["ZADD", INBOX(THIRD), 2, PAIR2]);
  redis.run(["SADD", SHUT(MEMBER), THIRD]);
}

const sparse = (n: number): unknown[] => {
  const list: unknown[] = [];
  list.length = n;
  return list;
};

async function main(): Promise<void> {
  part("Room: a lost or off-shape read deletes nothing and is not done");
  const roomReads: [string, unknown][] = [
    ["a null pipeline", null],
    ["a non-list pipeline", { 0: [mine], length: 1 }],
    ["a short pipeline", []],
    ["an extra reply", [[mine], []]],
    ["a null room", [null]],
    ["a text room", ["nope"]],
    ["an object room", [{}]],
    ["a non-string entry", [[mine, 7]]],
    ["a hole in the room", [sparse(1)]],
  ];
  for (const [label, reply] of roomReads) {
    seedRoom();
    script([reply]);
    is(`${label} throws`, await refuses(() => forgetChatPerson(COMMUNITY, MEMBER)), true);
    is(`${label} sends no delete`, deletes(), 0);
    is(`${label} keeps their line`, redis.run(["ZSCORE", ROOM, mine]) !== null, true);
  }

  part("Room: an unknown answer to the delete is not done");
  for (const [label, reply] of [["a null delete answer", null], ["a short delete answer", [1]], ["a text delete answer", ["OK", 1]]] as [string, unknown][]) {
    seedRoom();
    script([undefined, new After(reply)]);
    is(`${label} throws`, await refuses(() => forgetChatPerson(COMMUNITY, MEMBER)), true);
  }

  part("Room controls");
  redis.clear();
  redis.run(["SET", SPOKE(MEMBER), "1"]);
  is("an exact empty room finishes with nothing", await answer(() => forgetChatPerson(COMMUNITY, MEMBER)), 0);
  is("an exact empty room still clears the cooldown", redis.run(["EXISTS", SPOKE(MEMBER)]), 0);
  seedRoom();
  is("a healthy room erases their one line", await answer(() => forgetChatPerson(COMMUNITY, MEMBER)), 1);
  is("their line is gone", redis.run(["ZRANGEBYSCORE", ROOM, "-inf", "+inf"]), [theirs]);
  is("their cooldown is gone", redis.run(["EXISTS", SPOKE(MEMBER)]), 0);

  part("Private messages: a lost or off-shape read deletes nothing, own lists included");
  const dmReads: [string, unknown][] = [
    ["a null pipeline", null],
    ["a non-list pipeline", "OK"],
    ["a short pipeline", [[PAIR]]],
    ["an empty pipeline", []],
    ["an extra reply", [[PAIR], [PAIR2], []]],
    ["a null inbox", [null, [PAIR2]]],
    ["a null requests list", [[PAIR], null]],
    ["an object inbox", [{}, []]],
    ["a non-string entry", [[PAIR, 3], []]],
    ["a hole in the requests", [[PAIR], sparse(1)]],
  ];
  for (const [label, reply] of dmReads) {
    seedDms();
    script([reply]);
    is(`${label} throws`, await refuses(() => forgetDmPerson(COMMUNITY, MEMBER)), true);
    is(`${label} sends no delete`, deletes(), 0);
    is(`${label} keeps their inbox`, redis.run(["EXISTS", INBOX(MEMBER)]), 1);
    is(`${label} keeps the conversation`, redis.run(["EXISTS", CHAT(PAIR)]), 1);
  }

  part("Private messages: their own lists go only after the conversations are confirmed gone");
  for (const [label, reply] of [["a null delete answer", null], ["a short delete answer", [1]], ["a text delete answer", ["OK", 1, 1, 1, 1, 1]]] as [string, unknown][]) {
    seedDms();
    script([undefined, new After(reply)]);
    is(`${label} throws`, await refuses(() => forgetDmPerson(COMMUNITY, MEMBER)), true);
    is(`${label} keeps their inbox for the retry`, redis.run(["EXISTS", INBOX(MEMBER)]), 1);
    is(`${label} keeps their requests for the retry`, redis.run(["EXISTS", ASKED(MEMBER)]), 1);
  }
  seedDms();
  script([undefined, undefined, new After(null)]);
  is("an unknown answer to deleting their own lists throws", await refuses(() => forgetDmPerson(COMMUNITY, MEMBER)), true);

  part("Private messages controls");
  redis.clear();
  redis.run(["SADD", SHUT(MEMBER), THIRD]);
  is("exact empty lists finish with nothing", await answer(() => forgetDmPerson(COMMUNITY, MEMBER)), 0);
  is("exact empty lists still clear who they declined", redis.run(["EXISTS", SHUT(MEMBER)]), 0);
  seedDms();
  is("healthy lists erase both conversations", await answer(() => forgetDmPerson(COMMUNITY, MEMBER)), 2);
  is("the first conversation is gone", redis.run(["EXISTS", CHAT(PAIR)]), 0);
  is("its read marks are gone", redis.run(["EXISTS", READ(PAIR)]), 0);
  is("the request is gone", redis.run(["EXISTS", CHAT(PAIR2)]), 0);
  is("the other person's index no longer points to it", redis.run(["ZSCORE", INBOX(OTHER), PAIR]), null);
  is("the third person's index no longer points to it", redis.run(["ZSCORE", INBOX(THIRD), PAIR2]), null);
  is("their inbox is gone", redis.run(["EXISTS", INBOX(MEMBER)]), 0);
  is("their requests are gone", redis.run(["EXISTS", ASKED(MEMBER)]), 0);
  is("who they declined is gone", redis.run(["EXISTS", SHUT(MEMBER)]), 0);

  done();
}

void main();
