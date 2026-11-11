/**
 * Discord records read exactly before erasure is confirmed or paid access is ended (PR #2932, CX-123 rules 24/30).
 * Synthetic only: Redis is the in-memory stand-in, Discord a stand-in fetch (no network).
 *
 * Credit: cases 1 and 2 are Codex Z's durable proof (codex/z-review-2932-discord-exact-proof@21926a2f,
 * tests/z-2932-discord-exact.proof.ts, review 5807949642), adapted to this runner. Case 3 is the pre-existing
 * sibling from the independent review in issue comment 6697501041.
 *
 *   1. lib/discord-store.ts forgetMember accepted any string as the address link on its second read, so a present
 *      reply that is not a Discord id deleted the member, kept the link and let forgetDiscordPerson confirm erasure.
 *   2. productRolesOrThrow checked only that a product's value was a list; cleanRoles then dropped invalid members, so
 *      a stored [7] became "this product gives no role" and checkMember ended a paying buyer's access.
 *   3. forgetMember never read its delete replies, so an empty, short or QUEUED pipeline answer still counted as
 *      one record erased while the member record (holding the buyer's address) and the link were both kept.
 *   4. Each of forgetMember's HDEL/ZREM/DEL targets exactly one field, member or key, so only 0 or 1 is a known
 *      answer; countOf accepted 2, and [2,1,1] confirmed erasure with both records kept (Codex Z, review 5808484150,
 *      codex/z-review-2932-delete-count-return@23be2d17). Same pattern next to it: the access-check DEL in
 *      forgetDiscordPerson removes at most one per distinct key, so a larger count is unknown too.
 */
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { emailKey, storeKey } from "@/lib/learn";
import { checkMember, forgetDiscordPerson } from "@/lib/discord-access";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const calls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  calls.push(`${init?.method ?? "GET"} ${url.pathname.replace("/api/v10", "")}`);
  return new Response(null, { status: 204 });
}) as typeof fetch;

const OWNER = "owner@discord-exact.example";
const EMAIL = "buyer@discord-exact.example";
const USER = "123456789012345678";
const SERVER = "223456789012345678";
const ROLE = "323456789012345678";

type Command = (string | number)[];
/** Answers the nth pipeline whose first command matches with `reply`, without applying it. */
type Rule = { match: (command: Command) => boolean; reply: unknown; nth?: number };
let rule: Rule | null = null;
const original = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  if (rule && commands.length && rule.match(commands[0])) {
    const nth = rule.nth ?? 1;
    rule.nth = nth - 1;
    if (nth === 1) return rule.reply;
  }
  return original(commands);
}) as typeof redis.pipeline;

