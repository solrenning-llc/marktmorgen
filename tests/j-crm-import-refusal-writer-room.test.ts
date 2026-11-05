/** Actual funded CRM writers; only the unchanged import Lua's exact expired-token response is simulated. */
import { importRoom, readPipelines, savePipelineChange, takeCrmLock, writeDeal, writeImport } from "@/lib/crm";
import type { Deal } from "@/lib/crm-rules";
import { releaseLock } from "@/lib/redis-lock";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { dataKey, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

async function main() {
  redis.clear();
  for (const mode of ["writer-control", "refused-control", "refused-then-funded-writer"] as const) {
    part(mode);
    const handle = "jimport" + ["writer-control", "refused-control", "refused-then-funded-writer"].indexOf(mode);
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
    const deal: Deal = { id: "jimport001", title: "Imported", email: "", cents: 0, stage: pipeline.stages[0].id, note: "", createdAt: 1, updatedAt: 1 };
    const newer = { ...deal, title: "A normal funded writer retains a larger current deal", note: "x".repeat(100), updatedAt: 2 };
    const slot = "dl:" + deal.id;
    const requiredNew = dataBytes([newer.id, JSON.stringify(newer)], 1);
    let crossed = false, writerSaved = false, beforeReply = 0, failure = "";
    const saveNewer = async () => {
      const fresh = await takeCrmLock(statsId);
      try { writerSaved = await writeDeal(statsId, newer, store); }
      finally { await releaseLock(fresh); }
      beforeReply = Number((await plain([["HGET", String(dataKey(store)), slot]]))[0]);
    };
    if (mode === "writer-control") await saveNewer();
    else {
      const held = await takeCrmLock(statsId);
      const raw = String((await plain([["GET", "nl:crm:pipes:" + statsId]]))[0]);
      await needData(store, importRoom(raw, null, [deal]).take);
      try {
        redis.pipeline = async commands => {
          const importing = commands.find(c => c[0] === "EVAL" && String(c[1]).includes("crm-deals-import:v3"));
          if (!importing) return plain(commands);
          crossed = true;
          redis.advance(61_000);
          const currentToken = (await plain([["GET", held.key]]))[0];
          if (currentToken === held.token) throw Error("The intended expired-token refusal was not reached");
          // The unchanged Lua reads current pipelines and refuses -4 before any write for this missing token.
          const current = String((await plain([["GET", "nl:crm:pipes:" + statsId]]))[0]);
          const refused = [[-4, current]];
          if (mode === "refused-then-funded-writer") await saveNewer();
          return refused;
        };
        await writeImport(statsId, held, raw, null, [deal], store).catch(error => { failure = String(error.name); });
      } finally { redis.pipeline = plain; await releaseLock(held); }
    }
    const [kept, counted] = await plain([["HGET", "nl:crm:deals:" + statsId, deal.id], ["HGET", String(dataKey(store)), slot]]);
    const required = typeof kept === "string" ? dataBytes([deal.id, kept], 1) : 0;
    console.log("J import refusal funded writer", JSON.stringify({ mode, crossed, writerSaved, failure, beforeReply, required, counted }));
    is("the intended normal writer or expired import ran", [crossed, writerSaved, failure], [mode !== "writer-control", mode !== "refused-control", mode === "writer-control" ? "" : "CrmLockLost"]);
    is("the replacement was fully funded before the old answer returned", beforeReply, mode === "refused-control" ? 0 : requiredNew);
    is("the actual retained deal stays fully funded after the old import settles", Number(counted ?? 0) >= required, true);
  }
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
