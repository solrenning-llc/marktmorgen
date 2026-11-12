/**
 * The workflow sender (lib/flows.ts, sendDueSteps) moves a due step between
 * the queue (nl:mail:flowq) and its lease (nl:mail:flowq:lease): taken from
 * the queue into the lease before it is done, and from the lease back into
 * the queue when an earlier run never finished it or this run puts it back.
 * Each move is one step: a write that fails half-way (the 5 s timeout, the
 * cutoff, a network error) leaves the step in one of the two sets, never in
 * neither, so a later run always finds it and the person is never stuck at
 * that step. Synthetic store and email stand-in; one failure injected per
 * case, before the write runs or after it ran with its reply lost.
 */
import { personOf, readRun } from "@/lib/flow-runs";
import { enroll, saveFlow, sendDueSteps, setFlowActive } from "@/lib/flows";
import { upsertContact } from "@/lib/contacts";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

type Command = (string | number)[];
const QUEUE = "nl:mail:flowq";
const LEASE = "nl:mail:flowq:lease";
const realNow = Date.now;
let shift = 0;
let jump = 0;
Date.now = () => realNow() + shift + jump;
const real = redis.pipeline.bind(redis);

/** A write that puts a step into `to` (taken from the other set): a plain ZADD, or one script with the two keys. */
const movesInto = (batch: Command[], to: string) => {
  const from = to === LEASE ? QUEUE : LEASE;
  return batch.some((c) => (c[0] === "ZADD" && c[1] === to) || (c[0] === "EVAL" && c[2] === 2 && c[3] === from && c[4] === to && c.length === 7));
};
type Fault = { to: string; ran: boolean; after?: () => void };
let fault: Fault | null = null;
let onLeased: (() => void) | null = null;
redis.pipeline = (async (batch: Command[]) => {
  if (fault && movesInto(batch, fault.to)) {
    const f = fault;
    fault = null;
    if (f.ran) await real(batch);
    f.after?.();
    throw new Error("synthetic: the Redis call timed out");
  }
  const values = await real(batch);
  if (onLeased && movesInto(batch, LEASE)) {
    const then = onLeased;
    onLeased = null;
    then();
  }
  return values;
}) as typeof redis.pipeline;

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
const runCaught = async () => {
  try {
    await run();
    return "finished";
  } catch {
    return "threw";
  }
};

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_workflows_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_workflows_only_a_stand_in";

  const OWNER = "lease-atomic@example.test";
  await claimHandle(OWNER, "leaseatomic", "Lease Atomic", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLeaseAt", true);
  await setSubscription(OWNER, { customerId: "cus_LeaseAt001", subscriptionId: "sub_LeaseAt001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Lease Atomic", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  const made = await saveFlow(store, {
    name: "Welcome",
    trigger: "tagged",
    tag: "welcome",
    steps: [
      { id: "d000000000000001", delayHours: 0, subject: "Welcome, step one", body: "Hello." },
      { id: "d000000000000002", delayHours: 24 * 30, subject: "Welcome, step two", body: "Again." },
    ],
  });
  const flowId = made.ok ? made.flows.find((f) => f.name === "Welcome")!.id : "";
  await setFlowActive(store, flowId, true);
  store = (await storeForEmail(OWNER))!;
  const sentTo = (email: string) => mail.sesAttempts.filter((m) => m.subject === "Welcome, step one" && JSON.stringify(m).includes(email)).length;
  const held = async (email: string) => {
    const [q] = await real([["ZRANGEBYSCORE", QUEUE, "-inf", "+inf"]]);
    const [l] = await real([["ZRANGEBYSCORE", LEASE, "-inf", "+inf"]]);
    const mine = (members: unknown) => (members as string[]).filter((m) => m.endsWith(`|${flowId}|0|${email}`)).length;
    return mine(q) + mine(l);
  };
  const join = async (email: string) => {
    await upsertContact(list, email, { agreed: true, explicit: true, source: "free" }, ROOM);
    await enroll(store, email, { joined: false, tag: "welcome" });
  };
  // Each later run comes after the lease's 15 minutes and the put-back's 10.
  const later = async () => {
    shift += 16 * 60_000;
    return run();
  };
  const settled = async (email: string) => {
    for (let i = 0; i < 3 && sentTo(email) === 0; i += 1) await later();
    const after = await readRun(flowId, personOf(email));
    is("on a later run the step goes out exactly once and the run goes on", [sentTo(email), after?.run.status, after?.run.step], [1, "running", 1]);
  };

  part("Control: with healthy writes the step goes out once");
  await join("lease0@example.com");
  await run();
  is("the first step went out once and the run is on to step two", [sentTo("lease0@example.com"), (await readRun(flowId, personOf("lease0@example.com")))?.run.step], [1, 1]);

  let n = 0;
  for (const ran of [false, true]) {
    n += 1;
    const email = `take${n}@example.com`;
    part(`From the queue into the lease: the write fails ${ran ? "after it ran (reply lost)" : "before it ran"}`);
    await join(email);
    fault = { to: LEASE, ran };
    is("the run reports the failure", await runCaught(), "threw");
    is("the step is still in the queue or its lease, exactly once", await held(email), 1);
    is("nothing was sent yet", sentTo(email), 0);
    await settled(email);
  }

  for (const ran of [false, true]) {
    n += 1;
    const email = `orphan${n}@example.com`;
    part(`From an expired lease back into the queue (an earlier run never finished): the write fails ${ran ? "after it ran" : "before it ran"}`);
    await join(email);
    // An earlier run leased the step and stopped there (its reply lost after the write).
    fault = { to: LEASE, ran: true };
    await runCaught();
    is("the step is in its lease", await held(email), 1);
    shift += 16 * 60_000;
    fault = { to: QUEUE, ran };
    is("the run reports the failure", await runCaught(), "threw");
    is("the step is still in the queue or its lease, exactly once", await held(email), 1);
    is("nothing was sent yet", sentTo(email), 0);
    await settled(email);
  }

  for (const ran of [false, true]) {
    n += 1;
    const email = `late${n}@example.com`;
    part(`Out of time after the lease, put back in the queue: the write fails ${ran ? "after it ran" : "before it ran"}`);
    await join(email);
    // The clock passes the job's deadline as soon as the step is leased, so the run puts it back.
    onLeased = () => {
      jump = 60_000;
    };
    fault = { to: QUEUE, ran, after: () => { jump = 0; } };
    is("the run reports the failure", await runCaught(), "threw");
    jump = 0;
    is("the step is still in the queue or its lease, exactly once", await held(email), 1);
    is("nothing was sent yet", sentTo(email), 0);
    await settled(email);
  }

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
