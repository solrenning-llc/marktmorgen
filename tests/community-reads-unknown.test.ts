// A member's private conversations feed the copy of their data (GDPR access
// right, lib/person-copy.ts), and the room and their conversations feed the
// community search. A lost or off-shape Redis reply is not "no conversations"
// or "no match": each reader throws, so the copy fails whole (it is never
// handed over with a part silently missing) and the search page says it could
// not search instead of "No match". Only an exact empty reply means none.
// Synthetic Redis only (tests/redis-stub.ts).
import { searchRoom } from "@/lib/community-chat";
import { conversationsOf, searchMessages } from "@/lib/community-dm";
import { COPIERS } from "@/lib/person-copy";
import type { ErasureScope } from "@/lib/erasure-rules";
import { queryWords } from "@/lib/community-search";
import { COMMUNITY_WORDS } from "@/lib/buyer-words/community";
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const COMMUNITY = "c".repeat(32);
const MEMBER = "a".repeat(32);
const OTHER = "b".repeat(32);
const THIRD = "d".repeat(32);
const base = `nl:cm:${COMMUNITY}`;

const ROOM = `${base}:ch`;
const PAIR = `${MEMBER}.${OTHER}`;
const PAIR2 = `${MEMBER}.${THIRD}`;
const CHAT = (pair: string) => `${base}:dm:${pair}`;
const INBOX = (who: string) => `${base}:dm:i:${who}`;
const ASKED = (who: string) => `${base}:dm:q:${who}`;

const roomLine = (i: number, a: string, text: string, at: number) => JSON.stringify({ i, a, text, at });
const dmLine = (a: string, text: string, at: number) => JSON.stringify({ a, text, at });
const WORDS = queryWords("bread");

type Command = (string | number)[];
const original: typeof redis.pipeline = redis.pipeline.bind(redis);

/**
 * Answers the first pipeline call whose first command is `name` on `key` with
 * `reply` instead of what Redis holds; every other call is answered by the
 * stand-in. Other readers of the copy run alongside, so the call is picked by
 * what it asks, not by its order.
 */
function swap(name: string, key: string, reply: unknown): { hit: () => boolean } {
  let hit = false;
  redis.pipeline = (async (batch: Command[]) => {
    if (!hit && batch[0]?.[0] === name && batch[0]?.[1] === key) {
      hit = true;
      return reply as unknown[];
    }
    return original(batch);
  }) as typeof redis.pipeline;
  return { hit: () => hit };
}

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch {
    return "threw";
  } finally {
    redis.pipeline = original;
  }
}

const sparse = (n: number): unknown[] => {
  const list: unknown[] = [];
  list.length = n;
  return list;
};

function seedRoom(): void {
  redis.clear();
  redis.run(["ZADD", ROOM, 100, roomLine(1, MEMBER, "Fresh bread today", 100)]);
  redis.run(["ZADD", ROOM, 101, roomLine(2, OTHER, "Rye bread is best", 101)]);
  redis.run(["ZADD", ROOM, 102, roomLine(3, OTHER, "Nothing about it", 102)]);
}

function seedDms(): void {
  redis.clear();
  redis.run(["RPUSH", CHAT(PAIR), dmLine(MEMBER, "Bread on Sunday?", 1), dmLine(OTHER, "Yes, bread and jam", 2)]);
  redis.run(["RPUSH", CHAT(PAIR2), dmLine(THIRD, "Do you sell bread?", 3)]);
  redis.run(["ZADD", INBOX(MEMBER), 2, PAIR]);
  redis.run(["ZADD", INBOX(OTHER), 2, PAIR]);
  redis.run(["ZADD", ASKED(MEMBER), 3, PAIR2]);
  redis.run(["ZADD", INBOX(THIRD), 3, PAIR2]);
}

/** The community part of a person's copy, as lib/person-copy.ts builds it. */
const copyScope = { communityId: COMMUNITY, learner: MEMBER } as unknown as ErasureScope;
const copyCommunity = () => COPIERS["lib/community-erasure.ts"](copyScope);

