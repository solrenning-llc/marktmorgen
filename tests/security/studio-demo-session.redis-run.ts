/**
 * 256 [KJ1], unit 2: the studio demo's three scripts (lib/studio-demo.ts),
 * run by a real Redis rather than by the in-memory stand-in, which only
 * imitates them. The switch is forced on through the functions' own
 * parameter; STUDIO_DEMO_ON stays false in the code.
 *
 * Proves: two doors at the day's last place give it to one; the session's
 * record and first drafts are written with one absolute end, in the demo's
 * namespace only; a session reads back; an action is counted at its caps'
 * exact edges and two actions at the last place pass one.
 */
import { STUDIO_DEMO_SEED_VALUES, openStudioDemo, readStudioDemo, takeDemoAction } from "@/lib/studio-demo";
import {
  DEMO_ACTIONS_PER_SESSION, DEMO_BYTES_PER_SESSION, DEMO_COOKIE, DEMO_NAMESPACE, DEMO_REFUSALS_PER_DAY, DEMO_SESSIONS_PER_ADDRESS_PER_DAY, DEMO_SESSIONS_PER_DAY,
  DEMO_SESSION_SECONDS, sandboxKey,
} from "@/lib/studio-demo-rules";
import { redisPipeline } from "@/lib/redis";
import { check, finish } from "./check";

const now = Date.now();
const day = new Date(now).toISOString().slice(0, 10);
const dayKey = `${DEMO_NAMESPACE}day:${day}`;
const ON = { on: true, isAutomated: async () => false, now: () => now };
const door = (address: string) => new Request("https://marktmorgen.com/api/studio-demo", { method: "POST", headers: { "x-forwarded-for": address } });
const one = async (command: (string | number)[]) => (await redisPipeline([command]))[0];

async function main(): Promise<void> {
  await one(["SET", "nl:store:0123456789abcdef0123456789abcdef", "house"]);
  await one(["HSET", dayKey, "sessions", String(DEMO_SESSIONS_PER_DAY - 1), "commands", "0", "sent", "0"]);
  const both = await Promise.all([openStudioDemo(door("192.0.2.1"), ON), openStudioDemo(door("192.0.2.2"), ON)]);
  check("two doors at the day's last place: one opens", both.map((o) => (o.ok ? "ok" : o.reason)).sort(), ["ok", "sessions"]);
  check("the day counts exactly its cap", await one(["HGET", dayKey, "sessions"]), String(DEMO_SESSIONS_PER_DAY));

  await one(["HSET", dayKey, "sessions", "0"]);
  const opened = await openStudioDemo(door("192.0.2.3"), ON);
  if (!opened.ok) throw new Error(`the door did not open: ${opened.reason}`);
  const s = opened.session;
  const families = ["session", "product", "page", "offer", "subscription", "email"];
  const keys = families.map((f) => sandboxKey(s.id, f)!);
  const ends = await redisPipeline(keys.map((k) => ["PEXPIRETIME", k]));
  check("every sandbox key ends at the session's end", ends, keys.map(() => s.expiresAt));
  check("the first drafts are as written", await redisPipeline(keys.slice(1).map((k) => ["GET", k])), STUDIO_DEMO_SEED_VALUES);
  const all = (await one(["KEYS", "*"])) as string[];
  check("no key outside the demo's namespace but the store set before", all.filter((k) => !k.startsWith(DEMO_NAMESPACE)), ["nl:store:0123456789abcdef0123456789abcdef"]);
  check("the addresses' counts end with the day", await one(["PEXPIRETIME", `${DEMO_NAMESPACE}addr:${day}`]), (Math.floor(now / 86_400_000) + 1) * 86_400_000);
  const network: boolean[] = [];
  for (let i = 0; i < DEMO_SESSIONS_PER_ADDRESS_PER_DAY; i += 1) network.push((await openStudioDemo(door(`2001:db8:abcd:${i + 1}::1`), ON)).ok);
  const refusedBefore = Number(await one(["HGET", dayKey, "refused"]) ?? 0);
  check("one network opens its own, then is refused from yet another /64, the refusal counted", [network, await openStudioDemo(door("2001:db8:abcd:ff::1"), ON), Number(await one(["HGET", dayKey, "refused"])) - refusedBefore], [network.map(() => true), { ok: false, reason: "address" }, 1]);
  await one(["HSET", dayKey, "refused", String(DEMO_REFUSALS_PER_DAY)]);
  check("past the day's refusals the door is closed and counts nothing more", [await openStudioDemo(door("192.0.2.9"), ON), await one(["HGET", dayKey, "refused"])], [{ ok: false, reason: "closed" }, String(DEMO_REFUSALS_PER_DAY)]);
  await one(["HSET", dayKey, "refused", "0"]);
  check("the house key is untouched", await one(["GET", "nl:store:0123456789abcdef0123456789abcdef"]), "house");
  check("the session reads back", await readStudioDemo(new Request("https://marktmorgen.com/", { headers: { cookie: `${DEMO_COOKIE}=${s.id}` } }), ON), s);
  check("its life is its DEMO_SESSION_SECONDS", s.expiresAt - s.startedAt, DEMO_SESSION_SECONDS * 1000);

  const cost = { commands: 12, bytes: 100 };
  check("an action is counted", (await takeDemoAction(s, cost, ON)).ok, true);
  await one(["HSET", keys[0], "actions", String(DEMO_ACTIONS_PER_SESSION - 1)]);
  const race = await Promise.all([takeDemoAction(s, cost, ON), takeDemoAction(s, cost, ON)]);
  check("two actions at the last place: one passes", race.map((r) => (r.ok ? "ok" : r.reason)).sort(), ["actions", "ok"]);
  await one(["HSET", keys[0], "actions", "0", "bytes", String(DEMO_BYTES_PER_SESSION - 100)]);
  check("filling the bytes exactly runs", (await takeDemoAction(s, cost, ON)).ok, true);
  check("one byte past them is refused", await takeDemoAction(s, { commands: 12, bytes: 1 }, ON), { ok: false, reason: "bytes" });
  check("at its end it is over", await takeDemoAction(s, cost, { ...ON, now: () => s.expiresAt }), { ok: false, reason: "expired" });
  finish();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
