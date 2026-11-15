/**
 * Issue #4666 (erasure, HIGH): a community push registration authorised before the member's erasure
 * (lib/community-push.ts, rememberDevice; renewDevice uses it) wrote the device hash, with the browser's
 * subscription, after the erasure had deleted it: a hash with no expiry the erasure had already passed. Transcribed
 * from Claude 2's reproduction on main @e4dbb5e9bf. The write is now made only while the member is still in, in the
 * same step; current members and the creator register as before.
 */
import { createECDH, randomBytes } from "node:crypto";
import { CREATOR, freshConfig, memberKey, saveConfig, touchMember } from "@/lib/community";
import { deviceCount, rememberDevice } from "@/lib/community-push";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "reach-a-local-key-for-tests-only-0123456789abcdef";
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;
type Command = (string | number)[];
const subscription = () => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/reach-${randomBytes(6).toString("hex")}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
};

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "club@d2push.example";
  const made = await claimHandle(OWNER, "d2pushclub", "D2 Push Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER); await ensureStoreId(OWNER); await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_D2Push1", subscriptionId: "sub_D2Push1", active: true, tier: "creator", period: paidPeriod() });
  await setCommunity(OWNER, true);
  const club: Store = (await storeForEmail(OWNER))!;
  const ID = club.community!.id;
  await saveConfig(ID, freshConfig(club.name));
  const original = redis.pipeline.bind(redis);

  const email = "pending-device@example.test";
  const who = memberKey(email);
  await touchMember(ID, email, null, club);
  let reached!: () => void;
  const deviceWriteReached = new Promise<void>((r) => (reached = r));
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let paused = false;
  redis.pipeline = (async (commands: Command[]) => {
    const devices = (c: Command) => (c[0] === "HSET" && String(c[1]).startsWith("nl:cm:") && String(c[1]).includes(":ps:"))
      || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:push-device-if-member:") && String(c[3]).includes(":ps:"));
    if (!paused && commands.length === 1 && devices(commands[0])) {
      paused = true; reached(); await hold;
    }
    return original(commands);
  }) as typeof redis.pipeline;
  part("a registration authorised before the erasure completes after it");
  const registering = rememberDevice(ID, who, subscription(), club);
  await deviceWriteReached;
  try {
    await forgetCommunityPerson(ID, who, email, []);
    is("erasure removed the devices", await deviceCount(ID, who), 0);
  } finally { release(); }
  await registering;
  is("the old registration leaves no devices", await deviceCount(ID, who), 0);

  part("a member who is still in registers a device as before, and so does the creator");
  const current = "current-member@example.test";
  await touchMember(ID, current, null, club);
  is("added for a current member", await rememberDevice(ID, memberKey(current), subscription(), club), "added");
  is("kept", await deviceCount(ID, memberKey(current)), 1);
  is("added for the creator, who has no member record", await rememberDevice(ID, CREATOR, subscription(), club), "added");
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
