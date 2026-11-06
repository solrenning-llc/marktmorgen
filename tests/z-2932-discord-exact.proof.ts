/**
 * Independent review proof for PR #2932.
 *
 * All provider calls and Redis replies are synthetic. The product modules are
 * the PR's unmodified modules. The two causal cases describe replies that are
 * present but not valid Discord records; neither may confirm erasure or end a
 * paying member's access.
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

const OWNER = "owner@z2932-proof.example";
const EMAIL = "buyer@z2932-proof.example";
const USER = "123456789012345678";
const SERVER = "223456789012345678";
const ROLE = "323456789012345678";

type Command = (string | number)[];
type Rule = { match: (command: Command) => boolean; reply: unknown[]; nth?: number };
let rule: Rule | null = null;
const original = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  if (rule && commands.length === 1 && rule.match(commands[0])) {
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
  await claimHandle(OWNER, "z2932-proof", "Z2932 Proof", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  const made = await addProduct(OWNER, "The Club", "", "20", null);
  if (!made.ok) throw new Error("proof product was not created");
  const productId = made.product.id;
  const store = (await storeForEmail(OWNER))!;
  const room = storeKey(store);
  const memberKey = `nl:dc:mem:${room}`;
  const addressKey = `nl:dc:addr:${room}:${emailKey(EMAIL)}`;
  const heldKey = `nl:dc:ok:${room}:${emailKey(EMAIL)}:${productId}`;

  async function seed(): Promise<void> {
    rule = null;
    await original([
      ["SET", `nl:dc:srv:${room}`, JSON.stringify({ id: SERVER, name: "Server", at: 1, kick: false })],
      ["HSET", `nl:dc:prod:${room}`, productId, JSON.stringify([ROLE])],
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

  part("Healthy control: exact records keep a buyer who still holds the product");
  await seed();
  is("the buyer is kept without a provider DELETE", [await checkMember(store.sid, USER), deletes(), await kept()], ["kept", [], { member: true, link: USER }]);

  part("Causal 1: an invalid second address link cannot confirm erasure");
  await seed();
  rule = { match: on("GET", "nl:dc:addr:"), reply: ["not-a-discord-id"], nth: 2 };
  const erased = await outcome(() => forgetDiscordPerson(store, EMAIL, []));
  rule = null;
  is(
    "the step rejects and keeps its Redis records for retry",
    [erased, await kept()],
    ["rejected: UnknownReplyError", { member: true, link: USER }],
  );

  part("Causal 2: one invalid role member makes the complete product-role read unknown");
  await seed();
  rule = { match: on("HGETALL", "nl:dc:prod:"), reply: [[productId, JSON.stringify([7])]] };
  const checked = await outcome(() => checkMember(store.sid, USER));
  rule = null;
  is(
    "the check rejects before revoking a paying buyer's access",
    [checked, deletes(), await kept()],
    ["rejected: UnknownReplyError", [], { member: true, link: USER }],
  );

  done();
}

main();
