/**
 * Disconnecting a Discord server reads its deletes exactly (CX-123 rule 24; finding of the focal review on #3017).
 * Synthetic only: Redis is the in-memory stand-in, Discord a stand-in fetch (no network).
 *
 * lib/discord-store.ts forgetServer sent DEL (the server, the products' roles, the people, each address link) and
 * ZREM (the people due a check) and never read the answers: with replies [], ["QUEUED","QUEUED"] or ["x"] it still
 * returned the number of people, so "Disconnect" said "forgot 2 people" while the server, both members and each
 * address↔Discord link stayed stored. As forgetMember does (#2932), a missing, short, long, queued or impossible
 * count is unknown: it throws UnknownReplyError, and the studio's disconnect never answers ok with a count.
 *
 * Since Codex G's review of #3017 the people are deleted by name with their address links and due entries, and the
 * server, its products' roles and the emptied list after (DEL): each step is read exactly the same way. Since Codex G's
 * second review (6787959688) the people's deletes are one step, FORGET_PEOPLE (an EVAL answering the people deleted,
 * the links deleted and the people left), so each case below answers that step's one reply; the cases and what they
 * must give are those of the four replies of HDEL, ZREM, DEL and HLEN before it.
 */
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { emailKey, storeKey } from "@/lib/learn";
import { forgetServer } from "@/lib/discord-store";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as manageDiscord } from "@/app/api/store/discord/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "discord.com" && (init?.method ?? "GET") === "DELETE") return new Response(null, { status: 204 });
  return new Response(JSON.stringify({ message: "no stand-in" }), { status: 404 });
}) as typeof fetch;

const OWNER = "owner@discord-forget-server.example";
const ANA = "ana@discord-forget-server.example";
const BEN = "ben@discord-forget-server.example";
const ANA_ID = "123456789012345671";
const BEN_ID = "123456789012345672";
const SERVER = "223456789012345678";
const ROLE = "323456789012345678";

type Command = (string | number)[];
/**
 * Answers the first of forgetServer's deletes (the people's, FORGET_PEOPLE; with nobody kept, the server's DEL) with
 * `reply`, without applying it.
 */
let reply: { value: unknown } | null = null;
const original = redis.pipeline.bind(redis);
const isDelete = (command: Command | undefined) =>
  Boolean(command) &&
  ((command![0] === "EVAL" && String(command![1]).startsWith("-- marktmorgen:discord-forget-people:v1\n")) || (command![0] === "DEL" && String(command![1]).startsWith("nl:dc:srv:")));
redis.pipeline = (async (commands: Command[]) => {
  if (reply && commands.length && isDelete(commands[0])) {
    const answer = reply.value;
    reply = null;
    return answer;
  }
  return original(commands);
}) as typeof redis.pipeline;

async function outcome<T>(run: () => Promise<T>): Promise<T | string> {
  try {
    return await run();
  } catch (error) {
    return `rejected: ${error instanceof Error ? error.name : "?"}`;
  }
}

