/**
 * RUN_START_COMMANDS (lib/flow-limits.ts) prices a run's own start in WORST_COMMANDS_PER_RUN, on every plan's
 * workflows line. Since #4301 the first step is queued by one script, FLOW_QUEUED, that also turns the pending claim
 * into the 400-day mark; a script is billed as 1 plus the calls inside it. This counts a real one-person start, from
 * the run's record (openRuns) to its first step queued, with the script's inner calls, and holds the ceiling to it
 * (Claude 7's cost MEDIUM 6890509436 and Claude 5's measurement 6932308660 on #4301). Synthetic: the memory Redis.
 */
import { RUN_START_COMMANDS } from "@/lib/flow-limits";
import { upsertContact } from "@/lib/contacts";
import { enroll, saveFlow, setFlowActive } from "@/lib/flows";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

type Command = (string | number)[];
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "start-cost@example.test";
  await claimHandle(OWNER, "startcost", "Start Cost", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestStartCost", true);
  await setSubscription(OWNER, { customerId: "cus_StartCost01", subscriptionId: "sub_StartCost01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Start Cost", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const made = await saveFlow(store, { name: "Welcome", trigger: "joined", steps: [{ delayHours: 0, subject: "Welcome", body: "Hello." }] });
  const flowId = made.ok ? made.flows.find((f) => f.name === "Welcome")!.id : "";
  await setFlowActive(store, flowId, true);
  store = (await storeForEmail(OWNER))!;
  await upsertContact(store.listId!, "one@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);

  part("A one-person start, from its record to its first step queued");
  const original = redis.pipeline;
  const billed: { batch: Command[]; commands: number }[] = [];
  try {
    redis.pipeline = (async (batch: Command[]) => {
      const inner = redis.scriptCalls;
      const replies = await original.call(redis, batch);
      billed.push({ batch, commands: batch.length + (redis.scriptCalls - inner) });
      return replies;
    }) as typeof redis.pipeline;
    await enroll(store, "one@example.com", { joined: true });
  } finally {
    redis.pipeline = original;
  }
  const first = billed.findIndex(({ batch }) => batch.some((c) => c[0] === "DEL" && String(c[1]).startsWith("nl:wf:run:")));
  const last = billed.findIndex(({ batch }) => batch.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:flow-queued:v1\n")));
  is("the run's record and its first step's queueing were both seen, in that order", first >= 0 && last > first, true);
  const start = billed.slice(first, last + 1).reduce((sum, { commands }) => sum + commands, 0);
  // openRuns: DEL, HSET, EXPIRE of the run, RPUSH and EXPIRE of its log, ZADD of the index, then ZREMRANGEBYSCORE and
  // EXPIRE of the index (8); FLOW_QUEUED: the EVAL, then GET, SET, ZADD and HINCRBY inside it (5).
  is("measured: 13 commands", start, 13);
  is(`within RUN_START_COMMANDS (${RUN_START_COMMANDS})`, start <= RUN_START_COMMANDS, true);
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
