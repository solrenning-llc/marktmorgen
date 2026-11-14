/**
 * Rule 30 (Claude 2's review of #3134, M1), synthetic only: in the closing walk (lib/closed-store-data.ts) every read
 * that leads to a closing store's personal data is exact. A reply in another shape, a pipeline with too few or too many
 * replies, or a list of a key's members cut at a ceiling is unknown: never an empty batch, never a key of no kind,
 * never no members and never no values.
 *
 * Until this, each of these read an unknown reply as empty, and the walk went on as if it had read it:
 *
 * - readBatch (HGETALL of the walk's batch): an empty batch, so that run's pages deleted nothing and the cursor moved
 *   on; a later run that read the batch finished every store and emailed its owner while those pages' keys remained.
 * - typeOf (TYPE): "none", so a company list kept the store's members and a follower read no members.
 * - unionOf (SUNION) and stringsOf (MGET): no members and no values, so a follower found nothing, and the
 *   certificates, chat links (and the rest) the store's keys lead to stayed.
 * - membersOf, a list (LRANGE 0..9999): a list longer than 10,000 was cut there in silence, and what its members
 *   lead to past it stayed.
 *
 * Now each throws UnknownReplyError: the run stops, the cursor stays where it was, the store stays in the batch and is
 * not finished (no done email), and the next run, whose replies read, erases it and finishes it. A list is read
 * 10,000 at a command, as before, until it ends, within the same member ceiling as a set's walk. A SUNION whose
 * pipeline throws (a key of another kind, WRONGTYPE) still reads each key on its own, by its kind.
 */
import { BATCH_KEY, WALK_KEY, eraseClosed, type Batched } from "@/lib/closed-store-data";
import { leadsKey } from "@/lib/contacts";
import { tokenKey as chatTokenKey } from "@/lib/inbox";
import { certKey } from "@/lib/certificate";
import { broadcastKeys } from "@/lib/broadcasts";
import { letterRecordKey } from "@/lib/letters";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;

type Commands = (string | number)[][];
const original = redis.pipeline.bind(redis);
const THROW = Symbol("throw");
const NO_REPLY = Symbol("no reply");
const TWO_REPLIES = Symbol("two replies");

/** Every single-command pipeline whose word is `word` answers `answer(call)` (counting from 0) instead of the stub's. */
function answering(word: string, answer: (call: number) => unknown): void {
  let call = 0;
  redis.pipeline = (async (commands: Commands) => {
    if (commands.length === 1 && commands[0][0] === word) {
      const reply = answer(call++);
      if (reply === THROW) throw new Error("synthetic pipeline failure");
      if (reply === NO_REPLY) return [];
      if (reply === TWO_REPLIES) {
        const real = await original(commands);
        return [...real, ...real];
      }
      return [reply];
    }
    return original(commands);
  }) as typeof redis.pipeline;
}

/** What a run did: "unknown" (UnknownReplyError), "threw" (another error) or what it answered. */
async function outcome(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : "threw";
  } finally {
    redis.pipeline = original;
  }
}

// ------------------------------------------------------------------ a closing store and what its keys lead to

const LIST = "a".repeat(32);
const STATS = "b".repeat(24);
const SID = "c".repeat(24);
const COURSE = "d".repeat(16);
const INDEX = "nl:mail:queue";
const OURS = `${LIST}|job`;
const CONVERSATION = `nl:inbox:${STATS}:c:conv0001`;
const CHAT = "t".repeat(32);
const CERTS = `nl:course:${COURSE}:certs:all`;
const CERT = "cert000001";
const BROADCASTS = `nl:mail:bcs:${LIST}`;
const LETTERS = `nl:letters:s:${SID}`;
const LETTER = "e".repeat(20);
const broadcastId = (i: number) => i.toString(16).padStart(24, "0");
const entry: Batched = {
  ref: "owner@example.com", email: "owner@example.com", sid: SID, statsId: STATS, name: "Closing store",
  handle: "closing", handles: ["closing"], marks: [COURSE, LIST, SID, STATS], endedAt: 1, at: 1,
};
let finished: string[] = [];
/** The oldest broadcast: the last of the list, past 10,000 when the list is longer. */
let oldest = broadcastId(0);

