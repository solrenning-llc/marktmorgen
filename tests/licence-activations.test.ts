/**
 * 610 [WP9] unit 2: the devices each license key runs on, kept in the store's
 * database (lib/licence-activations.ts), on the rules of unit 1
 * (lib/licence-activation-rules.ts).
 *
 *   - Only a keyed one-way digest of the device is kept, never what the
 *     creator's software sent; the same device on two keys gives two digests.
 *   - The record expires by itself (ACTIVATION_KEEP_SECONDS after its last
 *     write), is refused past MAX_ACTIVATION_RECORD_BYTES, and takes its room
 *     in the store's data room before it is written: a full room writes nothing.
 *   - Every Redis answer is read in its exact shape (CX-123 rule 24): a record,
 *     a time to live, a lock or a write answered any other way is never a yes,
 *     and nothing is written on it.
 *   - Two activations at once never pass the limit (a lock per key).
 *   - The buyer frees a device at most 3 times in 30 days.
 *   - The person's copy of their data carries the devices of their keys.
 *
 * Synthetic store and an in-memory Redis only.
 */
import {
  ACTIVATION_COMMANDS,
  ACTIVATION_KEEP_SECONDS,
  ACTIVATION_REFRESH_SECONDS,
  ACTIVATION_REQUEST_UNITS,
  MAX_ACTIVATION_RECORD_BYTES,
  activateDevice,
  activationsOf,
  deviceDigest,
  devicesOf,
  releaseDevice,
} from "@/lib/licence-activations";
import { MAX_ACTIVATIONS, RELEASES_PER_WINDOW, RELEASE_WINDOW_SECONDS } from "@/lib/licence-activation-rules";
import { UnknownReplyError } from "@/lib/redis-reply";
import { dataKey } from "@/lib/store-data";
import { COPY_PLAN } from "@/lib/person-copy";
import { PERSON_DATA } from "@/lib/person-data";
import type { Store } from "@/lib/store";
import { request } from "./plan-cost-registry";
import { laterPageCost } from "./traffic-cost";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const store = { sid: "s_wp9u2", statsId: "st_wp9u2", handle: "wp9-keys", tier: "creator", subscriptionActive: true, subscriptionId: "sub_wp9u2", trialEnds: 0, planEndedAt: "" } as unknown as Store;
const product = { id: "p_app" };
const KEY = "APP-7K3M-QX9P-T2WD";
const OTHER_KEY = "APP-H4ZN-8RLC-V6YB";
const LAPTOP = "4c4c4544-0042-3510-8051-b4c04f4a4d32";
const DESKTOP = "machine:7f3e9a10c2b84d5e";
const TABLET = "tablet.5b2f0e7d91a3";
const PHONE = "phone-0a1b2c3d4e5f";
const valid = { standing: "valid" as const, limit: 2 };

const sent: (string | number)[][] = [];
const original = redis.pipeline.bind(redis);
let answer: ((commands: (string | number)[][]) => unknown[] | null | Promise<unknown[]>) | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  sent.push(...commands);
  const odd = await answer?.(commands);
  if (odd) return odd;
  return original(commands);
}) as typeof redis.pipeline;
const writes = () => sent.filter((c) => c[0] === "SET" && String(c[1]).includes(":act:"));
const recordKeys = () => redis.keys().filter((k) => k.includes(":act:"));
const fresh = () => {
  redis.clear();
  sent.length = 0;
  answer = null;
};
const roomUsed = async () => Number((await original([["HGET", dataKey(store)!, "#"]]))[0] ?? 0);
const now = () => redis.now();

