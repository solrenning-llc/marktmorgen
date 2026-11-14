/**
 * The MEDIUM on #4087 (Claude 1 cloud, Claude 2 cloud F and Claude 7, 12/11/2026): switching Discord accounts when
 * one of the earlier account's role takes fails and another succeeds returned "failed" but left the earlier account's
 * record listing EVERY role, the ones Discord had already taken included. checkMember reads `r` as held
 * (rolesDiff(member.r, wanted)), so it never gave those back: the buyer kept paying for product A and held its role on
 * neither account. Now the earlier account's record keeps only the roles whose take failed, so the next check gives
 * the others back and still holds the failed one to take later. Synthetic only (in-memory Redis, stand-in Discord).
 */
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { emailKey, storeKey } from "@/lib/learn";
import { checkMember, joinServer } from "@/lib/discord-access";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const calls: string[] = [];
let failing: string | null = null;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const line = `${init?.method ?? "GET"} ${url.pathname.replace("/api/v10", "")}`;
  calls.push(line);
  if (failing && line === failing) return new Response(JSON.stringify({ message: "unavailable" }), { status: 503 });
  return new Response(null, { status: 204 });
}) as typeof fetch;
const puts = () => calls.filter((c) => c.startsWith("PUT"));

const OWNER = "owner@discord-take-failed.example";
const EMAIL = "buyer@discord-take-failed.example";
const FIRST = "123456789012345678";
const SECOND = "123456789012345679";
const SERVER = "223456789012345678";
const ROLE_A = "323456789012345678";
const ROLE_B = "323456789012345679";

async function main(): Promise<void> {
  process.env.DISCORD_CLIENT_ID = "400000000000000001";
  process.env.DISCORD_CLIENT_SECRET = "secret";
  process.env.DISCORD_BOT_TOKEN = "bot";
  redis.clear();
  await claimHandle(OWNER, "discord-take-failed", "Discord Take Failed", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  const a = await addProduct(OWNER, "The Club", "", "20", null);
  const b = await addProduct(OWNER, "The Inner Circle", "", "30", null);
  if (!a.ok || !b.ok) throw new Error("no product");
  const productA = a.product.id;
  const productB = b.product.id;
  const store = (await storeForEmail(OWNER))!;
  const room = storeKey(store);
  const memberKey = `nl:dc:mem:${room}`;
  const addrKey = `nl:dc:addr:${room}:${emailKey(EMAIL)}`;
  const holds = (productId: string, ok: boolean) => ["SET", `nl:dc:ok:${room}:${emailKey(EMAIL)}:${productId}`, JSON.stringify({ v: "1", ok })];

  async function seed(roles: string[], heldB: boolean): Promise<void> {
    failing = null;
    await redis.pipeline([
      ["SET", `nl:dc:srv:${room}`, JSON.stringify({ id: SERVER, name: "Server", at: 1, kick: false })],
      ["HSET", `nl:dc:prod:${room}`, productA, JSON.stringify([ROLE_A])],
      ["HSET", `nl:dc:prod:${room}`, productB, JSON.stringify([ROLE_B])],
      ["DEL", memberKey],
      ["HSET", memberKey, FIRST, JSON.stringify({ e: EMAIL, n: "buyer", p: heldB ? [productA, productB] : [productA, productB], r: roles, at: 1, checked: 1 })],
      ["SET", addrKey, FIRST],
      holds(productA, true),
      holds(productB, heldB),
    ]);
    calls.length = 0;
  }
  const record = async (user: string) => {
    const [member] = await redis.pipeline([["HGET", memberKey, user]]);
    return member === null ? null : (JSON.parse(String(member)) as { r: string[] }).r;
  };
  const link = async () => (await redis.pipeline([["GET", addrKey]]))[0];

  part("Switching accounts: one of the earlier account's two takes fails, the other goes through");
  await seed([ROLE_A, ROLE_B], true);
  failing = `DELETE /guilds/${SERVER}/members/${FIRST}/roles/${ROLE_B}`;
  const switched = await joinServer({ store, email: EMAIL, accessToken: "t", user: { id: SECOND, name: "second" } });
  is("the join fails and the new account is not put in", [switched, puts()], [{ ok: false, reason: "failed" }, []]);
  is("the earlier account stays registered, holding on its record only the role Discord still gave it", [await record(FIRST), await link()], [[ROLE_B], FIRST]);
  failing = null;
  calls.length = 0;
  const checked = await checkMember(store.sid, FIRST);
  is("the next check gives back the role that was taken, which the buyer still holds", [checked, puts()], ["changed", [`PUT /guilds/${SERVER}/members/${FIRST}/roles/${ROLE_A}`]]);
  is("and the record then lists both again", (await record(FIRST))?.sort(), [ROLE_A, ROLE_B].sort());

  done();
}

void main();
