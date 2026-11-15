/**
 * #4751 and #4811: forgetting phone-alert devices is done only on a reply that
 * proves it (rule 24). A deleted store's DEL that answers in another shape
 * throws, and the deleted store's durable forgetting line repeats it. A
 * removed teammate's device states are removed before the device leaves the
 * list, so a reply that proves nothing leaves the ids reachable for a repeat,
 * and the team route never swallows the failure.
 * Synthetic only: the Redis stub and the test VAPID keys.
 */
import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";
import { claimHandle, ensureStatsId } from "@/lib/store";
import { addDevice, forgetPerson, forgetStorePhones } from "@/lib/phone-alerts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
const curve = createECDH("prime256v1");
curve.generateKeys();
const keys = { p256dh: curve.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") };
const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/synthetic-forget-${n}`, keys });

async function outcome(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "resolved";
  } catch {
    return "threw";
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  console.error = () => {};
  const owner = "phone-forget@example.com";
  const mate = "phone-forget-mate@example.com";
  await claimHandle(owner, "phoneforget", "Phone Forget", "");
  const store = (await ensureStatsId(owner))!;
  const cfg = `nl:phone:cfg:${store.statsId}`;
  const st = `nl:phone:st:${store.statsId}`;

  part("#4751: a deleted store's DEL answered in another shape throws");
  for (const [label, reply] of [["no reply", []], ["undefined", [undefined]], ["three of two keys", [3]], ["a string", ["2"]]] as [string, unknown[]][]) {
    await real([["SET", cfg, "{}"], ["HSET", st, "x", "1"]]);
    redis.pipeline = (async (c: Commands) => (c[0]?.[0] === "DEL" && c[0]?.[1] === cfg ? [...reply] : real(c))) as typeof redis.pipeline;
    is(`${label}: not taken as forgotten`, await outcome(() => forgetStorePhones(store.statsId)), "threw");
  }
  is("an exact count resolves", await outcome(() => forgetStorePhones(store.statsId)), "resolved");
  is("and both records are gone", Number((await real([["EXISTS", cfg, st]]))[0]), 0);

  part("#4751: the deleted store's durable forgetting line repeats the phones");
  const retry = readFileSync("lib/store-forget-retry.ts", "utf8");
  is("forgetBoth forgets the store's phones", /const forgetBoth[\s\S]*?forgetStorePhones\(statsId\)[\s\S]*?\n};/.test(retry), true);

  part("#4811: a removed teammate's state HDEL that proves nothing keeps the device reachable");
  const added = await addDevice(store, mate, "admin", sub(1), ["sale"], "Mate phone");
  if (!added.ok) throw new Error(`synthetic device: ${JSON.stringify(added)}`);
  const id = (JSON.parse(String((await real([["GET", cfg]]))[0])) as { devices: { id: string }[] }).devices[0].id;
  await real([["HSET", st, id, JSON.stringify({ at: 1, status: 201 })]]);
  redis.pipeline = (async (c: Commands) => (c[0]?.[0] === "HDEL" && c[0]?.[1] === st ? [] : real(c))) as typeof redis.pipeline;
  is("the removal is not reported done", await outcome(() => forgetPerson(store, mate)), "threw");
  is("the device is still in the list, so a repeat can find its id", String((await real([["GET", cfg]]))[0]).includes(id), true);
  is("a repeat forgets it", await outcome(() => forgetPerson(store, mate)), "resolved");
  is("the device state is gone", Number((await real([["HEXISTS", st, id]]))[0]), 0);
  is("and the device left the list", String((await real([["GET", cfg]]))[0]).includes(id), false);

  part("#4811: the team route never swallows a device erasure that failed");
  const route = readFileSync("app/api/store/team/route.ts", "utf8");
  is("no catch around forgetPerson", /forgetPerson\([^)]*\)\s*\.catch/.test(route), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
