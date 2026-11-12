/**
 * Joining the creator's Discord server when taking a role back fails (entitlement hunt, Claude 7).
 * Synthetic only: Redis is the in-memory stand-in, Discord a stand-in fetch (no network).
 *
 * Before the fix, lib/discord-access.ts joinServer:
 *   - switching accounts: the earlier account's roles were taken with takeRole, whose "failed" (a 429, a 5xx, no answer)
 *     was ignored, and the earlier account was forgotten anyway. It kept the paid role in Discord for good, out of the
 *     register and the periodic check, so a purchase opened the server for a second account ("One Discord account per
 *     address: bringing in another moves the roles to it, so a purchase cannot open the server for a friend too").
 *   - already in the server: a role no longer held whose take failed stayed in `given` but was filtered out of the
 *     kept record (`r: given.filter(wanted)`), and checkMember only takes back roles in `member.r`, so the role was
 *     never taken back. checkMember itself keeps a failed take in `r` for the next try.
 *
 * What is checked:
 *   - switching with every take answered: the earlier account is forgotten, the new one given the role (control);
 *   - switching with a failed take: the join fails, nothing is put in for the new account, the earlier account and
 *     its link are kept with its role so a later try takes it back;
 */
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { emailKey, storeKey } from "@/lib/learn";
import { joinServer } from "@/lib/discord-access";
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
const deletes = () => calls.filter((c) => c.startsWith("DELETE"));
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

  part("Switching accounts, every take answered (control)");
  await seed([ROLE_A], true);
  const fine = await joinServer({ store, email: EMAIL, accessToken: "t", user: { id: SECOND, name: "second" } });
  is("the earlier account gives its role up and is forgotten", [fine.ok, deletes(), await record(FIRST), await link()], [
    true,
    [`DELETE /guilds/${SERVER}/members/${FIRST}/roles/${ROLE_A}`],
    null,
    SECOND,
  ]);

  part("Switching accounts when taking the earlier account's role fails");
  await seed([ROLE_A], true);
  failing = `DELETE /guilds/${SERVER}/members/${FIRST}/roles/${ROLE_A}`;
  const switched = await joinServer({ store, email: EMAIL, accessToken: "t", user: { id: SECOND, name: "second" } });
  is("the join fails and the new account is not put in", [switched, puts()], [{ ok: false, reason: "failed" }, []]);
  is("the earlier account stays in the register with its role, still linked", [await record(FIRST), await link()], [[ROLE_A], FIRST]);

  done();
}

void main();
