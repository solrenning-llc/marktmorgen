/**
 * The in-memory Redis that tests and the local e2e app run on (lib/redis-memory.ts) answers lib/community.ts
 * CAS_MEMBER as Upstash does. Without it, saving a member's name in the e2e app said "Something went wrong on our
 * side" ("MemoryRedis: unsupported EVAL"), so nothing a member writes in a community could be checked end to end
 * (found on 11/11/2026, checking #3329, #3266, #3278 and #3305 in the app). Unit tests emulated the script by hand
 * (tests/community-handle-erasure-orphan.test.ts). Here setProfile runs on the stand-in as it is, with no emulation,
 * so the copy in lib/redis-memory.ts failing to match the script word for word fails this test.
 */
import { freshConfig, memberKey, readMember, saveConfig, setProfile, type Member } from "@/lib/community";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "club@casmember.example";
  const made = await claimHandle(OWNER, "casmemberclub", "Cas Member Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_CasMember1", subscriptionId: "sub_CasMember1", active: true, tier: "creator", period: paidPeriod() });
  await setCommunity(OWNER, true);
  const club: Store = (await storeForEmail(OWNER))!;
  const cid = club.community!.id;
  await saveConfig(cid, freshConfig(club.name));
  const email = "dana@casmember.example";
  const key = memberKey(email);
  const record: Member = { k: key, e: email, n: "", h: "", dir: false, mail: false, at: 1, seen: 1, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] };
  redis.run(["HSET", `nl:cm:${cid}:m`, key, JSON.stringify(record)]);

  part("A member names themselves and asks to be listed, on the stand-in as it is");
  const error = await setProfile(cid, (await readMember(cid, key))!, { name: "Dana", dir: true, mail: false }, club).then(() => "", (e: unknown) => String(e));
  is("the save goes through", error, "");
  const saved = await readMember(cid, key);
  is("the record carries the name, a handle and the listing", [saved?.n, Boolean(saved?.h), saved?.dir], ["Dana", true, true]);
  is("and the directory lists them", redis.run(["ZSCORE", `nl:cm:${cid}:dir`, key]) !== null, true);

  part("Asking not to be listed takes them out of the directory");
  await setProfile(cid, (await readMember(cid, key))!, { name: "Dana", dir: false, mail: false }, club);
  is("the record says so and the directory no longer lists them", [(await readMember(cid, key))?.dir, redis.run(["ZSCORE", `nl:cm:${cid}:dir`, key])], [false, null]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
