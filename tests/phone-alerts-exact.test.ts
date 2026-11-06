/**
 * The store's phone-alert devices read in an unknown shape (rule 24): never
 * read as "no devices". Adding a device on such a read used to write the
 * store's list back with only the new device, so every teammate's phone
 * stopped being told; the studio said they had no device.
 * Synthetic only: the Redis stub and the test VAPID keys.
 */
import { createECDH } from "node:crypto";
import { claimHandle, ensureStatsId } from "@/lib/store";
import { addDevice, phoneView } from "@/lib/phone-alerts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
const curve = createECDH("prime256v1");
curve.generateKeys();
const keys = { p256dh: curve.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") };
const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/synthetic-${n}`, keys });

async function main(): Promise<void> {
  console.error = () => {};
  const owner = "phone-exact@example.com";
  await claimHandle(owner, "phoneexact", "Phone Exact", "");
  const store = (await ensureStatsId(owner))!;
  const cfg = `nl:phone:cfg:${store.statsId}`;
  const first = await addDevice(store, owner, "owner", sub(1), ["sale"], "Phone one");
  const second = await addDevice(store, "teammate@example.com", "admin", sub(2), ["sale"], "Phone two");
  if (!first.ok || !second.ok) throw new Error(`synthetic devices: ${JSON.stringify([first, second])}`);
  const [saved] = await real([["GET", cfg]]);
  const devices = async () => (JSON.parse(String((await real([["GET", cfg]]))[0])) as { devices: unknown[] }).devices.length;

  const malformed: [string, unknown[]][] = [
    ["no reply", []],
    ["undefined", [undefined]],
    ["a number", [7]],
    ["an object", [{}]],
    ["two replies", [saved, saved]],
    ["unreadable JSON", ["{"]],
  ];
  for (const [label, reply] of malformed) {
    part(`The device list answers ${label}`);
    await real([["SET", cfg, String(saved)]]);
    const configRead = (c: Commands) => c.length === 1 && c[0][0] === "GET" && c[0][1] === cfg;
    redis.pipeline = (async (c: Commands) => (configRead(c) ? [...reply] : real(c))) as typeof redis.pipeline;
    let added: string;
    try {
      const result = await addDevice(store, owner, "owner", sub(3), ["sale"], "Phone three");
      added = result.ok ? "added" : result.reason;
    } catch {
      added = "rejected";
    } finally {
      redis.pipeline = real;
    }
    is("adding a device is not done on a guess", added, "rejected");
    is("both devices are still kept", await devices(), 2);
    const viewRead = (c: Commands) => c.length === 2 && c[0][0] === "GET" && c[0][1] === cfg;
    redis.pipeline = (async (c: Commands) => (viewRead(c) ? [reply[0], (await real([c[1]]))[0]] : real(c))) as typeof redis.pipeline;
    let view: string;
    try {
      view = String((await phoneView(store, owner, "owner")).devices.length);
    } catch {
      view = "rejected";
    } finally {
      redis.pipeline = real;
    }
    is("the studio is never told there is no device", view, label === "two replies" ? "1" : "rejected");
  }

  part("The device states answer in an unknown shape: the studio view rejects");
  const viewRead = (c: Commands) => c.length === 2 && c[0][0] === "GET" && c[0][1] === cfg;
  for (const states of [undefined, 3, ["odd"], [1, 2]]) {
    redis.pipeline = (async (c: Commands) => (viewRead(c) ? [(await real([c[0]]))[0], states] : real(c))) as typeof redis.pipeline;
    let view: string;
    try {
      view = String((await phoneView(store, owner, "owner")).devices.length);
    } catch {
      view = "rejected";
    } finally {
      redis.pipeline = real;
    }
    is(`states ${JSON.stringify(states)}`, view, "rejected");
  }

  part("Controls: a healthy list, and a confirmed empty one");
  is("the owner's own device in the view", (await phoneView(store, owner, "owner")).devices.length, 1);
  await real([["DEL", cfg]]);
  is("no list at all: no device", (await phoneView(store, owner, "owner")).devices.length, 0);
  const fresh = await addDevice(store, owner, "owner", sub(4), ["sale"], "Phone four");
  is("and a device can be added to it", [fresh.ok, await devices()], [true, 1]);
  done();
}

void main();
