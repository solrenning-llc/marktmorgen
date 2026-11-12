/**
 * Sequences read Redis replies only in their exact shape (CX-123 rules 24/30; sweep A2 findings 6 and 7,
 * docs/reviews/c5-sweep-a2.md on claude5/sweep-a2). Synthetic store, the in-memory Redis double and a stand-in
 * email provider.
 *
 * 1. lib/flows.ts startFlows: the SET NX that makes "each person goes through a sequence once" is claimed only on
 *    exactly "OK", not claimed on exactly nil, and unknown on anything else: an unknown reply never restarts a run
 *    (its record and history kept) and never sends the first email again.
 * 2. lib/flows.ts sendDueSteps: an unknown read of the store's workflows leaves the due batch queued for a later run,
 *    never dropped; once Redis answers again, the step is sent.
 * 3. lib/flow-runs.ts siblings: readRun and runPeople throw on an unknown slot rather than answering "no such run" or
 *    "this run holds no address".
 * 4. sendDueSteps: a workflows reply that is a string but not a JSON list, or a list with any element that is not a
 *    workflow, is unknown too, never "no workflows" or "this workflow is gone".
 * 5. readRun and listRuns: an HGETALL list of odd length (or, in listRuns, of another shape) is unknown, never
 *    "no such run" or a run left out of the list.
 */
