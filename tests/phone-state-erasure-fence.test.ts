/**
 * A phone alert whose push outlives its store's erasure, or its device's removal, writes no state back (Codex
 * G-20261120-1824, MEDIUM, lib/phone-alerts.ts deliver).
 *
 * deliver() sends the push, waits on the push service, then wrote the outcome with a plain HSET into
 * nl:phone:st:<statsId>. The store's erasure deletes that hash with the device list (forgetStorePhones), and a
 * device's removal or its person's erasure takes the device off the list, then deletes its field. A push answered after
 * either still wrote the field: the hash, or the removed device's field, came back holding its id, the time and the
 * last outcome.
 *
 * Checked with the real sendTest and alertCreator on the in-memory Redis. The push service's name lookup is a
 * stand-in that runs the erasure while the push waits, then answers nothing, so nothing leaves. Synthetic keys only.
 */
import { createECDH } from "node:crypto";
import { claimHandle, ensureStatsId } from "@/lib/store";
import { addDevice, alertCreator, forgetStorePhones, removeDevice, sendTest, setPhoneHooksForTests } from "@/lib/phone-alerts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";

const curve = createECDH("prime256v1");
curve.generateKeys();
const keys = { p256dh: curve.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") };
const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/fence-${n}`, keys });

/** What the push service's lookup does once, while the push waits; then it answers nothing. */
let during: (() => Promise<unknown>) | null = null;
setPhoneHooksForTests({
  resolve: async () => {
    const then = during;
    during = null;
    if (then) await then();
    throw new Error("a stand-in that answers nothing");
  },
} as never);

async function main(): Promise<void> {
  console.error = () => {};
  const owner = "phone-fence@example.com";
  await claimHandle(owner, "phonefence", "Phone Fence", "");
  const store = (await ensureStatsId(owner))!;
  const statsId = store.statsId!;
  const state = `nl:phone:st:${statsId}`;
  const add = async (n: number) => {
    const added = await addDevice(store, owner, "owner", sub(n), ["report"], `Phone ${n}`);
    if (!added.ok) throw new Error(`synthetic device: ${JSON.stringify(added)}`);
    return added.id;
  };
  const fields = () => (redis.run(["HKEYS", state]) as string[] | null) ?? [];

  part("A live store: a test push writes its device's state");
  const first = await add(1);
  await sendTest(store, owner, "owner", first);
  is("the device's state is kept", fields(), [first]);

  part("The store is erased while a test push waits: no state comes back");
  during = () => forgetStorePhones(statsId);
  await sendTest(store, owner, "owner", first).catch(() => null);
  is("the state hash is not recreated", redis.run(["EXISTS", state]), 0);

  part("A device is removed while its test push waits: its state does not come back, the other's stays");
  redis.run(["DEL", state]);
  const one = await add(2);
  const two = await add(3);
  await sendTest(store, owner, "owner", two);
  during = () => removeDevice(store, owner, "owner", one);
  await sendTest(store, owner, "owner", one).catch(() => null);
  is("only the device still listed has a state", fields(), [two]);

  part("The store is erased while an alert's pushes wait: no state comes back");
  redis.run(["DEL", state]);
  during = () => forgetStorePhones(statsId);
  await alertCreator(store, "report", { title: "A report", body: "Synthetic", url: "/studio" } as never, { seed: "fence-1" }).catch(() => 0);
  is("the state hash is not recreated", redis.run(["EXISTS", state]), 0);

  // Claude 4's M1 on #5001: one alert's state writes are one script, its EVAL, one GET of the list and one HSET per
  // device still listed (N + 2), not three commands per device (180 at MAX_STORE_DEVICES, more than ORDER_COMPUTE).
  part("One alert's state writes for ten devices: one script, at most N + 2 commands");
  redis.run(["DEL", state, `nl:phone:cfg:${statsId}`]);
  const ten: string[] = [];
  for (let n = 10; n < 20; n += 1) ten.push(await add(n));
  const real = redis.pipeline.bind(redis);
  let stateCommands = 0;
  let stateScripts = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const command of commands) {
      if (command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:phone-state-if-listed:")) {
        stateScripts += 1;
        // A script counts as one command plus the calls inside it: one GET, and one HSET per pair still listed.
        stateCommands += 2 + (command.length - 5) / 2;
      } else if (command[0] === "HSET" && String(command[1]) === state) {
        stateCommands += 1;
      }
    }
    return real(commands);
  }) as typeof redis.pipeline;
  await alertCreator(store, "report", { title: "A report", body: "Synthetic", url: "/studio" } as never, { seed: "fence-cost" }).catch(() => 0);
  redis.pipeline = real;
  is("one script for the alert", stateScripts, 1);
  is("at most ten devices + 2 commands", stateCommands <= ten.length + 2, true);
  is("every device listed has its state", fields().sort(), [...ten].sort());

  done();
}

main().catch((error) => {
  console.error = globalThis.console.log;
  console.log(error);
  process.exit(1);
});
