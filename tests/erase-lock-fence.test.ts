/**
 * Rule 30, synthetic only: no step of the closing walk's preparation (lib/closed-store-data.ts, prepareStore) deletes
 * anything of a store whose plan runs again once the walk's lock on it ran out (Codex M's focal M1 on #3156, whose
 * proof is tests/m-3156-expired-delete-observed.proof.ts, SHA256 4cabdc83...).
 *
 * The walk takes the store's own lock (lib/store.ts) when it sees the store still due, and makes it last again before
 * each step that deletes (keep). A step's deletes were then sent as a separate pipeline, without the lock: when the
 * lock ran out between the renewal and the delete (a paused function, a slow network), the plan could start again in
 * that moment, through the real writer, and the delete still landed on the store that runs again: its team, its
 * hosts' claims, its keys for the API, its webhooks, its email platform, its phones, its Path, its hosts' calendars,
 * and at the last step its record itself.
 *
 * Here, every pipeline the preparation sends that changes the database is found on a first run (the census), and then,
 * one at a time, the lock runs out on the stand-in's own clock just before that pipeline is sent and the real
 * setSubscription starts the plan again. What the database holds once the plan runs again must be exactly what it
 * holds after the walk: nothing of the store that runs again is deleted or changed, and the walk stops with
 * LockBusyError. No lock key is deleted by hand, no reply is forged.
 *
 * The record's last step is made by the walk from closingRecordChanges, lib/store.ts's closeStoreRecord spelled in
 * lib/closed-store-data.ts so it can be fenced: the last part here closes one store both ways, from the same database,
 * and fails if what is left ever differs.
 */
import { closingRecordChanges, eraseClosed, markDue, WALK_KEY } from "@/lib/closed-store-data";
import { claimHandle, closeStoreRecord, ensureStatsId, ensureStoreId, renameHandle, storeForEmail, storeRef } from "@/lib/store";
import { ENDED_INDEX } from "@/lib/plan-standing";
import { SHARING_INDEX } from "@/lib/platform-share";
import { putMember } from "@/lib/team";
import { claimsKey, hostId } from "@/lib/host-claims";
import { hostCalendarKeys } from "@/lib/host-calendar";
import { makeKey } from "@/lib/api-keys";
import { startPath } from "@/lib/path";
import { readAnswers } from "@/lib/path-rules";
import { store as redis } from "./redis-stub";
import { closeForErasure, reactivate } from "./closed-for-erasure";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;

type Command = (string | number)[];
const original = redis.pipeline.bind(redis);
const owner = "fence-owner@example.test";
const member = "fence-helper@example.test";
const CHANGES = new Set(["DEL", "UNLINK", "HDEL", "SREM", "ZREM", "SET", "HSET", "SADD", "ZADD", "EXPIRE", "PEXPIRE", "LPUSH", "RPUSH", "LREM", "LTRIM", "EVAL"]);
const LOCK_SCRIPTS = ["-- marktmorgen:extend:v1", "-- marktmorgen:release:v1", "-- marktmorgen:closing-take:v1"];

/** Whether a pipeline changes the database: a command that writes, or a script that is not the lock's own. */
const changes = (commands: Command[]) =>
  commands.some((c) => CHANGES.has(String(c[0])) && !(c[0] === "EVAL" && LOCK_SCRIPTS.some((name) => String(c[1]).startsWith(name))));
/** What a pipeline is, for the report: its first change and the keys it names. */
const named = (commands: Command[]) => {
  const c = commands.find((one) => CHANGES.has(String(one[0])))!;
  if (c[0] !== "EVAL") return `${c[0]} ${String(c[1]).replace(/[0-9a-f]{24,}/g, "…")}`;
  const script = String(c[1]).split("\n")[0].replace("-- marktmorgen:", "");
  return `EVAL ${script} ${c.slice(3, 3 + Number(c[2])).map((k) => String(k).replace(/[0-9a-f]{24,}/g, "…")).join(" ")}`;
};

/** Every key of the stand-in and its value, read as a whole, but the store locks (the walk's and the writer's own). */
async function everything(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const [[, keys]] = (await original([["SCAN", "0", "MATCH", "*", "COUNT", 1_000_000]])) as [string, string[]][];
  for (const key of [...new Set(keys)].sort()) {
    if (key.startsWith("nl:store:lock:")) continue;
    const [type] = (await original([["TYPE", key]])) as string[];
    const read: Command = type === "string" ? ["GET", key] : type === "hash" ? ["HGETALL", key] : type === "set" ? ["SMEMBERS", key]
      : type === "zset" ? ["ZRANGEBYSCORE", key, "-inf", "+inf", "WITHSCORES"] : type === "list" ? ["LRANGE", key, 0, -1] : ["TYPE", key];
    const [value] = await original([read]);
    out.set(key, JSON.stringify(Array.isArray(value) && type === "set" ? [...value].map(String).sort() : value));
  }
  return out;
}

