/**
 * Rule 24 on the workflow sender (lib/flows.ts, sendDueSteps): before a due
 * step is done, one read gives each person's row on the creator's list
 * (HMGET) and whether they still hold the step's lease entry (ZSCORE). Only
 * a reply in its exact shape decides: a row that is exactly nil is "no longer
 * on your list", a score that is exactly nil is "taken out by another
 * workflow". A reply out of shape (no answer, a word where a list belongs, a
 * number where a row belongs, a list where a score belongs) is unknown: the
 * run is neither ended as "left" nor dropped nor sent to; the batch goes back
 * in the queue and is done on a later run. Synthetic store and email
 * stand-in; one reply injected per case.
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
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
const real = redis.pipeline.bind(redis);
let inject: ((values: unknown[]) => unknown[]) | null = null;
redis.pipeline = (async (batch: Command[]) => {
  const values = await real(batch);
  if (inject && batch[0]?.[0] === "HMGET" && batch.slice(1).length > 0 && batch.slice(1).every((c) => c[0] === "ZSCORE")) {
    const change = inject;
    inject = null;
    return change(values);
  }
  return values;
}) as typeof redis.pipeline;

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_workflows_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_workflows_only_a_stand_in";

  const OWNER = "rows-unknown@example.test";
  await claimHandle(OWNER, "rowsunknown", "Rows Unknown", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRowsUnk", true);
  await setSubscription(OWNER, { customerId: "cus_RowsUnk001", subscriptionId: "sub_RowsUnk001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Rows Unknown", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  const made = await saveFlow(store, {
    name: "Welcome",
    trigger: "tagged",
    tag: "welcome",
    steps: [
      { id: "c000000000000001", delayHours: 0, subject: "Welcome, step one", body: "Hello." },
      { id: "c000000000000002", delayHours: 24 * 30, subject: "Welcome, step two", body: "Again." },
    ],
  });
  const flowId = made.ok ? made.flows.find((f) => f.name === "Welcome")!.id : "";
  await setFlowActive(store, flowId, true);
  store = (await storeForEmail(OWNER))!;
  const sentTo = (email: string) => mail.sesAttempts.filter((m) => m.subject === "Welcome, step one" && JSON.stringify(m).includes(email)).length;
  const queued = async (email: string) => {
    const [flat] = await real([["ZRANGEBYSCORE", "nl:mail:flowq", 0, "+inf"]]);
    return (flat as string[]).some((m) => m.endsWith(`|${flowId}|0|${email}`));
  };

  part("Control: an exact reply sends the step");
  await upsertContact(list, "row0@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "row0@example.com", { joined: false, tag: "welcome" });
  await run();
  is("the first step went out once and the run is on to step two", [sentTo("row0@example.com"), (await readRun(flowId, personOf("row0@example.com")))?.run.step], [1, 1]);

  const cases: [string, (values: unknown[]) => unknown[]][] = [
    ["the rows answered with a word, not a list", ([, ...scores]) => ["OK", ...scores]],
    ["no answer for the rows", ([, ...scores]) => [undefined, ...scores]],
    ["a number where the person's row belongs", ([rows, ...scores]) => [(rows as unknown[]).map(() => 7), ...scores]],
    ["a shorter list of rows", ([, ...scores]) => [[], ...scores]],
    ["no answer for the lease entry's score", ([rows]) => [rows]],
    ["a list where the lease entry's score belongs", ([rows, ...scores]) => [rows, ...scores.map(() => ["1"])]],
    ["a hole in the rows array", ([rows, ...scores]) => [new Array((rows as unknown[]).length), ...scores]],
    ["a hole in the outer score slot", (values) => { const cut = values.slice(); delete cut[1]; return cut; }],
  ];
  let n = 0;
  for (const [label, reply] of cases) {
    n += 1;
    const email = `row${n}@example.com`;
    part(`The due step's read: ${label}`);
    await upsertContact(list, email, { agreed: true, explicit: true, source: "free" }, ROOM);
    await enroll(store, email, { joined: false, tag: "welcome" });
    inject = reply;
    await run();
    const held = await readRun(flowId, personOf(email));
    is("the run is not ended, nothing is sent, and the step is back in the queue", [held?.run.status, held?.run.step, sentTo(email), await queued(email)], ["running", 0, 0, true]);
    shift += 11 * 60_000;
    await run();
    const after = await readRun(flowId, personOf(email));
    is("on the next run, read exactly, the step goes out once and the run goes on", [sentTo(email), after?.run.status, after?.run.step], [1, "running", 1]);
  }

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
