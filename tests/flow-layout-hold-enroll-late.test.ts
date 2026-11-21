/**
 * A start chosen from the workflow list as it was read, stamped with a later time (Codex L and X6 on #4539, HIGH):
 * enroll reads the list, then waits for the contact's record (mailableExactly), and only then startFlows stamped the
 * new run with its own clock. A save that moved the steps between those two moments was then older than the run's
 * stamp, so the run was taken as chosen after the save, and the next job sent whatever now stood at the old position.
 *
 * The test pauses enroll right after its list read (on the contact's read) and saves a new order a second later, then
 * lets the start go on a second after that. The run must be stamped from the list as read: it is held for the creator,
 * nothing is sent from the new order in the old one's place. A start whose list read comes after the save is not held.
 * Synthetic store and email stand-in.
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
const base = Math.ceil(realNow() / 1000) * 1000 + 100;
let shift = 0;
Date.now = () => base + shift;
const SECOND = 1_000;
const HOUR = 3_600_000;

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);

const A = { id: "f000000000000011", delayHours: 0, subject: "Step A", body: "One." };
const B = { id: "f000000000000012", delayHours: 24, subject: "Step B", body: "Two." };
const C = { id: "f000000000000013", delayHours: 24, subject: "Step C", body: "Three." };

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_workflows_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_workflows_only_a_stand_in";

  const OWNER = "layout-late@example.test";
  await claimHandle(OWNER, "layoutlate", "Layout Late", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLayout3", true);
  await setSubscription(OWNER, { customerId: "cus_LayoutLate1", subscriptionId: "sub_LayoutLate1", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Layout Late", address: "1 Main St, Portland, OR 97201" });
  let store: Store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  const subjects = (email: string) => mail.sesAttempts.filter((m) => JSON.stringify(m).includes(email)).map((m) => m.subject);

  const made = await saveFlow(store, { name: "Late", trigger: "tagged", tag: "late", steps: [A, B, C] });
  if (!made.ok) throw new Error(`no workflow: ${JSON.stringify(made)}`);
  const flowId = made.flows.find((f) => f.name === "Late")!.id;
  await setFlowActive(store, flowId, true);
  store = (await storeForEmail(OWNER))!;
  const save = async (steps: object[]) => {
    const saved = await saveFlow(store, { id: flowId, name: "Late", trigger: "tagged", tag: "late", steps, active: true });
    if (!saved.ok) throw new Error(`not saved: ${JSON.stringify(saved)}`);
  };

  // Pause enroll on the contact's read, which comes after its list read: a save lands in between, a second later,
  // and the start goes on a second after the save.
  const real = redis.pipeline.bind(redis);
  let pauseFor: string | null = null;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const one = commands.length === 1 ? commands[0] : null;
    if (pauseFor && one && one[0] === "HGET" && String(one[1]).includes(list) && one[2] === pauseFor) {
      pauseFor = null;
      shift += SECOND;
      await save([B, A, C]);
      shift += SECOND;
    }
    return real(commands);
  }) as typeof redis.pipeline;

  part("A start whose list was read before a save that moved the steps");
  await upsertContact(list, "late@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  pauseFor = "late@example.com";
  await enroll(store, "late@example.com", { joined: false, tag: "late" });
  is("the save landed between the list read and the start", pauseFor, null);
  await run();
  is("nothing from the new order is sent in the old one's place", subjects("late@example.com").includes("Step B"), false);
  is("the run is held for the creator", (await readRun(flowId, personOf("late@example.com")))?.run.status, "held");

  part("A start whose list is read after the save is not held");
  store = (await storeForEmail(OWNER))!;
  shift += SECOND;
  await upsertContact(list, "after@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "after@example.com", { joined: false, tag: "late" });
  await run();
  shift += 25 * HOUR;
  await run();
  is("they get the steps in the new order", subjects("after@example.com"), ["Step B", "Step A"]);
  is("their run goes on", (await readRun(flowId, personOf("after@example.com")))?.run.status, "running");

  redis.pipeline = real;
  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
