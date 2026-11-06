/**
 * Sweep A2 proof (CX-123 rules 24/30), synthetic stores, the in-memory Redis double and a stand-in email provider.
 *
 * 1. lib/flows.ts startFlows, lines 549-550: `claimed = addresses.filter((_, i) => claims[i] !== null)`. The SET NX
 *    that makes "each person goes through a sequence once" is read as claimed on ANY reply but nil: a missing slot or
 *    another shape (unknown) restarts the sequence for somebody already in it (openRuns DELs their run record and
 *    history and queues step 0 again).
 * 2. lib/flows.ts readFlows, lines 220-229 (read non-strictly at line 1136 by sendDueSteps): an unknown GET of the
 *    store's workflows is []; sendGroup then finds no flow, counts the batch as "dropped", writes no history, and the
 *    lease entries are removed (line 1097): everybody due in that batch silently leaves the sequence for good.
 */
import { enroll, readFlows, saveFlow, sendDueSteps } from "@/lib/flows";
import { listRuns } from "@/lib/flow-runs";
import { upsertContact } from "@/lib/contacts";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const mail = installSesMailFixture({ fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })) });
const got = (subject: string, to: string) => mail.sent.filter((m) => m.subject === subject && JSON.stringify(m).includes(to)).length;

const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
const original = redis.pipeline.bind(redis);

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_sweep_a2_only";
  process.env.RESEND_API_KEY = "re_test_sweep_a2_only";
  const OWNER = "sweepa2flows@example.com";
  await claimHandle(OWNER, "sweepflows", "Sweep Flows", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSweepA2001", true);
  await setSubscription(OWNER, { customerId: "cus_SweepA2", subscriptionId: "sub_SweepA2", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Sweep Flows", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const list = store.listId!;
  const saved = await saveFlow(store, { name: "Welcome", trigger: "joined", active: true, steps: [{ delayHours: 0, subject: "Day one", body: "Hello." }, { delayHours: 24, subject: "Day two", body: "Again." }] }, { activate: true });
  const flowId = saved.ok ? saved.flows[0].id : "";
  is("setup: workflow saved", Boolean(flowId), true);
  for (const email of ["ana@example.com", "ben@example.com", "cy@example.com"]) await upsertContact(list, email, { agreed: true, explicit: true, source: "free" }, ROOM);

  part("1. Healthy control: joining twice starts the sequence once; 'Day one' goes once");
  await enroll(store, "ana@example.com", { joined: true });
  await run();
  await enroll(store, "ana@example.com", { joined: true });
  await run();
  is("Ana got 'Day one' once", got("Day one", "ana@example.com"), 1);
  const anaRun = (await listRuns(flowId, 10)).find((r) => r.email === "ana@example.com");
  is("her run is at step 1", anaRun?.step, 1);

  part("1. DEFECT: the once-only SET NX answers in an unknown shape on the second join");
  await enroll(store, "cy@example.com", { joined: true });
  await run();
  const before = (await listRuns(flowId, 10)).find((r) => r.email === "cy@example.com");
  // Cy joins again three days later (another sign-up form, say): the send's own two-day once-only marks are gone.
  redis.advance(3 * 86_400_000);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith("nl:mail:enr:") && commands[0].includes("NX")) {
      await original(commands); // runs: the key is already there, Redis would say nil
      return []; // the reply is lost
    }
    return original(commands);
  }) as typeof redis.pipeline;
  await enroll(store, "cy@example.com", { joined: true });
  redis.pipeline = original;
  const restarted = (await listRuns(flowId, 10)).find((r) => r.email === "cy@example.com");
  is("before: Cy's run was at step 1", before?.step, 1);
  is("DEFECT: Cy's run was restarted at step 0 (record and history replaced)", [restarted?.step, (restarted?.startedAt ?? 0) >= (before?.startedAt ?? 0)], [0, true]);
  await run();
  is("DEFECT: 'Day one' went to Cy a second time", got("Day one", "cy@example.com"), 2);

  part("2. DEFECT: the workflows GET answers in an unknown shape while Ben's first step is due");
  await enroll(store, "ben@example.com", { joined: true });
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:mail:flows:${list}`) return [];
    return original(commands);
  }) as typeof redis.pipeline;
  const counts = await run();
  redis.pipeline = original;
  is("readFlows itself answers [] on that reply (the workflows are still saved)", (await readFlows(list)).length, 1);
  is("DEFECT: Ben's batch counted as dropped", counts.dropped, 1);
  const [queued] = await original([["ZRANGEBYSCORE", "nl:mail:flowq", "-inf", "+inf"]]);
  const [leased] = await original([["ZRANGEBYSCORE", "nl:mail:flowq:lease", "-inf", "+inf"]]);
  is("DEFECT: nothing of Ben's is left in the queue or the lease", [...(queued as string[]), ...(leased as string[])].filter((m) => m.endsWith("|ben@example.com")).length, 0);
  for (let i = 0; i < 3; i += 1) await run();
  is("DEFECT: with Redis healthy again, Ben never gets 'Day one'", got("Day one", "ben@example.com"), 0);
  const benRun = (await listRuns(flowId, 10)).find((r) => r.email === "ben@example.com");
  is("DEFECT: and his run still says 'running' at step 0, no ending written", [benRun?.status, benRun?.step], ["running", 0]);
  done();
}
main();
