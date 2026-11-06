/**
 * Sweep A2 proof (CX-123 rules 24/30), synthetic only. lib/discord-access.ts forgetDiscordPerson, line 402:
 * `const userId = await accountOf(room, email).catch(() => null);` (and accountOf itself, lib/discord-store.ts:140-142,
 * reads any reply that is not a snowflake string as "no account"). An unknown read of the address -> Discord id link
 * is taken as "this person has no Discord access": no role is taken back in the creator's server, the member record
 * (which holds the address) is kept, and the erasure step returns { records: 0, rolesLeft: false }, which
 * lib/person-erasure.ts reports as done with nothing left for the creator to remove.
 * Discord is played by a stand-in fetch (no network).
 */
import { forgetDiscordPerson } from "@/lib/discord-access";
import { emailKey, storeKey } from "@/lib/learn";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const deleted: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if ((init?.method ?? "GET") === "DELETE") deleted.push(new URL(String(input)).pathname);
  return new Response(null, { status: 204 });
}) as typeof fetch;

const store = { sid: "sweepa2discordstore000000000001", statsId: "sweepa2dc", email: "owner@example.com", name: "Shop", handle: "shop" } as unknown as Store;
const EMAIL = "buyer@example.com";
const USER = "123456789012345678";
const SERVER = "223456789012345678";
const ROLE = "323456789012345678";
const room = storeKey(store);

async function seed() {
  redis.clear();
  await redis.pipeline([
    ["SET", `nl:dc:srv:${room}`, JSON.stringify({ id: SERVER, name: "Server", at: 1, kick: false })],
    ["HSET", `nl:dc:mem:${room}`, USER, JSON.stringify({ e: EMAIL, n: "buyer", p: ["p1"], r: [ROLE], at: 1, checked: 1 })],
    ["SET", `nl:dc:addr:${room}:${emailKey(EMAIL)}`, USER],
  ]);
  deleted.length = 0;
}
const memberKept = async () => (await redis.pipeline([["HGET", `nl:dc:mem:${room}`, USER]]))[0] !== null;
const original = redis.pipeline.bind(redis);

async function main() {
  part("Healthy control: the role is taken back and the person forgotten");
  await seed();
  const healthy = await forgetDiscordPerson(store, EMAIL, []);
  is("one record, no role left, the role DELETE sent, member gone", [healthy, deleted.length, await memberKept()], [{ records: 1, rolesLeft: false }, 1, false]);

  for (const [label, reply] of [["the GET throws (Redis error)", "throw"], ["the GET answers no slot", "empty"], ["the GET answers a non-string", "number"]] as const) {
    part(`DEFECT: the address -> Discord id read is unknown (${label})`);
    await seed();
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:dc:addr:")) {
        if (reply === "throw") throw new Error("Redis did not answer");
        return reply === "empty" ? [] : [42];
      }
      return original(commands);
    }) as typeof redis.pipeline;
    const got = await forgetDiscordPerson(store, EMAIL, []);
    redis.pipeline = original;
    is("DEFECT: reported as finished with nothing left (records 0, rolesLeft false)", got, { records: 0, rolesLeft: false });
    is("DEFECT: no role was taken back in Discord", deleted.length, 0);
    is("DEFECT: the member record holding the address is still kept", await memberKept(), true);
  }
  part("DEFECT: the member read (HGET, lib/discord-store.ts readMember) is unknown: roles are never taken back, yet 'none left'");
  await seed();
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "HGET" && String(commands[0][1]).startsWith("nl:dc:mem:")) return [];
    return original(commands);
  }) as typeof redis.pipeline;
  const lost = await forgetDiscordPerson(store, EMAIL, []);
  redis.pipeline = original;
  is("DEFECT: rolesLeft false although no role DELETE was sent", [lost, deleted.length], [{ records: 1, rolesLeft: false }, 0]);
  done();
}
main();