/** Every key with its type, to put the database back as it was. */
async function dump(): Promise<[string, string, unknown][]> {
  const out: [string, string, unknown][] = [];
  const [[, keys]] = (await original([["SCAN", "0", "MATCH", "*", "COUNT", 1_000_000]])) as [string, string[]][];
  for (const key of [...new Set(keys)].sort()) {
    const [type] = (await original([["TYPE", key]])) as string[];
    const read: Command = type === "string" ? ["GET", key] : type === "hash" ? ["HGETALL", key] : type === "set" ? ["SMEMBERS", key]
      : type === "zset" ? ["ZRANGEBYSCORE", key, "-inf", "+inf", "WITHSCORES"] : ["LRANGE", key, 0, -1];
    const [value] = await original([read]);
    out.push([key, type, value]);
  }
  return out;
}

async function restore(rows: [string, string, unknown][]): Promise<void> {
  redis.clear();
  const flat = (value: unknown) => (Array.isArray(value) ? value.map(String) : Object.entries(value as Record<string, string>).flat());
  for (const [key, type, value] of rows) {
    if (type === "string") await original([["SET", key, String(value)]]);
    else if (type === "hash") await original([["HSET", key, ...flat(value)]]);
    else if (type === "set") await original([["SADD", key, ...flat(value)]]);
    else if (type === "zset") {
      const pairs = flat(value);
      const scored: string[] = [];
      for (let i = 0; i + 1 < pairs.length; i += 2) scored.push(pairs[i + 1], pairs[i]);
      await original([["ZADD", key, ...scored]]);
    } else await original([["RPUSH", key, ...flat(value)]]);
  }
}

/** What is left, the moment an address was let go of written as the same word, and each key's expiry as whether it has one within the quarantine. */
async function left(): Promise<Map<string, string>> {
  const out = await everything();
  for (const [key, value] of out) {
    const [ttl] = (await original([["TTL", key]])) as number[];
    out.set(key, `${value.replace(/released:[0-9TZ:.-]+/g, "released:*")} ttl:${ttl < 0 ? ttl : ttl > 29 * 86_400 && ttl <= 30 * 86_400 ? "quarantine" : "other"}`);
  }
  return out;
}

