/**
 * Issue #4112 (Codex T, email/queues; the caller's side of #4107): when a sequence step's batch could not write the
 * consented link keys, sendTo (lib/mail.ts) threw, and the sequence (lib/flows.ts) settled the attempt as uncertain:
 * the run was held as if the sender's answer were lost, so the email never went out by itself, although nothing had
 * reached the provider. Now sendTo answers "retry" there (the reservation and the ramp given back), the step is
 * deferred, not held, and the next run sends it once.
 * Synthetic store, list and reader; the SES mail fixture (tests/ses-mail-fixture.ts); in-memory Redis.
 */
import { enroll, saveFlow, sendDueSteps } from "@/lib/flows";
import { FIRST_DELAY_SECONDS } from "@/lib/flow-retry";
import { upsertContact } from "@/lib/contacts";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";
import { skipWaits } from "./skip-waits";
skipWaits(["takeLock", "paced"]);
// A deferred step is tried again FIRST_DELAY_SECONDS later (lib/flow-retry.ts): the clock is moved on past it.
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;

const mail = installSesMailFixture({ fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })) });
const got = (subject: string, to: string) => mail.sent.filter((m) => m.subject === subject && JSON.stringify(m).includes(to)).length;
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);

const original = redis.pipeline.bind(redis);
let failKeys = false;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (failKeys && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:mail-click-key-live"))) throw new Error("redis: connection reset");
  return original(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_flow_link_keys_only";
  process.env.RESEND_API_KEY = "re_test_flow_link_keys_only";
  const OWNER = "flowlinkkeys@example.com";
  await claimHandle(OWNER, "flowlinkkeys", "Flow Link Keys", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestFlowLnk01", true);
  await setSubscription(OWNER, { customerId: "cus_FlowLinkKeys", subscriptionId: "sub_FlowLinkKeys", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Flow Link Keys", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const saved = await saveFlow(store, { name: "Welcome", trigger: "joined", active: true, steps: [{ delayHours: 0, subject: "Day one", body: "Hello." }] }, { activate: true });
  is("setup: workflow saved", saved.ok, true);
  // A reader who allowed their link use to be seen: the step's batch writes a link key for them.
  await upsertContact(store.listId!, "ana@example.com", { agreed: true, explicit: true, source: "free", sid: store.sid, clicks: true, title: "The Guide" }, ROOM);
  await enroll(store, "ana@example.com", { joined: true });

  part("The link keys cannot be written: nothing is sent, and the step is not held");
  failKeys = true;
  await run();
  failKeys = false;
  is("nothing reached the provider", got("Day one", "ana@example.com"), 0);

  part("The next run once the step's wait is over sends it, once (a held step never would)");
  shift += (FIRST_DELAY_SECONDS + 60) * 1000;
  await run();
  is("sent once", got("Day one", "ana@example.com"), 1);
  shift += (FIRST_DELAY_SECONDS + 60) * 1000;
  await run();
  is("and never again", got("Day one", "ana@example.com"), 1);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