const on = (verb: string, prefix: string) => (command: Command) => command[0] === verb && String(command[1]).startsWith(prefix);
const deletes = () => calls.filter((call) => call.startsWith("DELETE"));

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
  await claimHandle(OWNER, "discord-exact", "Discord Exact", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  const made = await addProduct(OWNER, "The Club", "", "20", null);
  if (!made.ok) throw new Error("test product was not created");
  const productId = made.product.id;
  const store = (await storeForEmail(OWNER))!;
  const room = storeKey(store);
  const memberKey = `nl:dc:mem:${room}`;
  const addressKey = `nl:dc:addr:${room}:${emailKey(EMAIL)}`;
  const heldKey = `nl:dc:ok:${room}:${emailKey(EMAIL)}:${productId}`;

  async function seed(roles: unknown = [ROLE]): Promise<void> {
    rule = null;
    await original([
      ["SET", `nl:dc:srv:${room}`, JSON.stringify({ id: SERVER, name: "Server", at: 1, kick: false })],
      ["HSET", `nl:dc:prod:${room}`, productId, JSON.stringify(roles)],
      ["HSET", memberKey, USER, JSON.stringify({ e: EMAIL, n: "buyer", p: [productId], r: [ROLE], at: 1, checked: 1 })],
      ["SET", addressKey, USER],
      ["SET", heldKey, JSON.stringify({ v: "1", ok: true })],
    ]);
    calls.length = 0;
  }

  async function kept(): Promise<{ member: boolean; link: unknown }> {
    const [member, link] = await original([["HGET", memberKey, USER], ["GET", addressKey]]);
    return { member: member !== null, link };
  }

  part("Healthy controls");
  await seed();
  is("a buyer who still holds the product is kept without a provider DELETE", [await checkMember(store.sid, USER), deletes(), await kept()], ["kept", [], { member: true, link: USER }]);
  await seed();
  is(
    "erasure takes the role back and forgets the member and the link",
    [await forgetDiscordPerson(store, EMAIL, []), deletes().length, await kept()],
    [{ records: 1, rolesLeft: false }, 1, { member: false, link: null }],
  );

  part("1. An invalid second address link cannot confirm erasure (Codex Z)");
  for (const bad of ["not-a-discord-id", "", "12345"]) {
    await seed();
    rule = { match: on("GET", "nl:dc:addr:"), reply: [bad], nth: 2 };
    const erased = await outcome(() => forgetDiscordPerson(store, EMAIL, []));
    rule = null;
    is(`link read again as ${JSON.stringify(bad)}: rejected, records kept for retry`, [erased, await kept()], ["rejected: UnknownReplyError", { member: true, link: USER }]);
  }

  part("2. One invalid role member makes the whole product-role read unknown (Codex Z)");
  for (const bad of [[7], [ROLE, 7], ["not-a-role"], [ROLE, null], []]) {
    await seed();
    rule = { match: on("HGETALL", "nl:dc:prod:"), reply: [[productId, JSON.stringify(bad)]] };
    const checked = await outcome(() => checkMember(store.sid, USER));
    rule = null;
    is(`roles ${JSON.stringify(bad)}: rejected before any revocation`, [checked, deletes(), await kept()], ["rejected: UnknownReplyError", [], { member: true, link: USER }]);
  }

  part("3. Unread deletes cannot confirm erasure (pre-existing, comment 6697501041)");
  for (const [label, reply] of [
    ["no replies", []],
    ["missing replies", [undefined, undefined, undefined]],
    ["queued replies", ["QUEUED", "QUEUED", "QUEUED"]],
    ["one reply short", [1, 1]],
  ] as [string, unknown][]) {
    await seed();
    rule = { match: on("HDEL", "nl:dc:mem:"), reply };
    const erased = await outcome(() => forgetDiscordPerson(store, EMAIL, []));
    rule = null;
    is(`${label}: rejected, member and link still there`, [erased, await kept()], ["rejected: UnknownReplyError", { member: true, link: USER }]);
  }
  await seed();
  await original([["SET", heldKey, JSON.stringify({ v: "1", ok: false })]]);
  is("control: a buyer who no longer holds the product is ended and forgotten", [await checkMember(store.sid, USER), deletes().length, await kept()], ["ended", 1, { member: false, link: null }]);
  await seed();
  await original([["SET", heldKey, JSON.stringify({ v: "1", ok: false })]]);
  rule = { match: on("HDEL", "nl:dc:mem:"), reply: [undefined, 1, 1] };
  const ended = await outcome(() => checkMember(store.sid, USER));
  rule = null;
  is("the periodic check does not report ended on unread deletes", ended, "rejected: UnknownReplyError");

  part("4. A delete count no single-target command can give is unknown (Codex Z, review 5808484150)");
  for (const reply of [[2, 1, 1], [1, 2, 1], [1, 1, 2], [1, 1, 7]]) {
    await seed();
    rule = { match: on("HDEL", "nl:dc:mem:"), reply };
    const erased = await outcome(() => forgetDiscordPerson(store, EMAIL, []));
    rule = null;
    is(`deletes answered ${JSON.stringify(reply)}: rejected, member and link still there`, [erased, await kept()], ["rejected: UnknownReplyError", { member: true, link: USER }]);
  }
  await seed();
  await original([["SET", heldKey, JSON.stringify({ v: "1", ok: false })]]);
  rule = { match: on("HDEL", "nl:dc:mem:"), reply: [2, 1, 1] };
  const endedTwice = await outcome(() => checkMember(store.sid, USER));
  rule = null;
  is("the periodic check does not report ended on an impossible delete count", [endedTwice, await kept()], ["rejected: UnknownReplyError", { member: true, link: USER }]);
  await seed();
  rule = { match: on("DEL", "nl:dc:ok:"), reply: [2] };
  const cacheErased = await outcome(() => forgetDiscordPerson(store, EMAIL, [productId]));
  rule = null;
  const [cacheLeft] = await original([["GET", heldKey]]);
  is("access checks: one key answered as 2 removed is rejected, the check is still there", [cacheErased, cacheLeft !== null], ["rejected: UnknownReplyError", true]);
  await seed();
  is("control: one key answered as 1 removed is counted", [await forgetDiscordPerson(store, EMAIL, [productId]), await kept()], [{ records: 2, rolesLeft: false }, { member: false, link: null }]);

  done();
}

main();
