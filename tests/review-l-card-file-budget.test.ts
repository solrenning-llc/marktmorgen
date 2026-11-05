/** Independent route review: actual route, proxy, store and traffic; synthetic Redis only. */
import { NextRequest } from "next/server";
import { GET } from "@/app/[handle]/contact/vcard/route";
import { proxy } from "@/proxy";
import { saveCreatorCard } from "@/lib/creator-card";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, storeFolder, storeRef } from "@/lib/store";
import { allowanceWindow } from "@/lib/allowance-window";
import { isResting, trafficForAdmission } from "@/lib/traffic";
import { publicVisitLimit, visitLimitFor } from "@/lib/traffic-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is } from "./check";

async function main() {
  redis.clear();
  globalThis.fetch = (async () => { throw new Error("No outside service in this review"); }) as typeof fetch;
  const owner = "card-budget@example.test";
  await claimHandle(owner, "card-budget", "Synthetic contact store", "");
  await ensureStatsId(owner); await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_card", subscriptionId: "sub_card", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  await saveCreatorCard(store.statsId!, { on: true, name: "Synthetic contact", email: "contact@example.test" }, store);
  const folder = await storeFolder(storeRef(store));
  const window = allowanceWindow(store)!;
  const ceiling = publicVisitLimit(visitLimitFor(store, Date.now() / 1000));
  const countKey = `nl:traffic:n:${folder}:${window.id}`;
  await redis.pipeline([["SET", countKey, String(ceiling)]]);
  is("the real traffic reader confirms the public ceiling is reached", (await trafficForAdmission(folder, window.id))?.visits, ceiling);
  is("the actual public admission refuses the exhausted store", await isResting(store), true);
  const original = redis.pipeline;
  const commands: (string | number)[][] = [];
  redis.pipeline = async (batch) => { commands.push(...batch); return original(batch); };
  const responses: number[] = [];
  try {
    for (let i = 0; i < 32; i++) {
      const request = new NextRequest("https://marktmorgen.com/@card-budget/contact/vcard");
      await proxy(request);
      const response = await GET(request, { params: Promise.resolve({ handle: "@card-budget" }) });
      responses.push(response.status);
      await response.text();
    }
  } finally { redis.pipeline = original; }
  const cardReads = commands.filter(c => c[0] === "GET" && c[1] === `nl:vcard:${store.statsId}`).length;
  const mutations = commands.filter(c => !["GET", "MGET", "HGET", "HMGET"].includes(String(c[0])));
  console.log(JSON.stringify({ publicCeiling: ceiling, requests: responses.length, success: responses.filter(x => x === 200).length, redisCommands: commands.length, cardReads, mutations: mutations.length }));
  is("an exhausted public store does not serve another card file", responses.some(x => x === 200), false);
  is("public denial happens before reading the card", cardReads, 0);
  done();
}
void main();
