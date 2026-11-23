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
import { PHONE_STATE_IF_LISTED, PHONE_UNLIST_AND_FORGET, PHONE_UNLIST_FORGET_COMMANDS, addDevice, forgetPerson } from "@/lib/phone-alerts";
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
  /** A command that deletes device states: a plain HDEL, or the script that unlists and forgets in one step. */
  const forgets = (c: Commands) => (c[0]?.[0] === "HDEL" && c[0]?.[1] === st) || (c[0]?.[0] === "EVAL" && String(c[0]?.[1]).startsWith("-- marktmorgen:phone-unlist-forget:v1\n"));
  /** A command that takes devices off the list: any script on the list other than an alert's own state write. */
  const unlists = (c: Commands) => c[0]?.[0] === "EVAL" && c[0].includes(cfg) && !String(c[0]?.[1]).startsWith("-- marktmorgen:phone-state-if-listed:v1\n");
  const listed = async (id: string) => String((await real([["GET", cfg]]))[0]).includes(id);

  part("A removed teammate's state HDEL that proves nothing keeps the device reachable");
  const added = await addDevice(store, mate, "admin", sub(1), ["sale"], "Mate phone");
  if (!added.ok) throw new Error(`synthetic device: ${JSON.stringify(added)}`);
  const id = (JSON.parse(String((await real([["GET", cfg]]))[0])) as { devices: { id: string }[] }).devices[0].id;
  await real([["HSET", st, id, JSON.stringify({ at: 1, status: 201 })]]);
  for (const [label, reply] of [["no reply", []], ["undefined", [undefined]], ["more than named", [2]], ["a string", ["1"]]] as [string, unknown[]][]) {
    redis.pipeline = (async (c: Commands) => (forgets(c) ? [...reply] : real(c))) as typeof redis.pipeline;
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
    if (forgets(c)) {
      hdels += 1;
      if (hdels === 1) {
        // The mate adds a device just before the first forgetting command lands.
        const config = JSON.parse(String((await real([["GET", cfg]]))[0])) as { devices: { id: string }[] };
        const copy = { ...config.devices.find((d) => d.id === firstId)!, id: lateId };
        await real([["SET", cfg, JSON.stringify({ ...config, devices: [...config.devices, copy] })], ["HSET", st, lateId, JSON.stringify({ at: 2, status: 201 })]]);
        return real(c);
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

  part("An alert's state written between the state HDEL and the unlisting is gone too (Claude 1 bUAk on #5105)");
  const third = await addDevice(store, mate, "admin", sub(3), ["sale"], "Mate phone in flight");
  if (!third.ok) throw new Error(`synthetic device: ${JSON.stringify(third)}`);
  const inFlight = (JSON.parse(String((await real([["GET", cfg]]))[0])) as { devices: { id: string; who?: string }[] }).devices.find((d) => d.who === mate)!.id;
  let fired = false;
  redis.pipeline = (async (c: Commands) => {
    if (!fired && unlists(c)) {
      fired = true;
      // keepStates of an alert sent just before the removal: the device is still listed, so the fence lets it in.
      await real([["EVAL", PHONE_STATE_IF_LISTED, 2, cfg, st, inFlight, JSON.stringify({ at: 3, ok: true, status: 201, error: "" })]]);
    }
    return real(c);
  }) as typeof redis.pipeline;
  is("the removal resolves", await outcome(() => forgetPerson(store, mate)), "resolved");
  is("the in-flight write happened", fired, true);
  is("the device left the list", String((await real([["GET", cfg]]))[0]).includes(inFlight), false);
  is("and its state is gone too", Number((await real([["HEXISTS", st, inFlight]]))[0]), 0);

  part("An alert's state written just before the unlisting, with any one command of the removal lost (Claude 7 xAF's LEVE on #5105)");
  // xAF (7076320256): an alert's keepStates lands between the state HDEL and the unlisting, and the final HDEL's reply
  // proves nothing: the state stayed under an id already off the list, and a repeat found nothing to do. Here every
  // command of the removal in turn is lost, either never run ("dropped") or run with its reply lost ("unanswered");
  // after one repeat with Redis healthy, the device is never listed and its state is never kept.
  for (const mode of ["dropped", "unanswered"] as const) {
    for (let k = 1; k <= 8; k += 1) {
      const device = await addDevice(store, mate, "admin", sub(100 + k + (mode === "dropped" ? 0 : 50)), ["sale"], `Mate ${mode} ${k}`);
      if (!device.ok) throw new Error(`synthetic device: ${JSON.stringify(device)}`);
      const lostId = (JSON.parse(String((await real([["GET", cfg]]))[0])) as { devices: { id: string; who?: string }[] }).devices.find((d) => d.who === mate)!.id;
      await real([["HSET", st, lostId, JSON.stringify({ at: 1, status: 201 })]]);
      let calls = 0;
      let alerted = false;
      redis.pipeline = (async (c: Commands) => {
        if (!alerted && unlists(c)) {
          alerted = true;
          await real([["EVAL", PHONE_STATE_IF_LISTED, 2, cfg, st, lostId, JSON.stringify({ at: 4, ok: true, status: 201, error: "" })]]);
        }
        calls += 1;
        if (calls !== k) return real(c);
        if (mode === "unanswered") await real(c);
        return [];
      }) as typeof redis.pipeline;
      await outcome(() => forgetPerson(store, mate));
      await outcome(() => forgetPerson(store, mate));
      const kept = Number((await real([["HEXISTS", st, lostId]]))[0]);
      is(`${mode} command ${k}: after a repeat the device is off the list and its state is gone`, [await listed(lostId), kept], [false, 0]);
    }
  }

  part("The team route never swallows a device erasure that failed");
  const route = readFileSync("app/api/store/team/route.ts", "utf8");
  is("no catch around forgetPerson that drops the failure", /forgetPerson\([^)]*\)\s*\.catch/.test(route), false);
  is("a failure answers 503 'devices' so Remove can be pressed again", /devices: 503/.test(route), true);
  is("every call to forgetDevices reads its answer, the repeat of a removal included (Claude 1's LOW 1 on #5105)", /^\s*await forgetDevices\(/m.test(route), false);
  is("a repeat whose devices are still to remove says so", /repeat_devices/.test(route) && /repeat_devices:/.test(readFileSync("components/team-manager.tsx", "utf8")), true);
  console.error = quiet;
  part("The removal script's billed commands are its own count (Claude 2 lpgvy's NIT on #5105)");
  // Upstash bills a script 1 plus every redis.call written in it; the cost line for forgetPerson prices a round with
  // PHONE_UNLIST_FORGET_COMMANDS, so a call added to the script without it fails here.
  is("PHONE_UNLIST_FORGET_COMMANDS is 1 plus the redis.call in PHONE_UNLIST_AND_FORGET",
    PHONE_UNLIST_FORGET_COMMANDS, 1 + (PHONE_UNLIST_AND_FORGET.match(/redis\.call\(/g) ?? []).length);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