/** A store due for erasure with something in every step the preparation deletes from, made by the real writers where there is one. */
async function seed(): Promise<void> {
  redis.pipeline = original;
  redis.clear();
  await original([["HSET", WALK_KEY, "phase", "idle", "cursor", "0", "started", 1, "finished", 1]]);
  await claimHandle(owner, "fenceshop", "Synthetic fence shop", "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  const store = (await storeForEmail(owner))!;
  if (!(await putMember(store, member, "admin"))) throw new Error("Synthetic member setup failed");
  if (!(await makeKey(store.sid, "Synthetic key")).ok) throw new Error("Synthetic API key setup failed");
  const answers = readAnswers({ goalCents: 0, skills: "baking", subject: "bread", minutes: 15, audience: "none", timeZone: "UTC" }, store.currency);
  if (!answers.ok || !(await startPath(store, answers.answers)).ok) throw new Error("Synthetic Path setup failed");
  const later = Date.now() + 7 * 86_400_000;
  await original([
    // A host's claims on this store's calls, and a host's own calendar (as tests/closing-journey.ts writes them).
    ["HSET", claimsKey(hostId(owner)), "kfenceowner01", `1|2|${later}|${store.sid}:slot`],
    ["HSET", claimsKey(hostId(member)), "kfencehelp001", `1|2|${later}|${store.sid}:slot`],
    ["SET", hostCalendarKeys(hostId(owner))[0], JSON.stringify({ email: owner })],
    // Its webhooks, its email platform and its phones, by the keys their modules keep them under.
    ["SET", `nl:hooks:cfg:${store.statsId}`, JSON.stringify({ endpoints: [] })],
    ["SADD", "nl:hooks:stores", store.statsId!],
    ["SET", `nl:esync:cfg:${store.statsId}`, JSON.stringify({ provider: "none" })],
    ["SET", `nl:phone:cfg:${store.statsId}`, JSON.stringify({ phones: [] })],
  ]);
  await closeForErasure(owner);
  await markDue(storeRef(store), Date.now() - 1000);
}

/** Runs the walk, calling `at` before each pipeline the preparation sends that changes the database, while the walk holds the store's lock. */
async function walk(at: (index: number, commands: Command[]) => Promise<void>): Promise<string> {
  let holding = false;
  let index = 0;
  let inside = false;
  redis.pipeline = (async (commands: Command[]) => {
    if (inside) return original(commands);
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:release:v1"))) holding = false;
    if (holding && changes(commands)) {
      inside = true;
      try {
        await at(index++, commands);
      } finally {
        inside = false;
      }
    }
    const reply = await original(commands);
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:closing-take:v1")) && (reply as unknown[])[0] === 1) holding = true;
    return reply;
  }) as typeof redis.pipeline;
  try {
    await eraseClosed(Date.now() + 60_000, async () => {});
    return "completed";
  } catch (error) {
    return error instanceof Error ? error.name : "threw";
  } finally {
    redis.pipeline = original;
  }
}

async function main() {
  part("Control: a plan that runs again before the walk keeps the whole store");
  await seed();
  await reactivate(owner);
  const untouched = await everything();
  const control = await walk(async () => {});
  const after = await everything();
  is("the walk leaves it", control, "completed");
  // The walk's own line and its record of the walk change: the store that runs again leaves the line.
  const ours = (key: string) => key.startsWith("nl:closed:");
  is("nothing of it is deleted or changed", [...untouched.keys()].filter((key) => !ours(key) && after.get(key) !== untouched.get(key)), []);

  part("The census: every pipeline the preparation sends that changes the database, while it holds the lock");
  await seed();
  const store = (await storeForEmail(owner))!;
  const census: string[] = [];
  const touched = new Set<string>();
  await walk(async (_, commands) => {
    census.push(named(commands));
    for (const c of commands) for (const part of c.slice(1)) touched.add(String(part));
  });
  console.log(census.map((line, i) => `  ${i}: ${line}`).join("\n"));
  const reaches = (prefix: string) => [...touched].some((k) => k.startsWith(prefix));
  is("it reaches every step that deletes", {
    claims: reaches(claimsKey(hostId(owner))) && reaches(claimsKey(hostId(member))),
    team: reaches(`nl:team:${store.sid}`),
    apiKeys: reaches(`nl:api:keys:${store.sid}`),
    webhooks: reaches(`nl:hooks:cfg:${store.statsId}`),
    emailPlatform: reaches(`nl:esync:cfg:${store.statsId}`),
    phones: reaches(`nl:phone:cfg:${store.statsId}`),
    path: reaches(`nl:path:${store.sid}`),
    calendar: reaches(hostCalendarKeys(hostId(owner))[0]),
    record: reaches("nl:store:owner:"),
  }, { claims: true, team: true, apiKeys: true, webhooks: true, emailPlatform: true, phones: true, path: true, calendar: true, record: true });

  for (let n = 0; n < census.length; n += 1) {
    part(`The lock runs out just before step ${n} (${census[n]}), and the plan starts again`);
    await seed();
    let reached = false;
    let running: Map<string, string> = new Map();
    const outcome = await walk(async (index) => {
      if (index !== n) return;
      reached = true;
      // The stand-in's own clock: the walk's lock runs out by its expiry, never deleted by hand.
      redis.advance(120_001);
      await reactivate(owner);
      running = await everything();
    });
    const now = await everything();
    const current = await storeForEmail(owner);
    is("the plan started again at that step", reached, true);
    is("the walk stops there", outcome, "LockBusyError");
    is("the store runs", Boolean(current?.subscriptionActive), true);
    is("nothing of the store that runs again is deleted or changed", [...running.keys()].filter((key) => now.get(key) !== running.get(key)), []);
    // Nor is anything written for it once the lock ran out, such as a walk entry (nl:closed:batch) that did not exist
    // before (Claude 5 on #3156): the census above only compares keys that were already there.
    is("nothing is written for it either", [...now.keys()].filter((key) => !running.has(key)), []);
  }
  part("The record's last step: what the walk sends closes the record exactly as lib/store.ts's closeStoreRecord does");
  redis.pipeline = original;
  redis.clear();
  await claimHandle(owner, "fenceshop", "Synthetic fence shop", "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  if (!(await renameHandle(owner, "fenceshop-two")).ok) throw new Error("Synthetic rename failed");
  const closing = (await storeForEmail(owner))!;
  await original([["ZADD", ENDED_INDEX, 1, storeRef(closing)], ["SADD", SHARING_INDEX, storeRef(closing)]]);
  const base = await dump();
  await closeStoreRecord(closing);
  const byStore = await left();
  await restore(base);
  await original(closingRecordChanges(closing));
  const byWalk = await left();
  is("the store had two addresses, an id and a place in both lists", [closing.previousHandles.length, /^[0-9a-f]{32}$/.test(closing.sid)], [1, true]);
  is("what is left is the same", [...new Set([...byStore.keys(), ...byWalk.keys()])].filter((key) => byStore.get(key) !== byWalk.get(key)), []);
  is("and the record is gone", byWalk.has([...byStore.keys()].find((key) => key.startsWith("nl:store:owner:")) ?? "none"), false);
  is("its addresses are held back for the quarantine", [...byWalk].filter(([key]) => key.startsWith("nl:store:handle:")).map(([, value]) => value.endsWith("ttl:quarantine")), [true, true]);
  done();
}

void main();
