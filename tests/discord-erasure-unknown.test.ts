/**
 * Deleting a person's Discord access on an unknown Redis read (sweep A2 finding 4, CX-123 rules 24/30). Synthetic only:
 * Redis is the in-memory stand-in, Discord a stand-in fetch (no network).
 *
 * Before the fix, lib/discord-access.ts forgetDiscordPerson read `accountOf(room, email).catch(() => null)`, and
 * lib/discord-store.ts accountOf/readMember read any reply that was not a usable string as "none". A thrown read, a
 * missing slot or a reply of another shape was taken as "this person has no Discord access": no role was taken back
 * in the creator's server, the member record holding the address was kept, and the step answered
 * { records: 0, rolesLeft: false }, so lib/person-erasure.ts reported it finished with nothing left for the creator.
 *
 * What is checked:
 *   - healthy: the role is taken back, the person forgotten, { records: 1, rolesLeft: false };
 *   - a genuine absence (no link kept, the exact null reply) is still "no account": { records: 0 }, no call to Discord;
 *   - an unknown read of the link, the member, the server, or the link read again while forgetting, fails the step
 *     (rejected), so the erasure lists lib/discord-access.ts as not finished, and what it would have deleted is kept
 *     for the next try;
 *   - siblings in the same files: the periodic check (checkMember) never takes an unknown member, server or roles
 *     read as "gone" or "holds nothing", and joining never takes an unknown read of the earlier account as "none";
 *   - the person's copy (lib/person-copy.ts) fails rather than leaving the Discord part out.
 */
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { emailKey, storeKey } from "@/lib/learn";
import { checkMember, forgetDiscordPerson, joinServer, sweepDiscord } from "@/lib/discord-access";
import { ERASERS } from "@/lib/person-erasure";
import { COPIERS } from "@/lib/person-copy";
import type { ErasureScope } from "@/lib/erasure-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const calls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  calls.push(`${init?.method ?? "GET"} ${url.pathname.replace("/api/v10", "")}`);
  return new Response(null, { status: 204 });
}) as typeof fetch;
const deletes = () => calls.filter((c) => c.startsWith("DELETE"));
const puts = () => calls.filter((c) => c.startsWith("PUT"));

const OWNER = "owner@discord-unknown.example";
const EMAIL = "buyer@discord-unknown.example";
const USER = "123456789012345678";
const OTHER = "123456789012345679";
const SERVER = "223456789012345678";
const ROLE = "323456789012345678";

type Rule = { match: (command: (string | number)[]) => boolean; reply: "throw" | unknown[]; nth?: number };
let rule: Rule | null = null;
const original = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (rule && commands.length === 1 && rule.match(commands[0])) {
    const nth = rule.nth ?? 1;
    rule.nth = nth - 1;
    if (nth === 1) {
      if (rule.reply === "throw") throw new Error("Redis did not answer");
      return rule.reply;
    }
  }
  return original(commands);
}) as typeof redis.pipeline;
const on = (verb: string, prefix: string) => (command: (string | number)[]) => command[0] === verb && String(command[1]).startsWith(prefix);

async function outcome<T>(run: () => Promise<T>): Promise<T | string> {
  try {
    return await run();
  } catch (error) {
    return `rejected: ${error instanceof Error ? error.name : "?"}`;
  }
}

