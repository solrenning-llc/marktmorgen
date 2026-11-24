/**
 * A phone registration never recreates an erased store's device list (Codex L-20261119-2022, #5010 row 124, #5250).
 *
 * addDevice changed the list through changeConfig, whose compare-and-set checked only the list's bytes. A store erased
 * while a registration was in flight deleted the list; the CAS that lost to that deletion read the list again, found
 * nil, and addDevice built a new one from nil and wrote it, with no expiry: the push endpoint, its keys, the device's
 * label and the teammate's address came back after the erasure, and the studio was told the device was added. A
 * registration whose first read came after the erasure was the same race, shorter.
 *
 * The registration now writes through ADD_DEVICE_IF_LIVE (lib/phone-alerts.ts): the store's fence (the identity rule
 * of lib/live-fence.ts store-keep-live:v1, built by lib/store-live-cache.ts storeLiveFence) read in the same step as
 * the compare-and-set. A store being erased, erased, whose id key now names another ref, or (from before ids) whose
 * record now carries another statsId gets nothing written, and the registration answers "unavailable" (the route's
 * 503). A live store registers as before, kept with no expiry as before.
 *
 * The studio's whole request that adds a device (POST /api/store/phone, action add) is measured against the studio
 * unit's envelope (coordinator's fence rule, 23/11 00:53 UTC), at one try and at its most, PHONE_ADD_TRIES: on main,
 * four tries of the plain compare-and-set already came to 30 against 27, and fenced they would come to 39.
 * Synthetic stores and devices; in-memory Redis; no push is ever sent.
 */
