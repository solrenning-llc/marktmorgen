/**
 * The layout hold (tests/flow-layout-hold.test.ts) compares when a person's run last moved with when the workflow's
 * steps last changed places (Flow.layoutAt). One mail job (sendDueSteps) reads a store's workflows once and keeps them
 * for the whole job, which can last up to 30 seconds, so a later group of the same workflow in the same job still works
 * from the list as it was read. Its writes used to stamp the run with that group's own "now": a save landing between
 * two groups was then taken as older than the step it had changed, and the next job sent the wrong step.
 *
 * Found on #4539 (comment 6900339629): A sent in a later group after a save that moved it queues the person at
 * position 2 with a fresh stamp, so position 2 (now A again, or C) goes out and B is never sent.
 *
 * Here the save is made while the job sends the first group's email (the SES stand-in's hook), two seconds after the
 * job read the list, and the second group of that workflow follows in the same job. Whoever that second group moved
 * on is held for the creator on the next job, never sent the step now at their old position. Synthetic store and
 * email stand-in.
 */
import { personOf, readRun } from "@/lib/flow-runs";
import { enroll, saveFlow, sendDueSteps, setFlowActive } from "@/lib/flows";
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

/** A save made by the SES stand-in when it is asked to send to this address, once. */
let duringSendTo: { email: string; save: () => Promise<void> } | null = null;
const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
  onSes: (message) => {
    const armed = duringSendTo;
    if (!armed || !message.to.some((to) => to.includes(armed.email))) return undefined;
    duringSendTo = null;
    return (async () => {
      // Two seconds after the job read the list: a save in a later second than that read.
      shift += 2_000;
      await armed.save();
      // Then the email is accepted, as the stand-in does by default.
      return new Response(JSON.stringify({ MessageId: "ses_fixture_midjob" }), { status: 200, headers: { "content-type": "application/json" } });
    })();
  },
});
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);

const A = { id: "e000000000000001", delayHours: 0, subject: "Step A", body: "One." };
const B = { id: "e000000000000002", delayHours: 24, subject: "Step B", body: "Two." };
const C = { id: "e000000000000003", delayHours: 24, subject: "Step C", body: "Three." };
const D = { id: "e000000000000004", delayHours: 24, subject: "Step D", body: "Four." };

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_workflows_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_workflows_only_a_stand_in";

  const OWNER = "layout-midjob@example.test";
  await claimHandle(OWNER, "layoutmidjob", "Layout Midjob", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLayHold", true);
  await setSubscription(OWNER, { customerId: "cus_LayoutMidjob1", subscriptionId: "sub_LayoutMidjob1", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Layout Midjob", address: "1 Main St, Portland, OR 97201" });
  let store: Store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  const subjects = (email: string) => mail.sesAttempts.filter((m) => JSON.stringify(m).includes(email)).map((m) => m.subject);
  const join = async (email: string, tag: string) => {
    await upsertContact(list, email, { agreed: true, explicit: true, source: "free" }, ROOM);
    await enroll(store, email, { joined: false, tag });
  };

  /**
   * A workflow `steps` with `early` sent A and due for B, and `late` just started and due for A, both in the same job:
   * B's group first (due earlier), then A's. While B is being sent, the creator saves `after`.
   */
  const midJob = async (name: string, tag: string, steps: object[], after: object[], early: string, late: string) => {
    const made = await saveFlow(store, { name, trigger: "tagged", tag, steps });
    if (!made.ok) throw new Error(`no workflow: ${JSON.stringify(made)}`);
    const flowId = made.flows.find((f) => f.name === name)!.id;
    await setFlowActive(store, flowId, true);
    store = (await storeForEmail(OWNER))!;
    await join(early, tag);
    await run();
    is(`${early} was sent A and waits for B`, subjects(early), ["Step A"]);
    shift += 25 * HOUR;
    await join(late, tag);
    duringSendTo = {
      email: early,
      save: async () => {
        const saved = await saveFlow(store, { id: flowId, name, trigger: "tagged", tag, steps: after, active: true });
        if (!saved.ok) throw new Error(`not saved: ${JSON.stringify(saved)}`);
      },
    };
    await run();
    is("the save was made in the middle of the job", duringSendTo, null);
    store = (await storeForEmail(OWNER))!;
    is(`${early} was sent B, ${late} A, from the list the job had read`, [subjects(early), subjects(late)], [["Step A", "Step B"], ["Step A"]]);
    shift += 25 * HOUR;
    await run();
    return flowId;
  };

  part("Steps reordered between two groups of the same job: A is not sent twice");
  const moved = await midJob("Moved", "moved", [A, B, C], [B, A, C], "moved-early@example.com", "moved-late@example.com");
  is("the one who had A just before the save is not sent A again (now in position 2)", subjects("moved-late@example.com"), ["Step A"]);
  is("their run is held for the creator", (await readRun(moved, personOf("moved-late@example.com")))?.run.status, "held");

  part("A step removed between two groups of the same job: B is not skipped");
  const removed = await midJob("Removed", "removed", [A, B, C, D], [B, C, D], "removed-early@example.com", "removed-late@example.com");
  is("the one who had A just before the save is not sent C (now in position 2), skipping B", subjects("removed-late@example.com"), ["Step A"]);
  is("their run is held for the creator", (await readRun(removed, personOf("removed-late@example.com")))?.run.status, "held");
  is("the one who had B before the save is not sent D (now in position 3), skipping C", subjects("removed-early@example.com"), ["Step A", "Step B"]);
  is("their run is held too", (await readRun(removed, personOf("removed-early@example.com")))?.run.status, "held");

  part("Control: a save before the job read the list holds nobody the job moves on");
  const fresh = await saveFlow(store, { name: "Fresh", trigger: "tagged", tag: "fresh", steps: [A, B, C] });
  if (!fresh.ok) throw new Error("no workflow");
  const freshId = fresh.flows.find((f) => f.name === "Fresh")!.id;
  await setFlowActive(store, freshId, true);
  store = (await storeForEmail(OWNER))!;
  const saved = await saveFlow(store, { id: freshId, name: "Fresh", trigger: "tagged", tag: "fresh", steps: [B, A, C], active: true });
  if (!saved.ok) throw new Error("not saved");
  store = (await storeForEmail(OWNER))!;
  shift += 2_000;
  await join("fresh@example.com", "fresh");
  await run();
  shift += 25 * HOUR;
  await run();
  is("they get the steps in the new order", subjects("fresh@example.com"), ["Step B", "Step A"]);
  is("their run goes on", (await readRun(freshId, personOf("fresh@example.com")))?.run.status, "running");

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
