/**
 * Rule 24 (CX-123) on the workflow step that takes a person out of another sequence (635 [GL3], lib/flows.ts,
 * actOnPeople "stop"). The step removes their entries from the queue and the lease with two ZREMs and read each reply
 * with `Number(reply) || 0`: a reply missing, cut short or of another shape became 0 and 0, and the step was recorded
 * as done with "They were not waiting in …" although nothing was removed, so the person stayed in the sequence and was
 * sent its next emails. Reported by Claude 4 (nuvem R), 11 November 2026, on #2287 (lib/flows.ts:717 on main).
 *
 * Expected: only whole counts read back for every command prove the removal; anything else is not known, so the step
 * is deferred and tried again, never confirmed. Controls: the exact replies still take the person out, and someone
 * not in the sequence is still told so. In-memory Redis double, a stand-in email provider and synthetic stores only.
 */
import { enroll, saveFlow, sendDueSteps } from "@/lib/flows";
import { listRuns } from "@/lib/flow-runs";
import { upsertContact } from "@/lib/contacts";
import { redisPipeline } from "@/lib/redis";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { subject: string } | { subject: string }[];
    for (const m of [body].flat()) sent.push(m.subject);
    return json(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${sent.length}_${i}` })) } : { id: `e${sent.length}` });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);

const pipeline = redis.pipeline.bind(redis);
/** The stop's own removal (the two ZREMs of queuedOf) for this flow and this person: answers `shape` and removes nothing. */
function removalAnswers(flowId: string, email: string, shape: unknown[]): void {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const removal = commands.length >= 2 && commands[0][0] === "ZREM" && commands[0][1] === "nl:mail:flowq" && commands[1][0] === "ZREM" && commands[1][1] === "nl:mail:flowq:lease";
    if (removal && commands[0].slice(2).some((m) => String(m).includes(`|${flowId}|`) && String(m).endsWith(`|${email}`))) return shape;
    return pipeline(commands);
  }) as typeof redis.pipeline;
}
const restore = () => {
  redis.pipeline = pipeline;
};

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_stop_exact_stand_in";
  process.env.RESEND_API_KEY = "re_test_stop_exact_stand_in";
  const OWNER = "stopexact@example.com";
  await claimHandle(OWNER, "stopexact", "Stop Exact Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestStopExact01", true);
  await setSubscription(OWNER, { customerId: "cus_StopExact01", subscriptionId: "sub_StopExact01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Stop Exact Studio", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const list = store.listId!;

  const nurture = await saveFlow(store, { name: "Nurture", trigger: "joined", active: true, steps: [{ delayHours: 24, subject: "Day one", body: "Hello." }, { delayHours: 24, subject: "Day two", body: "Again." }] }, { activate: true });
  const nurtureId = nurture.ok ? nurture.flows.find((f) => f.name === "Nurture")!.id : "";
  const bought = await saveFlow(store, { name: "Bought", trigger: "tagged", tag: "bought", active: true, steps: [{ delayHours: 0, action: { do: "stop", flowId: nurtureId } }] }, { activate: true });
  const boughtId = bought.ok ? bought.flows.find((f) => f.name === "Bought")!.id : "";
  is("both sequences saved", [nurtureId !== "", boughtId !== ""], [true, true]);

  const waitingIn = async (email: string) => {
    const [members] = await redisPipeline([["ZRANGEBYSCORE", "nl:mail:flowq", "-inf", "+inf"]]);
    return (Array.isArray(members) ? members.map(String) : []).filter((m) => m.includes(`|${nurtureId}|`) && m.endsWith(`|${email}`)).length;
  };
  const statusIn = async (flowId: string, email: string) => (await listRuns(flowId, 50)).filter((r) => r.email === email).map((r) => r.status);

  part("Control: the exact replies take the person out");
  {
    const email = "ctl@example.com";
    await upsertContact(list, email, { agreed: true, explicit: true, source: "free" }, ROOM);
    await enroll(store, email, { joined: true });
    is("waits in the nurture sequence", await waitingIn(email), 1);
    await enroll(store, email, { joined: false, tag: "bought" });
    for (let i = 0; i < 4; i += 1) await run();
    is("taken out, and its history says it ended", [await waitingIn(email), await statusIn(nurtureId, email)], [0, ["ended"]]);
  }

  part("The removal's reply is not known: never confirmed as 'not waiting'");
  const shapes: unknown[][] = [[], [1], ["QUEUED", "QUEUED"], [null, null], ["1", "x"], [-1, 0], [0.5, 0]];
  let n = 0;
  for (const shape of shapes) {
    const label = JSON.stringify(shape);
    const email = `p${(n += 1)}@example.com`;
    await upsertContact(list, email, { agreed: true, explicit: true, source: "free" }, ROOM);
    await enroll(store, email, { joined: true });
    removalAnswers(nurtureId, email, shape);
    try {
      await enroll(store, email, { joined: false, tag: "bought" });
      for (let i = 0; i < 4; i += 1) await run();
    } finally {
      restore();
    }
    const stepStatus = await statusIn(boughtId, email);
    is(`${label}: the stop step is not recorded as done`, stepStatus.includes("done"), false);
    is(`${label}: she still waits in the nurture sequence, which is not marked ended`, [await waitingIn(email), (await statusIn(nurtureId, email)).includes("ended")], [1, false]);
    // The step is tried again later, now with exact replies, and takes her out.
    shift += 3_600_000;
    for (let i = 0; i < 4; i += 1) await run();
    is(`${label}: tried again, she is taken out`, [await waitingIn(email), await statusIn(nurtureId, email)], [0, ["ended"]]);
  }

  part("Control: someone not in it is still told so");
  {
    const email = "never@example.com";
    await upsertContact(list, email, { agreed: true, explicit: true, source: "free" }, ROOM);
    await enroll(store, email, { joined: false, tag: "bought" });
    for (let i = 0; i < 4; i += 1) await run();
    is("the stop step is done for them, and nothing waits", [(await statusIn(boughtId, email)).includes("done"), await waitingIn(email)], [true, 0]);
  }
}

void main().then(() => done(), (error) => {
  console.error(error);
  process.exit(1);
});