async function main(): Promise<void> {
  part("A device takes a place; only a digest of it is kept");
  fresh();
  {
    const first = await activateDevice(store, product, KEY, { ...valid, device: LAPTOP }, now());
    is("the first device is activated, one place of two used", [first.outcome, "used" in first ? first.used : -1], ["activated", 1]);
    const kept = recordKeys();
    is("one record, under the key's own name", kept.length, 1);
    const raw = String((await original([["GET", kept[0]]]))[0]);
    is("the device's identifier is nowhere in the database", redis.keys().some((k) => k.includes(LAPTOP)) || raw.includes(LAPTOP), false);
    is("nor the license key itself in the record's name", kept[0].includes(KEY), false);
    is("what is kept is the digest", raw.includes(deviceDigest(store, product, KEY, LAPTOP)!), true);
    const ttl = Number((await original([["TTL", kept[0]]]))[0]);
    is("and it expires by itself", ttl > ACTIVATION_KEEP_SECONDS - 5 && ttl <= ACTIVATION_KEEP_SECONDS, true);
    is("its room was taken in the store's data room", (await roomUsed()) > 0, true);
    is("the same device on another key gives another digest", deviceDigest(store, product, OTHER_KEY, LAPTOP) !== deviceDigest(store, product, KEY, LAPTOP), true);
    is("a digest passes the rules' own device check", /^[0-9a-f]{32}$/.test(deviceDigest(store, product, KEY, LAPTOP)!), true);

    sent.length = 0;
    const again = await activateDevice(store, product, KEY, { ...valid, device: ` ${LAPTOP} ` }, now());
    is("the same device again runs and takes no new place", [again.outcome, "used" in again ? again.used : -1], ["already", 1]);
    is("and writes nothing", writes().length, 0);
    const second = await activateDevice(store, product, KEY, { ...valid, device: DESKTOP }, now());
    is("a second device takes the second place", [second.outcome, "used" in second ? second.used : -1], ["activated", 2]);
    sent.length = 0;
    const third = await activateDevice(store, product, KEY, { ...valid, device: TABLET }, now());
    is("a third is refused: the key is full", [third.outcome, "used" in third ? third.used : -1, "limit" in third ? third.limit : -1], ["full", 2, 2]);
    is("and nothing is written for it", writes().length, 0);
    const listed = await devicesOf(store, product, KEY, now());
    is("the key's devices are listed as digests, oldest first", listed?.devices.map((d) => d.device), [deviceDigest(store, product, KEY, LAPTOP), deviceDigest(store, product, KEY, DESKTOP)]);
    is("with every release still open", listed?.releasesLeft, RELEASES_PER_WINDOW);
    const lowered = await activateDevice(store, product, KEY, { standing: "valid", limit: 1, device: DESKTOP }, now());
    is("a device already on the key still runs after the creator lowers the limit", lowered.outcome, "already");
  }

  part("The key and the limit come first, and nothing is read or written for them");
  fresh();
  {
    const revoked = await activateDevice(store, product, KEY, { standing: "revoked", limit: 2, device: LAPTOP }, now());
    const unknown = await activateDevice(store, product, KEY, { standing: "unknown", limit: 2, device: LAPTOP }, now());
    const off = await activateDevice(store, product, KEY, { standing: "valid", limit: 0, device: LAPTOP }, now());
    const badLimit = await activateDevice(store, product, KEY, { standing: "valid", limit: null, device: LAPTOP }, now());
    const tooMany = await activateDevice(store, product, KEY, { standing: "valid", limit: MAX_ACTIVATIONS + 1, device: LAPTOP }, now());
    const badDevice = await activateDevice(store, product, KEY, { ...valid, device: "x y" }, now());
    const noDevice = await activateDevice(store, product, KEY, { ...valid, device: undefined }, now());
    is(
      "revoked, never given, off, an unreadable limit, a bad device",
      [revoked.outcome, unknown.outcome, off.outcome, badLimit.outcome, tooMany.outcome, badDevice.outcome, noDevice.outcome],
      ["revoked", "unknown_key", "off", "unavailable", "unavailable", "bad_device", "bad_device"],
    );
    is("not one command was sent for them", sent.length, 0);
    await activateDevice(store, product, KEY, { ...valid, device: LAPTOP }, now());
    const after = await activateDevice(store, product, KEY, { standing: "revoked", limit: 2, device: LAPTOP }, now());
    is("a key revoked after a device took its place no longer activates it", after.outcome, "revoked");
  }

  part("The buyer frees a device: a place opens, 3 times in 30 days at most");
  fresh();
  {
    await activateDevice(store, product, KEY, { ...valid, device: LAPTOP }, now());
    await activateDevice(store, product, KEY, { ...valid, device: DESKTOP }, now());
    const laptop = deviceDigest(store, product, KEY, LAPTOP)!;
    const freed = await releaseDevice(store, product, KEY, laptop, now());
    is("the laptop is freed", freed.outcome, "released");
    const tablet = await activateDevice(store, product, KEY, { ...valid, device: TABLET }, now());
    is("and the place it held takes the tablet", tablet.outcome, "activated");
    const gone = await releaseDevice(store, product, KEY, laptop, now());
    is("a device not on the key is not found", gone.outcome, "not_found");
    is("the raw identifier is never what frees a device", (await releaseDevice(store, product, KEY, DESKTOP, now())).outcome, "not_found");
    await releaseDevice(store, product, KEY, deviceDigest(store, product, KEY, TABLET)!, now());
    await activateDevice(store, product, KEY, { ...valid, device: PHONE }, now());
    await releaseDevice(store, product, KEY, deviceDigest(store, product, KEY, PHONE)!, now());
    is("three releases used", (await devicesOf(store, product, KEY, now()))?.releasesLeft, 0);
    await activateDevice(store, product, KEY, { ...valid, device: LAPTOP }, now());
    sent.length = 0;
    const fourth = await releaseDevice(store, product, KEY, laptop, now());
    is("a fourth in the window is refused, with the time the first stops counting", [fourth.outcome, "nextAt" in fourth && fourth.nextAt > Math.floor(now() / 1000)], ["limit", true]);
    is("and nothing is written for it", writes().length, 0);
    redis.advance((RELEASE_WINDOW_SECONDS + 60) * 1000);
    is("once the window has passed, a release opens again", (await releaseDevice(store, product, KEY, laptop, now())).outcome, "released");
  }

  part("Two activations at once never pass the limit");
  fresh();
  {
    const both = await Promise.all([
      activateDevice(store, product, KEY, { standing: "valid", limit: 1, device: LAPTOP }, now()),
      activateDevice(store, product, KEY, { standing: "valid", limit: 1, device: DESKTOP }, now()),
    ]);
    is("one is activated, the other refused", both.filter((d) => d.outcome === "activated").length, 1);
    is("the record holds one device", (await devicesOf(store, product, KEY, now()))?.devices.length, 1);
  }

  part("Unknown is never yes (rule 24)");
  fresh();
  {
    const name = () => recordKeys()[0];
    await activateDevice(store, product, KEY, { ...valid, device: LAPTOP }, now());
    const kept = String((await original([["GET", name()]]))[0]);
    await original([["SET", name(), "{\"devices\":\"broken\"}", "EX", 3_600]]);
    sent.length = 0;
    const onBroken = await activateDevice(store, product, KEY, { ...valid, device: DESKTOP }, now());
    const freeBroken = await releaseDevice(store, product, KEY, deviceDigest(store, product, KEY, LAPTOP)!, now());
    is("a record it would not write refuses the activation and the release", [onBroken.outcome, freeBroken.outcome], ["unavailable", "unavailable"]);
    is("and is never read as a key with no devices", await devicesOf(store, product, KEY, now()), null);
    is("nothing was written over it", writes().length, 0);
    await original([["SET", name(), kept, "EX", ACTIVATION_KEEP_SECONDS]]);

    answer = (commands) => (commands[0][0] === "GET" && commands.length === 2 ? [3, -2] : null);
    is("a GET answered with a number refuses", (await activateDevice(store, product, KEY, { ...valid, device: DESKTOP }, now())).outcome, "unavailable");
    answer = (commands) => (commands[0][0] === "GET" && commands.length === 2 ? [null, 3_600] : null);
    is("no record but a time to live: unknown, refused", (await activateDevice(store, product, KEY, { ...valid, device: DESKTOP }, now())).outcome, "unavailable");
    answer = (commands) => (commands[0][0] === "GET" && commands.length === 2 ? [null] : null);
    is("an answer cut short refuses", (await activateDevice(store, product, KEY, { ...valid, device: DESKTOP }, now())).outcome, "unavailable");
    answer = (commands) => (commands[0][0] === "GET" && commands.length === 2 ? [kept, "3600"] : null);
    is("a time to live in another shape refuses", (await activateDevice(store, product, KEY, { ...valid, device: DESKTOP }, now())).outcome, "unavailable");
    answer = null;

    sent.length = 0;
    answer = (commands) => (commands[0][0] === "SET" && String(commands[0][1]).includes(":actlock:") ? ["QUEUED"] : null);
    is("a lock answered in another shape refuses", (await activateDevice(store, product, KEY, { ...valid, device: DESKTOP }, now())).outcome, "unavailable");
    is("and nothing is written", writes().length, 0);
    answer = null;

    const lock = name().replace(":act:", ":actlock:");
    await original([["SET", lock, "somebody-else", "EX", 60]]);
    sent.length = 0;
    is("a lock another request holds refuses after a short wait", (await activateDevice(store, product, KEY, { ...valid, device: DESKTOP }, now())).outcome, "unavailable");
    is("nothing is written, and the other's lock stays", [writes().length, (await original([["GET", lock]]))[0]], [0, "somebody-else"]);
    await original([["DEL", lock]]);

    answer = (commands) => (commands[0][0] === "SET" && String(commands[0][1]).includes(":act:") ? ["QUEUED"] : null);
    const lost = await activateDevice(store, product, KEY, { ...valid, device: DESKTOP }, now());
    is("a write answered in another shape, not read back, is not an activation", lost.outcome, "unavailable");
    const landed: (string | number)[][] = [];
    answer = (commands) => {
      if (commands[0][0] === "SET" && String(commands[0][1]).includes(":act:")) {
        landed.push(commands[0]);
        return original(commands).then(() => ["QUEUED"]);
      }
      return null;
    };
    const readBack = await activateDevice(store, product, KEY, { ...valid, device: DESKTOP }, now());
    is("one that landed, read back as ours, is", [readBack.outcome, landed.length], ["activated", 1]);
    answer = null;

    const before = process.env.NIMBUS_DATA_KEY;
    const stripe = process.env.STRIPE_SECRET_KEY;
    delete process.env.NIMBUS_DATA_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    sent.length = 0;
    const noSecret = await activateDevice(store, product, OTHER_KEY, { ...valid, device: LAPTOP }, now());
    process.env.NIMBUS_DATA_KEY = before;
    if (stripe !== undefined) process.env.STRIPE_SECRET_KEY = stripe;
    is("with no key to make the digest from, nothing is activated or written", [noSecret.outcome, writes().length], ["unavailable", 0]);
  }

  part("The store's data room is taken before the write");
  fresh();
  {
    await original([["HSET", dataKey(store)!, "#", 1_000_000_000_000]]);
    sent.length = 0;
    const full = await activateDevice(store, product, KEY, { ...valid, device: LAPTOP }, now());
    is("a full room refuses the activation", full.outcome, "unavailable");
    is("and nothing is written", [writes().length, recordKeys().length], [0, 0]);
  }

  part("A device in use keeps the record alive");
  fresh();
  {
    await activateDevice(store, product, KEY, { ...valid, device: LAPTOP }, now());
    redis.advance((ACTIVATION_KEEP_SECONDS - ACTIVATION_REFRESH_SECONDS - 60) * 1000);
    sent.length = 0;
    await activateDevice(store, product, KEY, { ...valid, device: LAPTOP }, now());
    is("with more than the refresh time left, a check writes nothing", writes().length, 0);
    redis.advance(120 * 1000);
    const refreshed = await activateDevice(store, product, KEY, { ...valid, device: LAPTOP }, now());
    const ttl = Number((await original([["TTL", recordKeys()[0]]]))[0]);
    is("with less, the check writes it again for a full term", [refreshed.outcome, writes().length, ttl > ACTIVATION_KEEP_SECONDS - 5], ["already", 1, true]);
    redis.advance((ACTIVATION_KEEP_SECONDS + 1) * 1000);
    is("a record nobody used for a full term is gone, and the key starts again", (await devicesOf(store, product, KEY, now()))?.devices.length, 0);
  }

  part("Bounded: bytes and commands");
  fresh();
  {
    const limit = MAX_ACTIVATIONS;
    for (let i = 0; i < limit; i += 1) await activateDevice(store, product, KEY, { standing: "valid", limit, device: `device-${String(i).padStart(4, "0")}-abcdef` }, now());
    for (let i = 0; i < RELEASES_PER_WINDOW; i += 1) {
      await releaseDevice(store, product, KEY, deviceDigest(store, product, KEY, `device-${String(i).padStart(4, "0")}-abcdef`)!, now());
      await activateDevice(store, product, KEY, { standing: "valid", limit, device: `device-${String(i + 100).padStart(4, "0")}-abcdef` }, now());
    }
    const raw = String((await original([["GET", recordKeys()[0]]]))[0]);
    is("the fullest record fits under its ceiling", Buffer.byteLength(raw) <= MAX_ACTIVATION_RECORD_BYTES, true);
    sent.length = 0;
    await activateDevice(store, product, OTHER_KEY, { standing: "valid", limit, device: LAPTOP }, now());
    is("an activation sends no more commands than it is priced at", sent.length <= ACTIVATION_COMMANDS, true);
    const cost = request("wait", ACTIVATION_COMMANDS, 3 * MAX_ACTIVATION_RECORD_BYTES);
    is("and its requests cost more than its commands and bytes", ACTIVATION_REQUEST_UNITS * laterPageCost() >= cost, true);
  }

  part("The person's copy of their data");
  fresh();
  {
    await activateDevice(store, product, KEY, { ...valid, device: LAPTOP }, now());
    await releaseDevice(store, product, KEY, deviceDigest(store, product, KEY, LAPTOP)!, now());
    await activateDevice(store, product, KEY, { ...valid, device: DESKTOP }, now());
    const copy = await activationsOf(store, [{ product: product.id, key: KEY }, { product: product.id, key: OTHER_KEY }]);
    is("one row per key with devices or releases", copy.length, 1);
    is("its devices, as digests, and when one was freed", [copy[0].key, copy[0].devices.map((d) => d.device), copy[0].freed.length], [KEY, [deviceDigest(store, product, KEY, DESKTOP)], 1]);
    answer = (commands) => (commands[0][0] === "GET" ? commands.map(() => 7) : null);
    let threw = "";
    try {
      await activationsOf(store, [{ product: product.id, key: KEY }]);
    } catch (error) {
      threw = error instanceof UnknownReplyError ? "unknown" : String(error);
    }
    answer = null;
    is("an answer it cannot read stops the copy, never leaves the devices out", threw, "unknown");
    is("the copy plan says it is copied", COPY_PLAN["lib/licence-activations.ts"]?.how, "copied");
    is("and the registry says what deleting a person does to it", PERSON_DATA.find((d) => d.file === "lib/licence-activations.ts")?.how, "kept");
  }
  done();
}

void main();
