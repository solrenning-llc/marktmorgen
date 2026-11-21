/**
 * The layout hold (tests/flow-layout-hold.test.ts) compares when a person's run last moved with when the workflow's
 * steps last changed places (Flow.layoutAt). Both are whole seconds. A step queued from the list as it was, and a save
 * that moves places in that very same second, used to compare equal, so the run was taken as "after the save" and the
 * next job sent the step now at the old position: an email sent twice or one skipped (Codex N1 and X6 on #4539, HIGH).
 *
 * The clock here never moves inside a second unless the test moves it, so every case below happens in one second:
 * - a step queued and a save that reorders the steps in the same second: the run is held, nothing is sent twice;
 * - somebody who starts in that same second, right after the save: not held, they get the new order;
 * - two saves that move places in the same second: the second one is still after the first;
 * - a held run the creator sends on right after two quick saves: it goes out, it is not held again.
 * Synthetic store and email stand-in.
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
// A tenth of a second into a whole second, and still: nothing below crosses into the next second by itself.
const base = Math.ceil(realNow() / 1000) * 1000 + 100;
let shift = 0;
Date.now = () => base + shift;
const HOUR = 3_600_000;

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);

const A = { id: "f000000000000001", delayHours: 0, subject: "Step A", body: "One." };
const B = { id: "f000000000000002", delayHours: 24, subject: "Step B", body: "Two." };
const C = { id: "f000000000000003", delayHours: 24, subject: "Step C", body: "Three." };

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_workflows_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_workflows_only_a_stand_in";

  const OWNER = "layout-second@example.test";
  await claimHandle(OWNER, "layoutsecond", "Layout Second", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLayout2", true);
  await setSubscription(OWNER, { customerId: "cus_LayoutSecond1", subscriptionId: "sub_LayoutSecond1", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Layout Second", address: "1 Main St, Portland, OR 97201" });
  let store: Store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  const subjects = (email: string) => mail.sesAttempts.filter((m) => JSON.stringify(m).includes(email)).map((m) => m.subject);
  const second = () => Math.floor(Date.now() / 1000);

  /** A workflow [A, B, C] of its own, with `email` sent A and now waiting for B, all in the current second. */
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

  part("A step queued and a save that reorders the steps in the same second");
  const sameSecond = await waitingForB("Same second", "samesecond", "tie@example.com");
  const queuedIn = second();
  is("A went out and the run waits for step 2", [subjects("tie@example.com"), (await readRun(sameSecond, personOf("tie@example.com")))?.run.step], [["Step A"], 1]);
  await save(sameSecond, "Same second", "samesecond", [B, A, C]);
  is("the save happened in the second the step was queued", second(), queuedIn);
  shift += 25 * HOUR;
  await run();
  is("A (now in position 2) is never sent a second time", subjects("tie@example.com"), ["Step A"]);
  is("the run is held for the creator", (await readRun(sameSecond, personOf("tie@example.com")))?.run.status, "held");

  part("Somebody who starts in that same second, right after the save, is not held");
  const fresh = await saveFlow(store, { name: "Fresh", trigger: "tagged", tag: "fresh", steps: [A, B, C] });
  if (!fresh.ok) throw new Error("no workflow");
  const freshId = fresh.flows.find((f) => f.name === "Fresh")!.id;
  await setFlowActive(store, freshId, true);
  store = (await storeForEmail(OWNER))!;
  await save(freshId, "Fresh", "fresh", [B, A, C]);
  const savedIn = second();
  await upsertContact(list, "right-after@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "right-after@example.com", { joined: false, tag: "fresh" });
  await run();
  is("started and sent in the save's own second", second(), savedIn);
  shift += 25 * HOUR;
  await run();
  is("they get the steps in the new order", subjects("right-after@example.com"), ["Step B", "Step A"]);
  is("their run goes on", (await readRun(freshId, personOf("right-after@example.com")))?.run.status, "running");

  part("Two saves that move places in the same second");
  const twice = await waitingForB("Twice", "twice", "twice@example.com");
  await save(twice, "Twice", "twice", [B, A, C]);
  const first = (await readFlows(list)).find((f) => f.id === twice)?.layoutAt ?? 0;
  await save(twice, "Twice", "twice", [C, B, A]);
  const then = (await readFlows(list)).find((f) => f.id === twice)?.layoutAt ?? 0;
  is("the second save is marked after the first", then > first, true);

  part("A held run the creator sends on right after quick saves goes out");
  shift += 25 * HOUR;
  await run();
  is("the run waiting through both saves is held", (await readRun(twice, personOf("twice@example.com")))?.run.status, "held");
  await save(twice, "Twice", "twice", [A, C, B]);
  await save(twice, "Twice", "twice", [B, C, A]);
  is("the creator's choice is taken", await resolveHeldRun(store, twice, personOf("twice@example.com"), "retry"), "ok");
  await run();
  const twiceRun = (await readRun(twice, personOf("twice@example.com")))?.run;
  is("the step the creator chose goes out once, in the same second as the saves", subjects("twice@example.com").length, 2);
  is("and the run is not held again", twiceRun?.status, "running");

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