import { enroll, readFlows, saveFlow, sendDueSteps } from "@/lib/flows";
import { listRuns, personOf, readRun, runPeople } from "@/lib/flow-runs";
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
const rejects = async (work: () => Promise<unknown>) => {
  try {
    await work();
    return false;
  } catch {
    return true;
  }
};

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_flows_exact_only";
  process.env.RESEND_API_KEY = "re_test_flows_exact_only";
  const OWNER = "flowsexact@example.com";
  await claimHandle(OWNER, "flowsexact", "Flows Exact", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestFlowsEx01", true);
  await setSubscription(OWNER, { customerId: "cus_FlowsExact", subscriptionId: "sub_FlowsExact", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Flows Exact", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const list = store.listId!;
  const saved = await saveFlow(store, { name: "Welcome", trigger: "joined", active: true, steps: [{ delayHours: 0, subject: "Day one", body: "Hello." }, { delayHours: 24, subject: "Day two", body: "Again." }] }, { activate: true });
  const flowId = saved.ok ? saved.flows[0].id : "";
  is("setup: workflow saved", Boolean(flowId), true);
  for (const email of ["ana@example.com", "ben@example.com", "cy@example.com"]) await upsertContact(list, email, { agreed: true, explicit: true, source: "free" }, ROOM);

  part("1. Healthy control: a new person starts the sequence once; joining again does not restart it");
  await enroll(store, "ana@example.com", { joined: true });
  await run();
  await enroll(store, "ana@example.com", { joined: true });
  await run();
  is("Ana got 'Day one' once", got("Day one", "ana@example.com"), 1);
  const anaRun = (await listRuns(flowId, 10)).find((r) => r.email === "ana@example.com");
  is("her run is at step 1", anaRun?.step, 1);

  part("1. The once-only SET NX answers in an unknown shape on a second join: nothing restarts, nothing is sent");
  await enroll(store, "cy@example.com", { joined: true });
  await run();
  const before = (await listRuns(flowId, 10)).find((r) => r.email === "cy@example.com");
  is("before: Cy's run is at step 1 and got 'Day one' once", [before?.step, got("Day one", "cy@example.com")], [1, 1]);
  // Cy joins again three days later (another sign-up form, say): the send's own two-day once-only marks are gone.
  redis.advance(3 * 86_400_000);
  for (const shape of [[], ["garbled"], [1]] as unknown[][]) {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith("nl:mail:enr:") && commands[0].includes("NX")) {
        await original(commands); // runs: the key is already there, Redis would say nil
        return shape; // the reply is lost or of another shape
      }
      return original(commands);
    }) as typeof redis.pipeline;
    await enroll(store, "cy@example.com", { joined: true });
    redis.pipeline = original;
    const after = (await listRuns(flowId, 10)).find((r) => r.email === "cy@example.com");
    is(`reply ${JSON.stringify(shape)}: Cy's run is not restarted (same step and start)`, [after?.step, after?.startedAt], [before?.step, before?.startedAt]);
  }
  await run();
  is("'Day one' still went to Cy only once", got("Day one", "cy@example.com"), 1);

  part("2. The workflows GET answers in an unknown shape while Ben's first step is due: the batch stays queued");
  await enroll(store, "ben@example.com", { joined: true });
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:mail:flows:${list}`) return [];
    return original(commands);
  }) as typeof redis.pipeline;
  const counts = await run();
  redis.pipeline = original;
  is("readFlows answers the saved workflow once the reply is healthy", (await readFlows(list)).length, 1);
  is("Ben's batch is not counted as dropped", counts.dropped, 0);
  const [queued] = await original([["ZRANGEBYSCORE", "nl:mail:flowq", "-inf", "+inf"]]);
  const [leased] = await original([["ZRANGEBYSCORE", "nl:mail:flowq:lease", "-inf", "+inf"]]);
  is("Ben's step is still queued or reserved", [...(queued as string[]), ...(leased as string[])].filter((m) => m.endsWith("|ben@example.com")).length, 1);
  is("nothing was sent to Ben while the read was unknown", got("Day one", "ben@example.com"), 0);
  // The batch was put back for a later run; that run comes (the clock moves past the wait).
  const realNow = Date.now;
  Date.now = () => realNow() + 700_000;
  try {
    await run();
  } finally {
    Date.now = realNow;
  }
  is("Healthy control: with Redis healthy again, the due batch runs and Ben gets 'Day one' once", got("Day one", "ben@example.com"), 1);
  const benRun = (await listRuns(flowId, 10)).find((r) => r.email === "ben@example.com");
  is("and his run moves on to step 1", [benRun?.status, benRun?.step], ["running", 1]);

  part("3. lib/flow-runs.ts siblings: an unknown slot is never 'no such run' or 'no address'");
  is("control: readRun reads Ana's run", (await readRun(flowId, personOf("ana@example.com")))?.run.step, 1);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const reply = await original(commands);
    if (commands.length === 2 && commands[0][0] === "HGETALL" && String(commands[0][1]).startsWith("nl:wf:run:")) return ["garbled", reply[1]];
    return reply;
  }) as typeof redis.pipeline;
  const readRunThrows = await rejects(() => readRun(flowId, personOf("ana@example.com")));
  redis.pipeline = original;
  is("readRun throws on an unknown HGETALL slot", readRunThrows, true);
  const people = await runPeople(flowId);
  is("control: runPeople names every address", people.map((p) => p.email).sort(), ["ana@example.com", "ben@example.com", "cy@example.com"]);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const reply = await original(commands);
    if (commands.length > 0 && commands[0][0] === "HGET" && commands[0][2] === "email") return reply.map((r, i) => (i === 0 ? 7 : r));
    return reply;
  }) as typeof redis.pipeline;
  const runPeopleThrows = await rejects(() => runPeople(flowId));
  redis.pipeline = original;
  is("runPeople throws on an unknown HGET slot", runPeopleThrows, true);

  part("4. The workflows GET answers a string that is not a JSON list of workflows ('{', '{}', '\"x\"', '[1]', '[{}]') while Dee's first step is due: the batch stays queued");
  await upsertContact(list, "dee@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "dee@example.com", { joined: true });
  const runAt = async (offsetMs: number) => {
    const clock = Date.now;
    Date.now = () => clock() + offsetMs;
    try {
      return await run();
    } finally {
      Date.now = clock;
    }
  };
  // Each attempt comes after the previous put-back's ten-minute wait.
  let offset = 0;
  // Then a JSON list whose elements are not workflows (Claude 4's focal return on #2861): one off-shape element makes
  // the whole reply unknown, even beside a well-formed workflow, never "this workflow is gone".
  for (const garbled of ["{", "{}", '"x"', "[1]", "[{}]", '[{"id":5}]', "[null]", '[{"id":"other","steps":[],"active":true},1]']) {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:mail:flows:${list}`) return [garbled];
      return original(commands);
    }) as typeof redis.pipeline;
    const garbledCounts = await runAt(offset);
    redis.pipeline = original;
    offset += 700_000;
    is(`GET ${JSON.stringify(garbled)}: Dee's batch is not counted as dropped`, garbledCounts.dropped, 0);
    const [q] = await original([["ZRANGEBYSCORE", "nl:mail:flowq", "-inf", "+inf"]]);
    const [l] = await original([["ZRANGEBYSCORE", "nl:mail:flowq:lease", "-inf", "+inf"]]);
    is(`GET ${JSON.stringify(garbled)}: Dee's step is still queued or reserved`, [...(q as string[]), ...(l as string[])].filter((m) => m.endsWith("|dee@example.com")).length, 1);
    is(`GET ${JSON.stringify(garbled)}: nothing was sent to Dee`, got("Day one", "dee@example.com"), 0);
  }
  await runAt(offset);
  is("Healthy control: with the workflows readable again, Dee gets 'Day one' once", got("Day one", "dee@example.com"), 1);

  part("5. readRun and listRuns: an HGETALL slot of strings with an odd length is unknown, never 'no such run'");
  for (const odd of [["status"], ["status", "running", "email"]]) {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const reply = await original(commands);
      if (commands.length === 2 && commands[0][0] === "HGETALL" && String(commands[0][1]).startsWith("nl:wf:run:")) return [odd, reply[1]];
      return reply;
    }) as typeof redis.pipeline;
    const oddThrows = await rejects(() => readRun(flowId, personOf("ana@example.com")));
    redis.pipeline = original;
    is(`readRun throws on HGETALL ${JSON.stringify(odd)}`, oddThrows, true);
  }
  is("control: readRun still reads Ana's run", (await readRun(flowId, personOf("ana@example.com")))?.run.step, 1);
  // Rule 30 sibling: listRuns reads the same HGETALL rows; one off-shape row is unknown, never a run that is not there.
  is("control: listRuns lists four runs", (await listRuns(flowId, 10)).length, 4);
  for (const bad of ["garbled", ["status"]] as unknown[]) {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const reply = await original(commands);
      if (commands.length > 1 && commands.every((c) => c[0] === "HGETALL")) return reply.map((r, i) => (i === 0 ? bad : r));
      return reply;
    }) as typeof redis.pipeline;
    const listThrows = await rejects(() => listRuns(flowId, 10));
    redis.pipeline = original;
    is(`listRuns throws on an HGETALL row ${JSON.stringify(bad)}`, listThrows, true);
  }
  done();
}
main();
