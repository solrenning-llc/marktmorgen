/**
 * #4811 (Codex G, MEDIUM, personal-data erasure; transcribed by Claude 2): a removed team member's phone-alert device
 * was taken out of the device list first and its state (`nl:phone:st:<statsId>`, the push endpoint's last answer)
 * deleted after, with no check of the reply. An HDEL that answered nothing useful left the state stored while
 * `forgetPerson` resolved, and the id was no longer in the list, so nothing could find it again; the team route also
 * swallowed any failure and answered the removal done.
 *
 * Now the states go first, on an exact reply, while the ids are still listed: a reply that proves nothing throws with
 * the device still reachable, and a repeat forgets it. The route says the devices are still to remove (503
 * "devices") instead of swallowing the failure.
 *
 * Adapted by Claude 5 iacVn3r (Codex adoption lane) from Claude 2's RED (`tests/phone-forget-exact.test.ts`, commit
 * 79214ee201 on `claude2/defect-phone-alerts-4751-4811`), keeping only the #4811 parts; #4751's part is about
 * `forgetStorePhones`, which main has since rewritten. Synthetic only: the Redis stub and the test VAPID keys.
 */
import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";
import { claimHandle, ensureStatsId } from "@/lib/store";
import { addDevice, forgetPerson } from "@/lib/phone-alerts";
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
  const quiet = console.error;
  console.error = () => {};
  const owner = "phone-forget@example.com";
  const mate = "phone-forget-mate@example.com";
  await claimHandle(owner, "phoneforget", "Phone Forget", "");
  const store = (await ensureStatsId(owner))!;
  const cfg = `nl:phone:cfg:${store.statsId}`;
  const st = `nl:phone:st:${store.statsId}`;

  part("A removed teammate's state HDEL that proves nothing keeps the device reachable");
  const added = await addDevice(store, mate, "admin", sub(1), ["sale"], "Mate phone");
  if (!added.ok) throw new Error(`synthetic device: ${JSON.stringify(added)}`);
  const id = (JSON.parse(String((await real([["GET", cfg]]))[0])) as { devices: { id: string }[] }).devices[0].id;
  await real([["HSET", st, id, JSON.stringify({ at: 1, status: 201 })]]);
  for (const [label, reply] of [["no reply", []], ["undefined", [undefined]], ["more than named", [2]], ["a string", ["1"]]] as [string, unknown[]][]) {
    redis.pipeline = (async (c: Commands) => (c[0]?.[0] === "HDEL" && c[0]?.[1] === st ? [...reply] : real(c))) as typeof redis.pipeline;
    is(`${label}: the removal is not reported done`, await outcome(() => forgetPerson(store, mate)), "threw");
    is(`${label}: the device is still in the list, so a repeat can find its id`, String((await real([["GET", cfg]]))[0]).includes(id), true);
  }
  is("a repeat forgets it", await outcome(() => forgetPerson(store, mate)), "resolved");
  is("the device state is gone", Number((await real([["HEXISTS", st, id]]))[0]), 0);
  is("and the device left the list", String((await real([["GET", cfg]]))[0]).includes(id), false);
  is("a further repeat, with nothing left, forgets nothing and resolves", await outcome(() => forgetPerson(store, mate)), "resolved");

  part("A device added during the removal leaves the list only once its state is gone (Claude 1's LOW 2 on #5105)");
  const again = await addDevice(store, mate, "admin", sub(2), ["sale"], "Mate phone again");
  if (!again.ok) throw new Error(`synthetic device: ${JSON.stringify(again)}`);
  const firstId = (JSON.parse(String((await real([["GET", cfg]]))[0])) as { devices: { id: string; who?: string }[] }).devices.find((d) => d.who === mate)!.id;
  await real([["HSET", st, firstId, JSON.stringify({ at: 1, status: 201 })]]);
  const lateId = "pd_0123456789abcdef";
  let hdels = 0;
  redis.pipeline = (async (c: Commands) => {
    if (c[0]?.[0] === "HDEL" && c[0]?.[1] === st) {
      hdels += 1;
      if (hdels === 1) {
        // The first state goes, and the mate adds a device before the list changes.
        const reply = await real(c);
        const config = JSON.parse(String((await real([["GET", cfg]]))[0])) as { devices: { id: string }[] };
        const copy = { ...config.devices.find((d) => d.id === firstId)!, id: lateId };
        await real([["SET", cfg, JSON.stringify({ ...config, devices: [...config.devices, copy] })], ["HSET", st, lateId, JSON.stringify({ at: 2, status: 201 })]]);
        return reply;
      }
      return [];
    }
    return real(c);
  }) as typeof redis.pipeline;
  is("a late device whose state HDEL proves nothing: the removal is not reported done", await outcome(() => forgetPerson(store, mate)), "threw");
  is("the late device is still in the list, so a repeat can find its id", String((await real([["GET", cfg]]))[0]).includes(lateId), true);
  is("a repeat forgets the late device", await outcome(() => forgetPerson(store, mate)), "resolved");
  is("its state is gone", Number((await real([["HEXISTS", st, lateId]]))[0]), 0);
  is("and it left the list", String((await real([["GET", cfg]]))[0]).includes(lateId), false);

  part("The team route never swallows a device erasure that failed");
  const route = readFileSync("app/api/store/team/route.ts", "utf8");
  is("no catch around forgetPerson that drops the failure", /forgetPerson\([^)]*\)\s*\.catch/.test(route), false);
  is("a failure answers 503 'devices' so Remove can be pressed again", /devices: 503/.test(route), true);
  is("every call to forgetDevices reads its answer, the repeat of a removal included (Claude 1's LOW 1 on #5105)", /^\s*await forgetDevices\(/m.test(route), false);
  is("a repeat whose devices are still to remove says so", /repeat_devices/.test(route) && /repeat_devices:/.test(readFileSync("components/team-manager.tsx", "utf8")), true);
  console.error = quiet;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