async function closingWorld(broadcasts = 1): Promise<void> {
  redis.clear();
  finished = [];
  oldest = broadcastId(0);
  const ids = Array.from({ length: broadcasts }, (_, i) => broadcastId(i));
  await original([
    ["HSET", WALK_KEY, "phase", "walk", "cursor", "0", "started", Date.now()],
    ["HSET", BATCH_KEY, entry.ref, JSON.stringify(entry)],
    ["SADD", INDEX, OURS, "other|job"],
    ["HSET", leadsKey(LIST), "buyer@example.com", JSON.stringify({ agreed: true, t: "" })],
    ["SET", CONVERSATION, JSON.stringify({ token: CHAT })],
    ["SET", chatTokenKey(CHAT), "the visitor's chat"],
    ["SADD", CERTS, CERT],
    ["SET", certKey(CERT), "a buyer's certificate"],
    ...Array.from({ length: Math.ceil(ids.length / 1000) }, (_, i) => ["LPUSH", BROADCASTS, ...ids.slice(i * 1000, i * 1000 + 1000)]),
    ["SET", broadcastKeys(oldest)[0], "the oldest broadcast"],
    ["ZADD", LETTERS, 1, LETTER],
    ["SET", letterRecordKey(LETTER), "a published email"],
  ]);
}

async function walk(): Promise<string> {
  const report = await eraseClosed(Date.now() + 60_000, async (e) => void finished.push(e.ref));
  return `done:${report.done} finished:${report.finished}`;
}

/** What of the store is still here, by name. */
async function leftBehind(): Promise<string[]> {
  const named: [string, Commands[number]][] = [
    ["its contacts", ["EXISTS", leadsKey(LIST)]],
    ["its conversation", ["EXISTS", CONVERSATION]],
    ["its visitor's chat link", ["EXISTS", chatTokenKey(CHAT)]],
    ["its course's certificates", ["EXISTS", CERTS]],
    ["a buyer's certificate", ["EXISTS", certKey(CERT)]],
    ["its broadcasts", ["EXISTS", BROADCASTS]],
    ["its oldest broadcast", ["EXISTS", broadcastKeys(oldest)[0]]],
    ["its letters", ["EXISTS", LETTERS]],
    ["a published email", ["EXISTS", letterRecordKey(LETTER)]],
    ["its batch entry", ["HEXISTS", BATCH_KEY, entry.ref]],
  ];
  const [member, ...replies] = await original([["SISMEMBER", INDEX, OURS], ...named.map(([, command]) => command)]);
  return [...(member ? ["its list member"] : []), ...named.filter((_, i) => replies[i]).map(([name]) => name)];
}

/** The replies that are not a reply, for every read: each should come to "unknown", a thrown pipeline to "threw". */
const COMMON: [string, () => unknown, string][] = [
  ["QUEUED", () => "QUEUED", "unknown"],
  ["null", () => null, "unknown"],
  ["a number", () => 7, "unknown"],
  ["no reply for the command", () => NO_REPLY, "unknown"],
  ["two replies for one command", () => TWO_REPLIES, "unknown"],
  ["a thrown pipeline", () => THROW, "threw"],
];

type Read = { read: string; word: string; shapes: [string, () => unknown, string][]; reaches: string };

const READS: Read[] = [
  {
    read: "readBatch (HGETALL of the walk's batch)",
    word: "HGETALL",
    reaches: "its contacts",
    shapes: [
      ...COMMON,
      ["an odd list (a field with no value)", () => [entry.ref], "unknown"],
      ["a value that is not a string", () => [entry.ref, 1], "unknown"],
      ["an object instead of a list", () => ({ [entry.ref]: JSON.stringify(entry) }), "unknown"],
    ],
  },
  {
    read: "typeOf (TYPE of a company list and of a follower's keys)",
    word: "TYPE",
    reaches: "its list member",
    shapes: [
      ...COMMON,
      ["an empty string", () => "", "unknown"],
      ["an object", () => ({ ok: "set" }), "unknown"],
      ["a list", () => ["set"], "unknown"],
    ],
  },
  {
    read: "unionOf (SUNION of a course's certificates)",
    word: "SUNION",
    reaches: "a buyer's certificate",
    shapes: [
      ...COMMON.filter(([label]) => label !== "a thrown pipeline"),
      ["a member that is not a string", () => [1], "unknown"],
      ["a list that is not an array", () => "cert000001", "unknown"],
    ],
  },
  {
    read: "stringsOf (MGET of the inbox's conversations)",
    word: "MGET",
    reaches: "its visitor's chat link",
    shapes: [
      ...COMMON,
      ["fewer values than keys", () => [], "unknown"],
      ["more values than keys", () => [JSON.stringify({ token: CHAT }), "x"], "unknown"],
      ["a value that is not a string nor null", () => [1], "unknown"],
    ],
  },
  {
    read: "membersOf, a list (LRANGE of the store's broadcasts)",
    word: "LRANGE",
    reaches: "its oldest broadcast",
    shapes: [
      ...COMMON,
      ["a member that is not a string", () => [1], "unknown"],
      ["an object", () => ({ 0: broadcastId(0) }), "unknown"],
    ],
  },
];

