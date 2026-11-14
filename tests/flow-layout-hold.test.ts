/**
 * A person waiting for a sequence step is queued by the step's POSITION (lib/flows.ts, the queue member
 * "<list>|<handle>|<flow>|<index>|<email>"), and the sender takes `flow.steps[index]` as the workflow is now. Saving the
 * workflow never touched the queue, so a step removed or moved while people were waiting shifted every position after
 * it: a person got the wrong step, skipped the one they were due, or got again an email they already had.
 *
 * Now a save that changes the steps' positions (a step added in between, removed or moved) marks the workflow with
 * when that happened (layoutAt); a save that only changes words, delays or a step at the end does not. A person
 * queued before that mark is not sent anything: their run is held with a plain note, and the creator chooses on the
 * held runs screen (resolveHeldRun) to send the step now in that position, skip it, or end the run.
 *
 * Scenarios: a step removed with someone in the middle; steps reordered with someone in the middle. Controls: an
 * edit of words only, and a step added at the end, hold nobody and the next step goes out as before; somebody who
 * starts after the change is not held. Synthetic store and email stand-in.
 */
import { personOf, readRun } from "@/lib/flow-runs";
import { enroll, readFlows, resolveHeldRun, saveFlow, sendDueSteps, setFlowActive } from "@/lib/flows";
import { upsertContact } from "@/lib/contacts";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
const HOUR = 3_600_000;

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);

const A = { id: "d000000000000001", delayHours: 0, subject: "Step A", body: "One." };
const B = { id: "d000000000000002", delayHours: 24, subject: "Step B", body: "Two." };
const C = { id: "d000000000000003", delayHours: 24, subject: "Step C", body: "Three." };
const D = { id: "d000000000000004", delayHours: 24, subject: "Step D", body: "Four." };

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_workflows_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_workflows_only_a_stand_in";

  const OWNER = "layout-hold@example.test";
  await claimHandle(OWNER, "layouthold", "Layout Hold", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLayoutHold", true);
  await setSubscription(OWNER, { customerId: "cus_LayoutHold01", subscriptionId: "sub_LayoutHold01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Layout Hold", address: "1 Main St, Portland, OR 97201" });
  let store: Store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  const subjects = (email: string) => mail.sesAttempts.filter((m) => JSON.stringify(m).includes(email)).map((m) => m.subject);

  /** A workflow [A, B, C] of its own, with `email` sent A and now waiting for B. */
  const waitingForB = async (name: string, tag: string, email: string) => {
    const made = await saveFlow(store, { name, trigger: "tagged", tag, steps: [A, B, C] });
    if (!made.ok) throw new Error(`no workflow: ${JSON.stringify(made)}`);
    const flowId = made.flows.find((f) => f.name === name)!.id;
    await setFlowActive(store, flowId, true);
    store = (await storeForEmail(OWNER))!;
    await upsertContact(list, email, { agreed: true, explicit: true, source: "free" }, ROOM);
    await enroll(store, email, { joined: false, tag });
    await run();
    return flowId;
  };
  const save = async (flowId: string, name: string, tag: string, steps: object[]) => {
    const saved = await saveFlow(store, { id: flowId, name, trigger: "tagged", tag, steps, active: true });
    if (!saved.ok) throw new Error(`not saved: ${JSON.stringify(saved)}`);
    store = (await storeForEmail(OWNER))!;
  };

  part("A step removed while someone waits for the next one");
  const removed = await waitingForB("Removed", "removed", "gonestep@example.com");
  is("A went out and the run waits for step 2", [subjects("gonestep@example.com"), (await readRun(removed, personOf("gonestep@example.com")))?.run.step], [["Step A"], 1]);
  shift += HOUR;
  await save(removed, "Removed", "removed", [B, C]);
  shift += 25 * HOUR;
  await run();
  const heldRemoved = await readRun(removed, personOf("gonestep@example.com"));
  is("neither C (now in position 2) nor anything else is sent", subjects("gonestep@example.com"), ["Step A"]);
  is("the run is held for the creator", heldRemoved?.run.status, "held");
  is("its note says the steps changed and what the creator can choose", /steps were changed/i.test(heldRemoved?.run.note ?? ""), true);
  is("the creator can send the step now in that position", await resolveHeldRun(store, removed, personOf("gonestep@example.com"), "retry"), "ok");
  await run();
  is("chosen by the creator, it goes out once", subjects("gonestep@example.com"), ["Step A", "Step C"]);

  part("Steps reordered while someone waits");
  const moved = await waitingForB("Moved", "moved", "reordered@example.com");
  shift += HOUR;
  await save(moved, "Moved", "moved", [B, A, C]);
  shift += 25 * HOUR;
  await run();
  const heldMoved = await readRun(moved, personOf("reordered@example.com"));
  is("A is never sent again (it is in position 2 now)", subjects("reordered@example.com"), ["Step A"]);
  is("the run is held", heldMoved?.run.status, "held");

  part("Somebody who starts after the change is not held");
  await upsertContact(list, "later@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  shift += 2_000;
  await enroll(store, "later@example.com", { joined: false, tag: "moved" });
  await run();
  shift += 25 * HOUR;
  await run();
  is("they get the steps in the new order", subjects("later@example.com"), ["Step B", "Step A"]);

  part("Controls: words changed, or a step added at the end, hold nobody");
  const words = await waitingForB("Words", "words", "words@example.com");
  shift += HOUR;
  await save(words, "Words", "words", [A, { ...B, subject: "Step B, reworded" }, C, D]);
  is("no change of positions is marked", (await readFlows(list)).find((f) => f.id === words)?.layoutAt, undefined);
  shift += 25 * HOUR;
  await run();
  is("the next step goes out as before, with its new words", subjects("words@example.com"), ["Step A", "Step B, reworded"]);
  is("the run goes on", (await readRun(words, personOf("words@example.com")))?.run.status, "running");

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
