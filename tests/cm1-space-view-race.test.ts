/**
 * Synthetic only (Codex X5's review of #3007, MEDIUM): changing how a space is shown must not write back a stale
 * copy of the whole community setup. An edit confirmed between the route's read and its write (another space renamed
 * in another tab) has to survive, with the view change applied over it.
 *
 * Checks marked [CORRETO] say what should happen; a FAIL there is the defect.
 */
import { NextRequest } from "next/server";
import { POST as spaceView } from "@/app/api/store/community/space-view/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureListId, ensureStatsId, setCommunity, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { type CommunityConfig, freshConfig, newItemId, readConfig, saveConfig } from "@/lib/community";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "cm1-race-owner@example.com";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "raceclub", "Race Club", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRaceCm0001", true);
  await setSubscription(OWNER, { customerId: "cus_RaceCm00001", subscriptionId: "sub_RaceCm00001", active: true, period: paidPeriod() });
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  const a = newItemId(), b = newItemId();
  const config: CommunityConfig = {
    ...freshConfig(store.name),
    spaces: [
      { id: a, name: "Room A", about: "", creatorOnly: false, only: [], level: 0 },
      { id: b, name: "Room B", about: "", creatorOnly: false, only: [], level: 0 },
    ] as CommunityConfig["spaces"],
  };
  await saveConfig(id, config);

  part("Another tab's edit confirmed between the route's read and its write (Codex X5, #3007)");
  const original = redis.pipeline;
  let raced = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await original.call(redis, commands);
    if (!raced && commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).includes(id)) {
      raced = true;
      const now = (await readConfig(id))!;
      await saveConfig(id, { ...now, spaces: now.spaces.map((s) => (s.id === b ? { ...s, name: "Room B renamed" } : s)) });
    }
    return replies;
  }) as typeof redis.pipeline;
  let status = 0;
  try {
    const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
    const response = await spaceView(new NextRequest("https://marktmorgen.com/api/store/community/space-view", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie }, body: JSON.stringify({ id: a, view: "locked" }) }));
    status = response.status;
  } finally {
    redis.pipeline = original;
  }
  is("the race happened", raced, true);
  const after = (await readConfig(id))!;
  is("[CORRETO] the other tab's edit survives", after.spaces.find((s) => s.id === b)?.name, "Room B renamed");
  is("[CORRETO] and the view change is applied over it", [status, after.spaces.find((s) => s.id === a)?.shown], [200, true]);
  done();
}

void main();