async function main(): Promise<void> {
  process.env.DISCORD_CLIENT_ID = "400000000000000001";
  process.env.DISCORD_CLIENT_SECRET = "secret";
  process.env.DISCORD_BOT_TOKEN = "bot";
  redis.clear();
  await claimHandle(OWNER, "discord-unknown", "Discord Unknown", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  const made = await addProduct(OWNER, "The Club", "", "20", null);
  if (!made.ok) throw new Error("no product");
  const productId = made.product.id;
  const store = (await storeForEmail(OWNER))!;
  const room = storeKey(store);
  const memberKey = `nl:dc:mem:${room}`;
  const addrKey = `nl:dc:addr:${room}:${emailKey(EMAIL)}`;
  const holdsKey = `nl:dc:ok:${room}:${emailKey(EMAIL)}:${productId}`;
  const scope = { store, email: EMAIL, productIds: [] } as unknown as ErasureScope;
  const eraser = ERASERS.find((e) => e.module === "lib/discord-access.ts")!;

  async function seed(): Promise<void> {
    rule = null;
    await original([
      ["SET", `nl:dc:srv:${room}`, JSON.stringify({ id: SERVER, name: "Server", at: 1, kick: false })],
      ["HSET", `nl:dc:prod:${room}`, productId, JSON.stringify([ROLE])],
      ["HSET", memberKey, USER, JSON.stringify({ e: EMAIL, n: "buyer", p: [productId], r: [ROLE], at: 1, checked: 1 })],
      ["SET", addrKey, USER],
      // The buyer holds the product (lib/community-access.ts cache), so a check keeps them and a join gives the role.
      ["SET", holdsKey, JSON.stringify({ v: "1", ok: true })],
      ["DEL", "nl:dc:due"],
      ["ZADD", "nl:dc:due", 0, `${store.sid}|${USER}`],
    ]);
    calls.length = 0;
  }
  const kept = async () => {
    const [member, link] = await original([["HGET", memberKey, USER], ["GET", addrKey]]);
    return { member: member !== null, link: link === USER };
  };

  part("Healthy control: the role is taken back and the person forgotten");
  await seed();
  is("one record, no role left, one role DELETE, member and link gone", [await forgetDiscordPerson(store, EMAIL, []), deletes(), await kept()], [
    { records: 1, rolesLeft: false },
    [`DELETE /guilds/${SERVER}/members/${USER}/roles/${ROLE}`],
    { member: false, link: false },
  ]);

  part("A genuine absence is still no account");
  await seed();
  await original([["DEL", addrKey]]);
  calls.length = 0;
  is("no link kept (exact null): nothing to delete, Discord not asked", [await forgetDiscordPerson(store, EMAIL, []), calls], [{ records: 0, rolesLeft: false }, []]);
  await seed();
  await original([["HDEL", memberKey, USER]]);
  calls.length = 0;
  is("a link with no member record (exact null): the link is forgotten, Discord not asked", [await forgetDiscordPerson(store, EMAIL, []), calls, await kept()], [
    { records: 1, rolesLeft: false },
    [],
    { member: false, link: false },
  ]);

  const unknownLink: [string, Rule["reply"], string][] = [
    ["the GET throws", "throw", "rejected: Error"],
    ["the GET answers no slot", [], "rejected: UnknownReplyError"],
    ["the GET answers a number", [42], "rejected: UnknownReplyError"],
    ["the GET answers a string that is no Discord id", ["not-an-id"], "rejected: UnknownReplyError"],
    ["the GET answers two slots", [USER, USER], "rejected: UnknownReplyError"],
  ];
  for (const [label, reply, expected] of unknownLink) {
    part(`The address -> Discord id read is unknown (${label})`);
    await seed();
    rule = { match: on("GET", "nl:dc:addr:"), reply };
    const got = await outcome(() => forgetDiscordPerson(store, EMAIL, []));
    rule = null;
    is("the step does not finish (never { records: 0, rolesLeft: false })", got, expected);
    is("no role DELETE was sent on a guess", deletes(), []);
    is("the member record and the link are kept for the next try", await kept(), { member: true, link: true });
    rule = { match: on("GET", "nl:dc:addr:"), reply };
    is("the erasure runner gets the failure, so it lists lib/discord-access.ts as not finished", await outcome(() => eraser.run(scope, [], new Set())), expected);
    rule = null;
  }

  for (const [label, reply] of [
    ["no slot", []],
    ["a number", [7]],
    ["a string that is not JSON", ["{not json"]],
    ["a record without its roles", [JSON.stringify({ e: EMAIL, n: "buyer" })]],
    ["roles that are not a list of ids", [JSON.stringify({ e: EMAIL, n: "buyer", r: "x" })]],
  ] as [string, unknown[]][]) {
    part(`The member read (HGET) is unknown (${label})`);
    await seed();
    rule = { match: on("HGET", "nl:dc:mem:"), reply };
    const got = await outcome(() => forgetDiscordPerson(store, EMAIL, []));
    rule = null;
    is("the step does not finish (never rolesLeft false with no DELETE)", [got, deletes()], ["rejected: UnknownReplyError", []]);
    is("the member record and the link are kept", await kept(), { member: true, link: true });
  }

  for (const [label, reply] of [
    ["no slot", []],
    ["a number", [7]],
  ] as [string, unknown[]][]) {
    part(`The server read is unknown while deleting (${label})`);
    await seed();
    rule = { match: on("GET", "nl:dc:srv:"), reply };
    const got = await outcome(() => forgetDiscordPerson(store, EMAIL, []));
    rule = null;
    is("the step does not finish, no role DELETE, all kept", [got, deletes(), await kept()], ["rejected: UnknownReplyError", [], { member: true, link: true }]);
  }

  part("The link read again while forgetting (lib/discord-store.ts forgetMember) is unknown");
  await seed();
  rule = { match: on("GET", "nl:dc:addr:"), reply: [], nth: 2 };
  const forgetting = await outcome(() => forgetDiscordPerson(store, EMAIL, []));
  rule = null;
  is("the step does not finish: the link that holds the address would have been left behind", forgetting, "rejected: UnknownReplyError");
  is("the role was taken back, and the link is kept for the next try", [deletes().length, (await kept()).link], [1, true]);
  is("the next try finishes", [await forgetDiscordPerson(store, EMAIL, []), await kept()], [{ records: 1, rolesLeft: false }, { member: false, link: false }]);

  part("Sibling: the periodic check never reads an unknown member, server or roles as gone or holding nothing");
  await seed();
  is("healthy: a buyer who holds the product is kept", await checkMember(store.sid, USER), "kept");
  for (const [label, match, reply] of [
    ["member read, no slot", on("HGET", "nl:dc:mem:"), []],
    ["member read, not JSON", on("HGET", "nl:dc:mem:"), ["{"]],
    ["server read, no slot", on("GET", "nl:dc:srv:"), []],
    ["roles read, no slot", on("HGETALL", "nl:dc:prod:"), []],
    ["roles read, a number", on("HGETALL", "nl:dc:prod:"), [3]],
    ["roles read, an odd list", on("HGETALL", "nl:dc:prod:"), [[productId]]],
    ["roles read, a value that is not a list", on("HGETALL", "nl:dc:prod:"), [[productId, JSON.stringify({ r: ROLE })]]],
  ] as [string, Rule["match"], unknown[]][]) {
    await seed();
    rule = { match, reply };
    const checked = await outcome(() => checkMember(store.sid, USER));
    rule = null;
    is(`${label}: not "gone" or "ended", nothing taken, member kept`, [checked, deletes(), await kept()], ["rejected: UnknownReplyError", [], { member: true, link: true }]);
    await original([["DEL", "nl:dc:due"], ["ZADD", "nl:dc:due", 0, `${store.sid}|${USER}`]]);
    rule = { match, reply };
    const swept = await sweepDiscord(Date.now() + 60_000);
    rule = null;
    const [score] = await original([["ZSCORE", "nl:dc:due", `${store.sid}|${USER}`]]);
    is(`${label}: the sweep counts it as later and keeps it in line`, [swept.later, swept.gone, swept.ended, score !== null], [1, 0, 0, true]);
  }

  part("Sibling: joining never reads an unknown earlier account as none");
  await seed();
  const fine = await joinServer({ store, email: EMAIL, accessToken: "t", user: { id: OTHER, name: "other" } });
  is("healthy: a second account takes the roles over (the first one's role taken back)", [fine.ok, deletes()], [true, [`DELETE /guilds/${SERVER}/members/${USER}/roles/${ROLE}`]]);
  for (const [label, match, reply] of [
    ["the earlier account's link, no slot", on("GET", "nl:dc:addr:"), []],
    ["the earlier account's link, a number", on("GET", "nl:dc:addr:"), [9]],
    ["the earlier account's member record, no slot", (c: (string | number)[]) => c[0] === "HGET" && c[2] === USER, []],
    ["this account's member record, not JSON", (c: (string | number)[]) => c[0] === "HGET" && c[2] === OTHER, ["{"]],
  ] as [string, Rule["match"], unknown[]][]) {
    await seed();
    await original([["HDEL", memberKey, OTHER]]);
    rule = { match, reply };
    const joined = await outcome(() => joinServer({ store, email: EMAIL, accessToken: "t", user: { id: OTHER, name: "other" } }));
    rule = null;
    is(`${label}: the join fails, nobody is put in or given roles, the first account is kept`, [joined, puts(), deletes(), await kept()], [{ ok: false, reason: "failed" }, [], [], { member: true, link: true }]);
  }

  part("The person's copy fails rather than leaving the Discord part out");
  await seed();
  const copier = COPIERS["lib/discord-access.ts"];
  is("healthy: the member record is copied", ((await copier(scope)) as { e: string }[]).map((m) => m.e), [EMAIL]);
  rule = { match: on("GET", "nl:dc:addr:"), reply: [] };
  is("an unknown link read: the copy fails (never an empty Discord part)", await outcome(() => copier(scope)), "rejected: UnknownReplyError");
  rule = null;

  done();
}
main();
