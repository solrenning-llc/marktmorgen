/**
 * #4660 (Codex L, HIGH, erasure; reproduced by Claude 2 on main e4dbb5e9bf): the scheduled Discord check
 * (lib/discord-access.ts checkMember) reads a member, then asks whether they still hold what gives their roles.
 * A person's erasure that lands in between takes their roles back and deletes their row, the link from their
 * address and their place in the line; the check, still holding the old member, then wrote all three back with
 * no expiry (keepMember). The check now writes only over the row it read (lib/discord-store.ts keepCheckedMember,
 * ORDER_WRITE_IF_SAME). Control: a check with nothing in between still keeps the member and puts them back in line.
 * Synthetic store, person and Discord ids; in-memory Redis; the pause stands for the request being in flight.
 */
import { emailKey, storeKey } from "@/lib/learn";
import { checkMember } from "@/lib/discord-access";
import { erasePerson } from "@/lib/person-erasure";
import { normaliseEmail } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { makeWorld } from "./erasure-world";
import { done, is, part } from "./check";

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  if (url.hostname.includes("discord")) return new Response(null, { status: 204 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

const USER = "123456789012345678";
const SERVER = "223456789012345678";
const ROLE = "323456789012345678";
type Command = (string | number)[];

async function main(): Promise<void> {
  process.env.DISCORD_CLIENT_ID = "400000000000000001";
  process.env.DISCORD_CLIENT_SECRET = "synthetic-secret";
  process.env.DISCORD_BOT_TOKEN = "synthetic-token";
  process.env.STRIPE_SECRET_KEY = "sk_test_d2_stand_in";
  redis.clear();
  const world = await makeWorld();
  const store = world.store;
  const EMAIL = normaliseEmail("d2-discord@example.test");
  const productId = world.courseProduct;
  const room = storeKey(store);
  const memberKey = `nl:dc:mem:${room}`;
  const addressKey = `nl:dc:addr:${room}:${emailKey(EMAIL)}`;
  const heldKey = `nl:dc:ok:${room}:${emailKey(EMAIL)}:${productId}`;
  const original = redis.pipeline.bind(redis);

  let reached!: () => void;
  const cachedEligibilityRead = new Promise<void>((r) => (reached = r));
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let paused = false;
  redis.pipeline = (async (commands: Command[]) => {
    const out = await original(commands);
    if (!paused && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === heldKey) {
      paused = true;
      reached();
      await hold;
    }
    return out;
  }) as typeof redis.pipeline;

  await original([
    ["SET", `nl:dc:srv:${room}`, JSON.stringify({ id: SERVER, name: "Server", at: 1, kick: false })],
    ["HSET", `nl:dc:prod:${room}`, productId, JSON.stringify([ROLE])],
    ["HSET", memberKey, USER, JSON.stringify({ e: EMAIL, n: "buyer", p: [productId], r: [ROLE], at: 1, checked: 1 })],
    ["SET", addressKey, USER],
    ["SET", heldKey, JSON.stringify({ v: "1", ok: true })],
    ["ZADD", "nl:dc:due", 1, `${store.sid}|${USER}`],
  ]);
  const kept = async () => {
    const [member, link] = await original([["HGET", memberKey, USER], ["GET", addressKey]]);
    return { member: member !== null, link };
  };

  part("a running check finishes after the person's erasure");
  const checking = checkMember(store.sid, USER);
  await cachedEligibilityRead;
  try {
    const erased = await erasePerson(store, EMAIL, { kind: "person" });
    is("erasure completes", erased.ok, true);
    is("member and link gone", await kept(), { member: false, link: null });
  } finally {
    release();
  }
  await checking;
  is("the old check leaves the member and link gone", await kept(), { member: false, link: null });
  const [next] = await original([["ZSCORE", "nl:dc:due", `${store.sid}|${USER}`]]);
  is("the old check leaves the queue entry absent", next, null);

  part("control: a check with nothing in between keeps the member and puts them back in line");
  redis.pipeline = original as typeof redis.pipeline;
  await original([
    ["HSET", memberKey, USER, JSON.stringify({ e: EMAIL, n: "buyer", p: [productId], r: [ROLE], at: 1, checked: 1 })],
    ["SET", addressKey, USER],
    ["SET", heldKey, JSON.stringify({ v: "1", ok: true })],
    ["ZADD", "nl:dc:due", 1, `${store.sid}|${USER}`],
  ]);
  const outcome = await checkMember(store.sid, USER);
  is("the check answers kept", outcome, "kept");
  is("the member and their link stay", await kept(), { member: true, link: USER });
  const [again] = await original([["ZSCORE", "nl:dc:due", `${store.sid}|${USER}`]]);
  is("they are back in line for the next check", Number(again) > 1, true);
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
