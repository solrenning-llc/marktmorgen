/** T identified scanLeads statically; C2 tests the real authenticated route. */
import { GET } from "@/app/api/v1/leads/route";
import { makeKey } from "@/lib/api-keys";
import { allowanceUsed } from "@/lib/store-allowance";
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const pipeline = redis.pipeline.bind(redis);
const modes = ["healthy", "empty", "throw", "missing", "null", "short", "flat", "odd"] as const;
const contact = JSON.stringify({ agreed: true, agreedAt: "2026-11-01T12:00:00.000Z", firstAt: "", lastAt: "", titles: [], ids: [], source: "free", unsub: false, unsubAt: "", t: "a".repeat(40), name: "Synthetic contact", tags: [], importedAt: "" });

async function main() {
  let totalCommands = 0;
  for (const mode of modes) {
    redis.clear();
    let commands = 0;
    let leadKey = "";
    redis.pipeline = async (batch: (string | number)[][]) => {
      commands += batch.length;
      totalCommands += batch.length;
      if (commands > 5_000 || totalCommands > 40_000) throw new Error("Synthetic command ceiling exceeded before dispatch");
      if (leadKey && batch[0]?.[0] === "HSCAN" && batch[0]?.[1] === leadKey) {
        if (mode === "throw") throw new Error("Synthetic HSCAN outage");
        if (mode === "missing") return [];
        if (mode === "null") return [null];
        if (mode === "short") return [["0"]];
        if (mode === "flat") return [["0", false]];
        if (mode === "odd") return [["0", ["synthetic@example.test", contact, "orphan"]]];
      }
      return pipeline(batch);
    };
    try {
      const owner = `${mode}@example.test`;
      await claimHandle(owner, `prooflead${mode}`, "Synthetic API store", "");
      await ensureListId(owner);
      await ensureStatsId(owner);
      await setSubscription(owner, { active: true, customerId: "cus_TestApiLead1", subscriptionId: "sub_TestApiLead1", tier: "scale", cycle: "month", period: paidPeriod() });
      const store = await storeForEmail(owner);
      if (!store) throw new Error("Synthetic store was not created");
      const key = await makeKey(store.sid, "Synthetic reader");
      if (!key.ok) throw new Error("Synthetic API key was not made");
      leadKey = `nl:store:leads:${store.listId}`;
      if (mode !== "empty") await redis.pipeline([["HSET", leadKey, "synthetic@example.test", contact]]);
      const before = await allowanceUsed(store, "api");
      const response = await GET(new Request("https://marktmorgen.test/api/v1/leads", { headers: { Authorization: `Bearer ${key.key}` } }));
      const body = await response.json() as { data?: unknown[]; next?: unknown; error?: string };
      const after = await allowanceUsed(store, "api");
      const [kept] = await redis.pipeline([["HLEN", leadKey]]);
      console.log(JSON.stringify({ mode, status: response.status, rows: body.data?.length, next: body.next, error: body.error, kept, charged: after - before, commands }));
      if (mode === "healthy" || mode === "empty") {
        is(`${mode}: the authenticated route preserves confirmed data or confirmed absence`, [response.status, body.data?.length, body.next], [200, mode === "healthy" ? 1 : 0, null]);
      } else {
        is(`${mode}: an unknown scan is unavailable rather than a complete successful list`, [response.status, body.error, Object.hasOwn(body, "data")], [502, "unavailable", false]);
      }
      is(`${mode}: reading the API never removes the stored lead`, kept, mode === "empty" ? 0 : 1);
    } finally { redis.pipeline = pipeline; }
  }
  is("all scenarios remain inside the predeclared command ceiling", totalCommands <= 40_000, true);
  done();
}
void main().catch((error) => { console.error(error); process.exitCode = 2; });