async function main(): Promise<void> {
  const goodRoom = roomLine(9, OTHER, "Bread again", 109);
  const goodDm = dmLine(OTHER, "More bread", 9);

  part("Room search: a lost or off-shape read is unknown, never no match");
  const roomReads: [string, unknown][] = [
    ["a text pipeline", "OK"],
    ["a short pipeline", []],
    ["an extra reply", [[goodRoom], []]],
    ["a null room", [null]],
    ["a text room", ["nope"]],
    ["an object room", [{}]],
    ["a non-string entry", [[goodRoom, 7]]],
    ["a hole in the room", [sparse(1)]],
  ];
  for (const [label, reply] of roomReads) {
    seedRoom();
    const read = swap("ZREVRANGE", ROOM, reply);
    is(`${label} throws`, await outcome(() => searchRoom(COMMUNITY, WORDS)), "threw");
    is(`${label} was the reply read`, read.hit(), true);
  }

  part("Room search controls");
  redis.clear();
  is("an exact empty room finds nothing", await outcome(() => searchRoom(COMMUNITY, WORDS)), []);
  seedRoom();
  is("a healthy room finds both lines, newest first", ((await outcome(() => searchRoom(COMMUNITY, WORDS))) as { i: number }[]).map((m) => m.i), [2, 1]);
  is("no words searches nothing", await outcome(() => searchRoom(COMMUNITY, [])), []);

  part("Message search: an off-shape list of conversations is unknown, never no match");
  const inboxReads: [string, unknown][] = [
    ["a text pipeline", "OK"],
    ["a short pipeline", []],
    ["an extra reply", [[PAIR], []]],
    ["a null inbox", [null]],
    ["a text inbox", ["nope"]],
    ["a non-string entry", [[PAIR, 3]]],
    ["a hole in the inbox", [sparse(1)]],
  ];
  for (const [label, reply] of inboxReads) {
    seedDms();
    const read = swap("ZREVRANGE", INBOX(MEMBER), reply);
    is(`${label} throws`, await outcome(() => searchMessages(COMMUNITY, MEMBER, WORDS)), "threw");
    is(`${label} was the reply read`, read.hit(), true);
  }

  part("Message search: an off-shape read of the conversations is unknown, never no match");
  const listReads: [string, unknown][] = [
    ["a null pipeline", null],
    ["a short pipeline", []],
    ["a null conversation", [null]],
    ["a text conversation", ["nope"]],
    ["a non-string entry", [[goodDm, 5]]],
    ["a hole in the conversation", [sparse(1)]],
  ];
  for (const [label, reply] of listReads) {
    seedDms();
    redis.run(["ZREM", ASKED(MEMBER), PAIR2]);
    const read = swap("LRANGE", CHAT(PAIR), reply);
    is(`${label} throws`, await outcome(() => searchMessages(COMMUNITY, MEMBER, WORDS)), "threw");
    is(`${label} was the reply read`, read.hit(), true);
  }

  part("Message search controls");
  redis.clear();
  is("an exact empty inbox finds nothing", await outcome(() => searchMessages(COMMUNITY, MEMBER, WORDS)), []);
  seedDms();
  is(
    "a healthy inbox finds both lines of their conversation, newest first",
    ((await outcome(() => searchMessages(COMMUNITY, MEMBER, WORDS))) as { message: { text: string } }[]).map((h) => h.message.text),
    ["Yes, bread and jam", "Bread on Sunday?"],
  );
  redis.run(["DEL", CHAT(PAIR)]);
  is("a conversation with an exact empty list finds nothing", await outcome(() => searchMessages(COMMUNITY, MEMBER, WORDS)), []);

  part("Data copy: an off-shape read of their conversation lists is unknown, never fewer conversations");
  const listsReads: [string, unknown][] = [
    ["a null pipeline", null],
    ["a text pipeline", "OK"],
    ["a short pipeline", [[PAIR]]],
    ["an empty pipeline", []],
    ["an extra reply", [[PAIR], [PAIR2], []]],
    ["a null inbox", [null, [PAIR2]]],
    ["a null requests list", [[PAIR], null]],
    ["an object inbox", [{}, []]],
    ["a non-string entry", [[PAIR, 3], [PAIR2]]],
    ["a hole in the requests", [[PAIR], sparse(1)]],
  ];
  for (const [label, reply] of listsReads) {
    seedDms();
    const read = swap("ZRANGEBYSCORE", INBOX(MEMBER), reply);
    is(`${label} throws`, await outcome(() => conversationsOf(COMMUNITY, MEMBER)), "threw");
    is(`${label} was the reply read`, read.hit(), true);
  }

  part("Data copy: an off-shape read of a conversation is unknown, never fewer messages");
  const convoReads: [string, unknown][] = [
    ["a null pipeline", null],
    ["a short pipeline", [[goodDm]]],
    ["an extra reply", [[goodDm], [goodDm], []]],
    ["a null conversation", [null, [goodDm]]],
    ["a text conversation", [[goodDm], "nope"]],
    ["a non-string entry", [[goodDm, 5], [goodDm]]],
    ["a hole in a conversation", [sparse(1), [goodDm]]],
    ["a line that is not a message", [[goodDm, "{not json"], [goodDm]]],
  ];
  for (const [label, reply] of convoReads) {
    seedDms();
    const read = swap("LRANGE", CHAT(PAIR), reply);
    is(`${label} throws`, await outcome(() => conversationsOf(COMMUNITY, MEMBER)), "threw");
    is(`${label} was the reply read`, read.hit(), true);
  }

  part("Data copy: the community part of a person's copy is never complete-looking on an unknown read");
  for (const [label, name, key, reply] of [
    ["an off-shape inbox", "ZRANGEBYSCORE", INBOX(MEMBER), [null, [PAIR2]]],
    ["a lost list read", "ZRANGEBYSCORE", INBOX(MEMBER), []],
    ["an off-shape conversation", "LRANGE", CHAT(PAIR), [[goodDm, 5], [goodDm]]],
    ["a lost conversation read", "LRANGE", CHAT(PAIR), null],
  ] as [string, string, string, unknown][]) {
    seedDms();
    const read = swap(name, key, reply);
    is(`${label}: the copy's community part throws, so the whole copy fails`, await outcome(copyCommunity), "threw");
    is(`${label} was the reply read`, read.hit(), true);
  }

  part("Data copy controls");
  redis.clear();
  is("exact empty lists: no conversations", await outcome(() => conversationsOf(COMMUNITY, MEMBER)), []);
  is("exact empty lists: no community part in the copy", await outcome(copyCommunity), []);
  seedDms();
  is("healthy lists: every conversation and request, whole", await outcome(() => conversationsOf(COMMUNITY, MEMBER)), [
    { request: false, messages: [{ mine: true, fromCreator: false, text: "Bread on Sunday?", at: 1 }, { mine: false, fromCreator: false, text: "Yes, bread and jam", at: 2 }] },
    { request: true, messages: [{ mine: false, fromCreator: false, text: "Do you sell bread?", at: 3 }] },
  ]);
  const copied = (await outcome(copyCommunity)) as { privateMessages: { request: boolean; messages: unknown[] }[] }[];
  is("healthy lists: the copy carries both conversations", copied.map((r) => r.privateMessages.map((c) => [c.request, c.messages.length])), [[[false, 2], [true, 1]]]);
  redis.run(["DEL", CHAT(PAIR2)]);
  is("a request with an exact empty list is kept, with no messages", ((await outcome(() => conversationsOf(COMMUNITY, MEMBER))) as { messages: unknown[] }[]).map((c) => c.messages.length), [2, 0]);

  part("The search page: a search that could not be read is said, never no match");
  const page = readFileSync("app/[handle]/community/search/page.tsx", "utf8");
  is("no failed room or message search is turned into an empty list", /search(Room|Messages)\([^)]*\)\.catch\(\(\) => \[\]\)/.test(page), false);
  is("a failed room or message search is kept as unknown", page.includes("unread(searchRoom(id, used))") && page.includes("unread(searchMessages(id, key, used))"), true);
  is("an unknown tab carries no number", page.includes('{n === null ? null : <span className="cm-tab-n">{n}</span>}'), true);
  is("an unknown tab says so in a live region", page.includes('role="status">{w.searchUnread(unsearched)}</p>'), true);
  // Rule 23 (claude5/community-members-exact): the same guard now also holds back No match when the members found
  // could not be read (people === null, tests/community-members-exact.test.ts); the room and messages case is unchanged.
  is("an unknown tab never says No match", page.includes("{shown === 0 && !unsearched && people !== null ? ("), true);
  is("an unknown tab never says what was searched", page.includes('tab === "room" && roomHits ?') && page.includes('tab === "dm" && dmHits ?'), true);
  const english = COMMUNITY_WORDS.en.searchUnread;
  is("the English words, plain", [english("room"), english("dm")], [
    "The room could not be searched just now, so we cannot say whether it holds a match. Try again in a moment.",
    "Your messages could not be searched just now, so we cannot say whether they hold a match. Try again in a moment.",
  ]);
  for (const [code, words] of Object.entries(COMMUNITY_WORDS)) {
    if (code === "en") continue;
    is(`${code}: its own words for both tabs, not the English`, [words.searchUnread("room") !== english("room"), words.searchUnread("dm") !== english("dm"), words.searchUnread("room") !== words.searchUnread("dm")], [true, true, true]);
  }

  done();
}

void main();
