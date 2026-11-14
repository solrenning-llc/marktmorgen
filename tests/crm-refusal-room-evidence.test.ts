/**
 * Codex J on #2048, kept as a permanent test: a pipelines write refused late (its lock gone, its answer delayed)
 * gives back only what it took, by difference, so a newer write's room is never cut to an old length.
 */
/** Independent J return proof for #2048/ff42ab95. Synthetic stores and the
 * repository MemoryRedis only; no HTTP, provider, native Redis or author ref.
 * The real v3 pipelines script is emulated by lib/redis-memory.ts. A response
 * delay permits a newer, normally locked writer to complete before the old
 * refused writer applies its separate data-room adjustment. */
import { readPipelines, savePipelineChange } from "@/lib/crm";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { dataKey } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.STRIPE_SECRET_KEY = "sk_test_j_crm_room_only_a_stand_in";
  for (const mode of ["normal", "expired", "expired-then-new-writer"] as const) {
    part(mode);
    const handle = "jroom" + ["normal", "expired", "expired-then-new-writer"].indexOf(mode);
    const owner = handle + "@example.com";
    await claimHandle(owner, handle, "Synthetic CRM", "");
    await ensureStatsId(owner);
    await setStripeAccount(owner, "acct_1TestJCrmRoom", true);
    await setSubscription(owner, { customerId: "cus_JCrmRoom", subscriptionId: "sub_JCrmRoom", active: true, tier: "creator", period: paidPeriod() });
    const store = (await storeForEmail(owner))!;
    const statsId = store.statsId!;
    const [pipeline] = await readPipelines(statsId);
    await savePipelineChange(statsId, { pipeline }, {}, 2, store);
    const plain = redis.pipeline.bind(redis);
    let crossed = false;
    let newerSaved = false;
    let failure = "";
    try {
      redis.pipeline = async commands => {
        if (mode !== "normal" && !crossed && commands.some(c => c[0] === "EVAL" && String(c[1]).includes("crm-pipelines-save:v3"))) {
          crossed = true;
          redis.advance(61_000);
          const refused = await plain(commands);
          if (mode === "expired-then-new-writer") {
            const [current] = await readPipelines(statsId);
            const result = await savePipelineChange(statsId, { pipeline: { ...current, name: "A newer pipeline name that is longer than the earlier record" } }, {}, 2, store);
            newerSaved = result.ok;
          }
          return refused;
        }
        return plain(commands);
      };
      await savePipelineChange(statsId, { pipeline: { ...pipeline, name: "Old" } }, {}, 2, store).catch(error => { failure = String(error.name); });
    } finally { redis.pipeline = plain; }
    const [raw, counted] = await plain([["GET", "nl:crm:pipes:" + statsId], ["HGET", String(dataKey(store)), "crm:pipes"]]);
    const required = typeof raw === "string" ? dataBytes([raw], 1) : -1;
    console.log("J CRM refusal room", JSON.stringify({ mode, crossed, newerSaved, failure, required, counted, raw }));
    is("the intended writer and refusal were exercised", [crossed, newerSaved, failure], [mode !== "normal", mode === "expired-then-new-writer", mode === "normal" ? "" : "CrmLockLost"]);
    is("the kept pipeline record remains fully counted after any old refusal", Number(counted) >= required, true);
  }
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