async function main(): Promise<void> {
  part("Replies that read are read as they are (control)");
  await closingWorld();
  is("the closing walk erases the store and everything its keys lead to, and finishes it", [await outcome(walk), finished, await leftBehind()], ["done:true finished:1", [entry.ref], []]);

  for (const { read, word, shapes, reaches } of READS) {
    part(`lib/closed-store-data.ts, ${read}: a reply that does not read is unknown, not empty`);
    for (const [label, answer, want] of shapes) {
      await closingWorld();
      answering(word, answer);
      const got = await outcome(walk);
      const left = await leftBehind();
      is(`${label}: ${want}`, got, want);
      is(`${label}: the store is not finished, stays in the batch, and ${reaches} is still here`, [finished, left.includes("its batch entry"), left.includes(reaches)], [[], true, true]);
      is(`${label}: the next run, whose replies read, erases it and finishes it`, [await outcome(walk), finished, await leftBehind()], ["done:true finished:1", [entry.ref], []]);
    }
  }

  part("lib/closed-store-data.ts, unionOf: a SUNION whose pipeline throws (a key of another kind) reads each key on its own");
  await closingWorld();
  answering("SUNION", () => THROW);
  is("every key read on its own: the store erased and finished", [await outcome(walk), finished, await leftBehind()], ["done:true finished:1", [entry.ref], []]);

  part("lib/closed-store-data.ts, membersOf: a list longer than 10,000 is read to its end, not cut at 10,000");
  {
    await closingWorld(10_001);
    const pages: (string | number)[][] = [];
    redis.pipeline = (async (commands: Commands) => {
      if (commands.length === 1 && commands[0][0] === "LRANGE") pages.push(commands[0].slice(2));
      return original(commands);
    }) as typeof redis.pipeline;
    const got = await outcome(walk);
    is("10,001 broadcasts: the walk erases every one, the oldest too, and finishes the store", [got, finished, await leftBehind()], ["done:true finished:1", [entry.ref], []]);
    is("read 10,000 at a command, as before, until the list ends", pages, [[0, 9_999], [10_000, 19_999]]);
  }

  part("The review's case: a batch that does not read in one run, and reads in the next");
  {
    // The database in two pages: the store's keys on the first, nothing on the second.
    const storeKeys = [INDEX, leadsKey(LIST), CONVERSATION, CERTS, BROADCASTS, LETTERS];
    let secondPage: unknown = ["0", []];
    const twoPages = (batchReply: () => unknown) => {
      redis.pipeline = (async (commands: Commands) => {
        if (commands.length === 1 && commands[0][0] === "SCAN") {
          if (String(commands[0][1]) === "0") return [["7", storeKeys]];
          if (secondPage === THROW) throw new Error("synthetic pipeline failure");
          return [secondPage];
        }
        if (commands.length === 1 && commands[0][0] === "HGETALL" && commands[0][1] === BATCH_KEY) {
          const reply = batchReply();
          if (reply !== undefined) return [reply];
        }
        return original(commands);
      }) as typeof redis.pipeline;
    };
    await closingWorld();
    // The first run's batch does not read, and the run stops on its second page.
    secondPage = THROW;
    twoPages(() => "QUEUED");
    const first = await outcome(walk);
    const [cursor] = await original([["HGET", WALK_KEY, "cursor"]]);
    // The next run's batch reads.
    secondPage = ["0", []];
    twoPages(() => undefined);
    const second = await outcome(walk);
    is("the first run is unknown and leaves the cursor at the start", [first, cursor], ["unknown", "0"]);
    is("the next run erases the store and only then finishes it (its owner emailed)", [second, finished, await leftBehind()], ["done:true finished:1", [entry.ref], []]);
  }

  done();
}

main();
