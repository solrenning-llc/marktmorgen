/** Independent concurrency evidence for #1961; real card/data code and synthetic Redis only. */
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { saveCreatorCard, dropCreatorCard } from "@/lib/creator-card";
import { dataKey } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is } from "./check";

const long = { on: true, name: "Synthetic business", note: "x".repeat(300) };
const short = { on: true, name: "Synthetic business", note: "x" };
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function main() {
  redis.clear();
  const owner = "card-race@example.test";
  await claimHandle(owner, "card-race", "Synthetic business", "");
  await ensureStatsId(owner); await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_card", subscriptionId: "sub_card", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const key = `nl:vcard:${store.statsId}`;
  const original = redis.pipeline;

  const check = async (label: string) => {
    const [raw, held] = await original([["GET", key], ["HGET", dataKey(store)!, "card"]]);
    const actual = typeof raw === "string" ? dataBytes([raw], 1) : 0;
    console.log(`${label}: stored=${actual}, held=${Number(held)}`);
    is(`${label}: the kept card is covered by its data slot`, Number(held) >= actual, true);
  };

  let entered = latch(); let resume = latch(); let stop = true;
  try {
    redis.pipeline = async (commands) => {
      if (stop && commands.some((c) => (c[0] === "SET" && c[1] === key) || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:card-save:v1")))) {
        stop = false; entered.release(); await resume.promise;
      }
      return original(commands);
    };
    const first = saveCreatorCard(store.statsId!, long, store);
    await entered.promise;
    const second = await saveCreatorCard(store.statsId!, short, store);
    resume.release(); const a = await first;
    is("the first save really reached the held boundary", stop, false);
    is("both genuine saves completed", [a.ok, second.ok], [true, true]);
    await check("long save after a short save");
  } finally { resume.release(); redis.pipeline = original; }

  await saveCreatorCard(store.statsId!, long, store);
  entered = latch(); resume = latch(); stop = true;
  try {
    redis.pipeline = async (commands) => {
      if (stop && commands.some((c) => c[0] === "EVAL" && ((c[8] === "card" && Number(c[9]) === 0) || String(c[1]).startsWith("-- marktmorgen:card-drop:v1")))) {
        stop = false; entered.release(); await resume.promise;
      }
      return original(commands);
    };
    const removal = dropCreatorCard(store.statsId!, store);
    await entered.promise;
    const saved = await saveCreatorCard(store.statsId!, short, store);
    resume.release(); await removal;
    is("the removal really reached the held boundary", stop, false);
    is("the racing save completed", saved.ok, true);
    await check("a removal releases a later save's slot");
  } finally { resume.release(); redis.pipeline = original; }
  done();
}
void main();