async function main(): Promise<void> {
  process.env.DISCORD_CLIENT_ID = "400000000000000001";
  process.env.DISCORD_CLIENT_SECRET = "synthetic-secret";
  process.env.DISCORD_BOT_TOKEN = "synthetic-token";
  redis.clear();
  await claimHandle(OWNER, "discord-forget-server", "Discord Forget Server", "");
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
  const member = (email: string) => JSON.stringify({ e: email, n: "buyer", p: ["p1"], r: [ROLE], at: 1, checked: 1 });

  async function seed(people = true): Promise<void> {
    reply = null;
    await original([["DEL", ...Object.values(keys)], ["ZREM", "nl:dc:due", `${sid}|${ANA_ID}`, `${sid}|${BEN_ID}`]]);
    await original([
      ["SET", keys.server, JSON.stringify({ id: SERVER, name: "Server", at: 1, kick: false })],
      ["HSET", keys.products, "p1", JSON.stringify([ROLE])],
      ...(people
        ? [
            ["HSET", keys.members, ANA_ID, member(ANA)],
            ["HSET", keys.members, BEN_ID, member(BEN)],
            ["SET", keys.ana, ANA_ID],
            ["SET", keys.ben, BEN_ID],
            ["ZADD", "nl:dc:due", 100, `${sid}|${ANA_ID}`],
            ["ZADD", "nl:dc:due", 100, `${sid}|${BEN_ID}`],
          ]
        : []),
    ]);
  }

  /** What is still kept: the server, how many people, each address link and each place in the check line. */
  async function kept(): Promise<unknown[]> {
    const [server, people, ana, ben, anaDue, benDue] = await original([
      ["EXISTS", keys.server],
      ["HLEN", keys.members],
      ["GET", keys.ana],
      ["GET", keys.ben],
      ["ZSCORE", "nl:dc:due", `${sid}|${ANA_ID}`],
      ["ZSCORE", "nl:dc:due", `${sid}|${BEN_ID}`],
    ]);
    return [server, people, ana, ben, anaDue !== null, benDue !== null];
  }
  const ALL_KEPT = [1, 2, ANA_ID, BEN_ID, true, true];
  const NOTHING_KEPT = [0, 0, null, null, false, false];

  part("Healthy controls");
  await seed();
  is("two people kept: both forgotten, with the server, their links and their checks", [await forgetServer(room, sid), await kept()], [2, NOTHING_KEPT]);
  await seed(false);
  is("nobody given roles: the server alone is forgotten, 0 people", [await forgetServer(room, sid), await kept()], [0, NOTHING_KEPT]);
  await seed();
  reply = { value: [[2, 2, 0]] };
  is("exact counts (both people, both address links, nobody left) are known", [await outcome(() => forgetServer(room, sid))], [2]);
  await seed();
  reply = { value: [[0, 0, 0]] };
  is("zero counts (already gone) are known, never unknown", [await outcome(() => forgetServer(room, sid))], [2]);

  part("Unread deletes cannot say the people were forgotten");
  for (const [label, value] of [
    ["no replies", []],
    ["queued replies", ["QUEUED"]],
    ["one reply that is not a count", ["x"]],
    ["one count short", [[2, 2]]],
    ["one count too many", [[2, 2, 0, 1]]],
    ["one reply too many", [[2, 2, 0], 1]],
    ["missing replies", [undefined]],
    ["missing counts", [[undefined, undefined, undefined]]],
    ["null replies", [null]],
    ["null counts", [[null, null, null]]],
    ["not a list", "OK"],
    ["a reply that is not a list of counts", ["OK"]],
    ["string counts", [["2", "2", "0"]]],
    ["a negative count", [[-1, 2, 0]]],
    ["a fraction", [[2, 1.5, 0]]],
  ] as [string, unknown][]) {
    await seed();
    reply = { value };
    is(`${label}: rejected, nothing counted as forgotten`, [await outcome(() => forgetServer(room, sid)), await kept()], ["rejected: UnknownReplyError", ALL_KEPT]);
  }

  part("A count no command can give is unknown");
  // Two people named, two address links; the people left must be none.
  for (const value of [[[3, 2, 0]], [[2, 3, 0]], [[2, 99, 0]], [[99, 2, 0]], [[2, 2, 1]]]) {
    await seed();
    reply = { value };
    is(`deletes answered ${JSON.stringify(value)}: rejected`, [await outcome(() => forgetServer(room, sid)), await kept()], ["rejected: UnknownReplyError", ALL_KEPT]);
  }
  await seed(false);
  reply = { value: [4] };
  is("nobody given roles, DEL of three keys answered 4: rejected", await outcome(() => forgetServer(room, sid)), "rejected: UnknownReplyError");
  await seed(false);
  reply = { value: [3, 0] };
  is("nobody given roles, no ZREM sent, two replies: rejected", await outcome(() => forgetServer(room, sid)), "rejected: UnknownReplyError");

  part("The studio's Disconnect never says done with a count on unknown deletes");
  const session = await openSession(OWNER);
  const disconnect = () =>
    manageDiscord(
      new NextRequest(`https://marktmorgen.com/api/store/discord?store=${sid}`, {
        method: "POST",
        headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
        body: JSON.stringify({ action: "disconnect" }),
      }),
    );
  for (const value of [[], ["QUEUED"], ["x"]]) {
    await seed();
    reply = { value };
    const answered = await disconnect();
    const body = (await answered.json()) as Record<string, unknown>;
    is(`deletes answered ${JSON.stringify(value)}: not ok, no people count, everything still kept`, [answered.ok, body.ok, "people" in body, await kept()], [false, false, false, ALL_KEPT]);
  }
  await seed();
  const healthy = await disconnect();
  is("control: a known disconnect says ok with the two people forgotten", [healthy.status, await healthy.json(), await kept()], [200, { ok: true, people: 2 }, NOTHING_KEPT]);

  done();
}

main();