import { createECDH } from "node:crypto";
import * as nextServer from "next/server";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as phoneRoute } from "@/app/api/store/phone/route";
import { PHONE_ADD_TRIES, addDevice } from "@/lib/phone-alerts";
import { ERASING_KEY, claimHandle, ensureStatsId, ensureStoreId, erasingField, ownerKey, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { LOCKED_UNTIL_STAR_COMMANDS, TAKE_COMMANDS } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.VAPID_PUBLIC_KEY ??= "";

type Batch = (string | number)[][];
const OWNER = "phone-erasure@example.test";
const TEAMMATE = "team-person@example.test";
const EXTRA_SID = "aaaabbbbccccddddeeeeffff00001111";

const curve = createECDH("prime256v1");
curve.generateKeys();
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/synthetic-erased-store-device",
  keys: { p256dh: curve.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") },
};

const isAddScript = (c: (string | number)[]) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:phone-add-live:");
/** The list's write: main's plain compare-and-set (its key at index 3) or the fenced one (its key at index 5). */
const isConfigWrite = (batch: Batch, cfg: string) =>
  batch.length === 1 && batch[0][0] === "EVAL" && (batch[0][3] === cfg || (isAddScript(batch[0]) && batch[0][5] === cfg));
const isConfigRead = (batch: Batch, cfg: string) => batch.length === 1 && batch[0][0] === "GET" && batch[0][1] === cfg;

/** A primary store with an id, an extra store of the same owner, or a store from before ids (sid ""). */
async function storeFor(identity: "primary" | "extra" | "legacy"): Promise<Store> {
  redis.clear();
  if (!(await claimHandle(OWNER, "phoneerasure", "Synthetic Phone Store", "")).ok) throw new Error("no store");
  await ensureStoreId(OWNER);
  const base = (await ensureStatsId(OWNER))!;
  if (!base.statsId || !base.sid) throw new Error("no ids");
  if (identity === "primary") return base;
  if (identity === "legacy") {
    // The record under the owner's address, with no id: the fence reads that record's statsId.
    const legacy: Store = { ...base, sid: "" };
    redis.run(["DEL", storeIdCommand(base.sid)[1]]);
    redis.run(["SET", await ownerKey(storeRef(legacy)), JSON.stringify(legacy)]);
    return legacy;
  }
  // An extra store: its own id, its id key holding its own ref, its own statsId.
  const extra: Store = { ...base, sid: EXTRA_SID, extra: true, statsId: "extrastatsid0000000000000000" };
  redis.run(["SET", storeIdCommand(EXTRA_SID)[1], storeRef(extra)]);
  redis.run(["SET", await ownerKey(storeRef(extra)), JSON.stringify(extra)]);
  return extra;
}

async function main(): Promise<void> {
  console.error = () => {};
  const original = redis.pipeline.bind(redis);

  for (const identity of ["primary", "extra", "legacy"] as const) {
    for (const phase of ["gone", "erasing", "moved"] as const) {
      if (phase === "moved" && identity === "legacy") continue;
      for (const boundary of ["before the list is read", "before its compare-and-set"] as const) {
        part(`${identity} store, ${phase} ${boundary}: no device comes back`);
        const store = await storeFor(identity);
        const cfg = `nl:phone:cfg:${store.statsId}`;
        const live = identity === "legacy" ? await ownerKey(storeRef(store)) : storeIdCommand(store.sid)[1];
        const field = await erasingField(storeRef(store));
        redis.run(["SET", cfg, JSON.stringify({ handle: store.handle, devices: [] })]);
        let erased = false;
        redis.pipeline = (async (batch: Batch) => {
          if (!erased && (boundary === "before the list is read" ? isConfigRead(batch, cfg) : isConfigWrite(batch, cfg))) {
            erased = true;
            await original(
              phase === "gone"
                ? [["DEL", cfg, live]]
                : phase === "erasing"
                  ? [["HSET", ERASING_KEY, field, String(Date.now())], ["DEL", cfg]]
                  : [["SET", live, "someone-else@example.test"], ["DEL", cfg]],
            );
          }
          return original(batch);
        }) as typeof redis.pipeline;
        let result: unknown;
        try {
          result = await addDevice(store, TEAMMATE, "admin", subscription, ["report"], "Synthetic device");
        } finally {
          redis.pipeline = original;
        }
        is("the race was reached", erased, true);
        is("no endpoint, keys or teammate address is written after the erasure", redis.run(["GET", cfg]), null);
        is("the registration answers unavailable", result, { ok: false, reason: "unavailable" });
      }
    }

    part(`${identity} store, live: a device is registered as before`);
    {
      const store = await storeFor(identity);
      const cfg = `nl:phone:cfg:${store.statsId}`;
      const added = await addDevice(store, TEAMMATE, "admin", subscription, ["report"], "Synthetic device");
      is("added", added.ok, true);
      const saved = JSON.parse(String(redis.run(["GET", cfg]))) as { devices: { endpoint: string; who: string }[] };
      is("its endpoint and its person are kept", [saved.devices.length, saved.devices[0]?.endpoint, saved.devices[0]?.who], [1, subscription.endpoint, TEAMMATE]);
      is("kept with no expiry, as before", redis.run(["TTL", cfg]), -1);
    }
  }

  part("A store from before ids whose owner key now holds another store: the old store's device is refused");
  {
    const store = await storeFor("legacy");
    const cfg = `nl:phone:cfg:${store.statsId}`;
    const record = await ownerKey(storeRef(store));
    let replaced = false;
    redis.pipeline = (async (batch: Batch) => {
      if (!replaced && isConfigWrite(batch, cfg)) {
        replaced = true;
        await original([["SET", record, JSON.stringify({ ...store, statsId: "anotherstore000000000000000" })], ["DEL", cfg]]);
      }
      return original(batch);
    }) as typeof redis.pipeline;
    let result: unknown;
    try {
      result = await addDevice(store, OWNER, "owner", subscription, ["report"], "Synthetic device");
    } finally {
      redis.pipeline = original;
    }
    is("the race was reached", replaced, true);
    is("nothing is written under the old store's list", redis.run(["GET", cfg]), null);
    is("the registration answers unavailable", result, { ok: false, reason: "unavailable" });
  }

  part("Two devices added at once on a live store: both are kept (the fenced write still compares the list)");
  {
    const store = await storeFor("primary");
    const cfg = `nl:phone:cfg:${store.statsId}`;
    const other = { ...subscription, endpoint: `${subscription.endpoint}-2` };
    let raced = false;
    redis.pipeline = (async (batch: Batch) => {
      if (!raced && isConfigWrite(batch, cfg)) {
        raced = true;
        redis.pipeline = original;
        await addDevice(store, OWNER, "owner", other, ["report"], "The other device");
      }
      return original(batch);
    }) as typeof redis.pipeline;
    let added: { ok: boolean } = { ok: false };
    try {
      added = await addDevice(store, TEAMMATE, "admin", subscription, ["report"], "Synthetic device");
    } finally {
      redis.pipeline = original;
    }
    const saved = JSON.parse(String(redis.run(["GET", cfg]))) as { devices: { endpoint: string }[] };
    is("the race was reached and the first registration still lands", [raced, added.ok], [true, true]);
    is("both devices are listed", saved.devices.map((d) => d.endpoint).sort(), [other.endpoint, subscription.endpoint].sort());
  }

  part("The studio's whole request that adds a device stays inside the studio unit's envelope");
  {
    // Billed as Upstash bills a script, one plus every redis.call in its text (an upper bound: every branch counted),
    // and padded with the whole take allowance and lockedUntil's worst case, as tests/mail-draft-after-erasure.test.ts.
    const billedOf = (sent: Batch) => sent.reduce((sum, c) => sum + (c[0] === "EVAL" ? 1 + (String(c[1]).match(/redis\.call\(/g) ?? []).length : 1), 0);
    const envelope = 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
    const request = async (losses: number) => {
      const store = await storeFor("primary");
      const cfg = `nl:phone:cfg:${store.statsId}`;
      const session = await openSession(OWNER);
      const sent: Batch = [];
      let lost = 0;
      redis.pipeline = (async (batch: Batch) => {
        sent.push(...batch);
        // Another change lands between this request's read and its write, `losses` times (a registration goes through
        // the fenced path, which tries PHONE_ADD_TRIES times).
        if (lost < losses && isConfigWrite(batch, cfg)) {
          lost += 1;
          await original([["SET", cfg, JSON.stringify({ handle: store.handle, devices: [], n: lost })]]);
        }
        return original(batch);
      }) as typeof redis.pipeline;
      // The work the route leaves for after its answer (the owner's notice of a new device) is run here and counted too:
      // tests/next-server-after-world.ts holds it instead of running it.
      const held = (nextServer as unknown as { afterTasks: unknown[] }).afterTasks;
      held.length = 0;
      let status = 0;
      try {
        const response = await phoneRoute(new NextRequest("https://marktmorgen.com/api/store/phone", {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "Synthetic phone", cookie: `${SESSION_COOKIE}=${session}` },
          body: JSON.stringify({ action: "add", subscription, events: ["report"] }),
        }));
        status = response.status;
        for (const task of held.splice(0)) if (typeof task === "function") await (task as () => unknown)();
      } finally {
        redis.pipeline = original;
      }
      const billed = billedOf(sent);
      return { status, billed, measured: billed + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS, writes: sent.filter(isAddScript).length };
    };
    const once = await request(0);
    const worst = await request(PHONE_ADD_TRIES - 1);
    const beyond = await request(PHONE_ADD_TRIES);
    console.log("PHONE_ADD_ROUTE", JSON.stringify({ once, worst, beyond, takeWorst: TAKE_COMMANDS, lockedUntilWorst: LOCKED_UNTIL_STAR_COMMANDS, envelope }));
    is("the device is added (200), through the fenced write", [once.status, once.writes], [200, 1]);
    is(`one try, its billed commands padded (${once.measured}), stays within the studio unit's ${envelope}`, once.measured <= envelope, true);
    is(`${PHONE_ADD_TRIES} tries, the last one lands (200)`, [worst.status, worst.writes], [200, PHONE_ADD_TRIES]);
    is(`${PHONE_ADD_TRIES} tries, padded (${worst.measured}), stay within the studio unit's ${envelope}`, worst.measured <= envelope, true);
    is("one more lost try: no further write is sent, and the studio is told it did not work (500)", [beyond.status, beyond.writes], [500, PHONE_ADD_TRIES]);
    is(`and that request too stays within ${envelope}`, beyond.measured <= envelope, true);
  }

  done();
}

main().catch((error) => {
  console.error = globalThis.console.log;
  console.log(error);
  process.exit(1);
});
