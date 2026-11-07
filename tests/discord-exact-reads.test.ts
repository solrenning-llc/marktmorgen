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
 *   4. forgetMember read its delete replies with countOf, which takes any whole number, so [2, 1, 1] for one HDEL
 *      field, one ZREM member and one DEL key confirmed erasure while nothing was deleted (Codex Z focal return,
 *      review 5808484150; proof codex/z-review-2932-delete-count-return@23be2d17). Rule 30 sibling: the DEL of the
 *      person's access checks in forgetDiscordPerson took any count, so a count above the keys sent was added to
 *      the records erased.
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

  part("4. A delete count impossible for one field, member or key cannot confirm erasure (Codex Z focal return)");
  for (const reply of [[2, 1, 1], [1, 2, 1], [1, 1, 2], [1, 1, 7]] as unknown[][]) {
    await seed();
    rule = { match: on("HDEL", "nl:dc:mem:"), reply };
    const erased = await outcome(() => forgetDiscordPerson(store, EMAIL, []));
    rule = null;
    is(`deletes answered ${JSON.stringify(reply)}: rejected, member and link still there`, [erased, await kept()], ["rejected: UnknownReplyError", { member: true, link: USER }]);
  }
  for (const reply of [[0, 0, 0], [1, 0, 1]] as unknown[][]) {
    await seed();
    rule = { match: on("HDEL", "nl:dc:mem:"), reply };
    is(`control: deletes answered ${JSON.stringify(reply)} (each 0 or 1) are read as done`, await outcome(() => forgetDiscordPerson(store, EMAIL, [])), { records: 1, rolesLeft: false });
    rule = null;
  }

  part("4b. Sibling: the access checks' DEL cannot count more keys than it sent (rule 30)");
  for (const [label, ids, reply] of [
    ["one key, count 2", [productId], [2]],
    ["one key twice, count 2", [productId, productId], [2]],
    ["two keys, count 3", [productId, "other-product"], [3]],
  ] as [string, string[], unknown][]) {
    await seed();
    rule = { match: on("DEL", "nl:dc:ok:"), reply };
    const erased = await outcome(() => forgetDiscordPerson(store, EMAIL, ids));
    rule = null;
    is(`${label}: rejected, never counted as records erased`, erased, "rejected: UnknownReplyError");
  }
  await seed();
  is("control: the one access check kept is counted once", await forgetDiscordPerson(store, EMAIL, [productId]), { records: 2, rolesLeft: false });
  await seed();
  is("control: the same product twice deletes one key and counts it once", await forgetDiscordPerson(store, EMAIL, [productId, productId]), { records: 2, rolesLeft: false });

  done();
}

main();
