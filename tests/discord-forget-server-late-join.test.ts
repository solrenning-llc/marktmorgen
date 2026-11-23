/**
 * A join already under way that writes its person between a Disconnect's people's deletes and its server's delete
 * never leaves the buyer's address linked to a Discord id with nobody to forget it (Board #5285, row #3017: the LOW
 * Claude 4 disclosed at 5b7a26d4 and Claude 1 carried at 5cea23413b, retained by Codex P).
 *
 * Not covered here: a join whose write lands after the whole Disconnect is over (it read the server before, and waited
 * on Discord through it). keepMember is not fenced on the server yet, so that person and their link are written
 * into a room with no server (Claude 3 yUZf's LEVE on #5380); it is its own row of the main board (#5010), to fence
 * keepMember on the server and the store.
 *
 * lib/discord-store.ts forgetServer deleted the people it read (FORGET_PEOPLE, which answers the people left), then, in
 * a second command, DEL of the server, its products' roles and the people's list. A keepMember landing between the
 * two (a join that read the connected server before the creator pressed Disconnect) wrote its row, its address link
 * and its due entry; the DEL then dropped the row and the server, and the link stayed, with no row and no server
 * naming it: a later Disconnect answers "not connected", and the periodic check drops the due entry only.
 *
 * Now the server, its products' roles and the list go in one step only while nobody is on the list (DROP_SERVER_IF_EMPTY):
 * a person written meanwhile keeps the server for the next press, which forgets them with their link.
 * Synthetic only: Redis is the in-memory stand-in; nothing reaches Discord.
 */
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { emailKey, storeKey } from "@/lib/learn";
import { forgetServer, keepMember } from "@/lib/discord-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "owner@discord-late-join.example";
const ANA = "ana@discord-late-join.example";
const BEN = "ben@discord-late-join.example";
const ANA_ID = "123456789012345681";
const BEN_ID = "123456789012345682";
const SERVER = "223456789012345688";
const ROLE = "323456789012345688";

type Command = (string | number)[];
const original = redis.pipeline.bind(redis);
/**
 * Run once, right after forgetServer's people's deletes answered: the join under way lands there. keepMember answers
 * whether it kept the person (Board #5010 row 187); this test only waits for it (Claude 3 ykH's LEVE on #5419).
 */
let lateJoin: (() => Promise<unknown>) | null = null;
redis.pipeline = (async (commands: Command[]) => {
  const answer = await original(commands);
  const first = commands[0];
  if (lateJoin && first && first[0] === "EVAL" && String(first[1]).startsWith("-- marktmorgen:discord-forget-people:")) {
    const join = lateJoin;
    lateJoin = null;
    await join();
  }
  return answer;
}) as typeof redis.pipeline;

async function outcome<T>(run: () => Promise<T>): Promise<T | string> {
  try {
    return await run();
  } catch (error) {
    return `rejected: ${error instanceof Error ? error.name : "?"}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "discord-late-join", "Discord Late Join", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const room = storeKey(store);
  const sid = store.sid;
  const keys = {
    server: `nl:dc:srv:${room}`,
    products: `nl:dc:prod:${room}`,
    members: `nl:dc:mem:${room}`,
    ana: `nl:dc:addr:${room}:${emailKey(ANA)}`,
    ben: `nl:dc:addr:${room}:${emailKey(BEN)}`,
  };
  const member = (email: string) => ({ e: email, n: "buyer", p: ["p1"], r: [ROLE], at: 1, checked: 1 });
  await original([
    ["SET", keys.server, JSON.stringify({ id: SERVER, name: "Server", at: 1, kick: false })],
    ["HSET", keys.products, "p1", JSON.stringify([ROLE])],
    ["HSET", keys.members, ANA_ID, JSON.stringify(member(ANA))],
    ["SET", keys.ana, ANA_ID],
    ["ZADD", "nl:dc:due", 100, `${sid}|${ANA_ID}`],
  ]);

  /** Ben's link, his row, the server and Ben's place in the check line. */
  const ben = async () => {
    const [link, row, server, due] = await original([["GET", keys.ben], ["HGET", keys.members, BEN_ID], ["EXISTS", keys.server], ["ZSCORE", "nl:dc:due", `${sid}|${BEN_ID}`]]);
    return { link, row: row !== null, server, due: due !== null };
  };

  part("A join lands between the people's deletes and the server's");
  lateJoin = () => keepMember(room, sid, BEN_ID, member(BEN));
  const first = await outcome(() => forgetServer(room, sid));
  is("the join did land", lateJoin, null);
  const after = await ben();
  is("Ben's address link is never left without his row and a server to forget him by", after.link === null || (after.row && after.server === 1), true);
  is("the first press is not said done: somebody was left", first, "rejected: UnknownReplyError");
  is("Ana, read by that press, is forgotten with her link", await original([["HGET", keys.members, ANA_ID], ["GET", keys.ana]]), [null, null]);

  part("The next press forgets the person who joined meanwhile");
  is("forgets Ben", await outcome(() => forgetServer(room, sid)), 1);
  is("nothing is left: no link, no row, no server, no check", await ben(), { link: null, row: false, server: 0, due: false });

  part("Nobody given roles, a join landing between the read and the server's delete keeps the server");
  await original([["SET", keys.server, JSON.stringify({ id: SERVER, name: "Server", at: 1, kick: false })]]);
  const reads = redis.pipeline;
  let raced = false;
  redis.pipeline = (async (commands: Command[]) => {
    const first = commands[0];
    // Right before the step that deletes the server: the join lands there.
    if (!raced && first && first[0] === "EVAL" && String(first[1]).startsWith("-- marktmorgen:discord-drop-server-if-empty:")) {
      raced = true;
      await keepMember(room, sid, BEN_ID, member(BEN));
    }
    if (!raced && first && first[0] === "DEL" && String(first[1]).startsWith("nl:dc:srv:")) {
      raced = true;
      await keepMember(room, sid, BEN_ID, member(BEN));
    }
    return reads(commands);
  }) as typeof redis.pipeline;
  const empty = await outcome(() => forgetServer(room, sid));
  redis.pipeline = reads;
  const left = await ben();
  is("the join landed", raced, true);
  is("Ben's link is never left without his row and a server", left.link === null || (left.row && left.server === 1), true);
  is("the press is not said done", empty, "rejected: UnknownReplyError");
  is("the next press forgets him", [await outcome(() => forgetServer(room, sid)), await ben()], [1, { link: null, row: false, server: 0, due: false }]);

  done();
}

main();
