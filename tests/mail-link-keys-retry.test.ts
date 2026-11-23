/**
 * Issue #4107 (Codex T, email/queues; Claude 6 block of the coordinator's split, 5437): in a sequence's batch, sendTo
 * (lib/mail.ts) reserved the batch's month and day and its ramp portion, read the readers' tokens, then wrote the
 * consented link keys (rememberLinkKeys) outside the failure path that gives those back. A Redis failure there threw
 * out of sendTo with nothing given back: no email reached the provider, yet the month, the day and the portion stayed
 * taken, and each retry took them again, delaying later mail.
 *
 * Now a failed key write is a known failure before the provider, like an unknown token read: the reservation and the
 * portion are given back and the batch is tried again (stopped "retry"). Checked: nothing is dispatched, the month is
 * as before, and a later try with Redis answering sends each reader once. The provider and SES are stand-ins
 * (tests/mail-reservation-email.ts, tests/mail-reservation-ses.ts, through this file's aliases). Synthetic only.
 */
import { dispatch } from "./mail-reservation-email";
import { sesObservation } from "./mail-reservation-ses";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { sendTo, usedThisMonth } from "@/lib/mail";
import { windowId } from "@/lib/allowance-window";
import { store as memory } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installVirtualClock } from "./slow-test-virtual-clock";
import { done, is, part } from "./check";

// The pace between list batches (lib/mail.ts, 1.5 s) passes on a virtual clock.
const clock = installVirtualClock({ maxMs: 1_500 });
const actual = memory.pipeline.bind(memory);
let failKeys = false;
(memory as unknown as { pipeline: typeof memory.pipeline }).pipeline = (async (commands: (string | number)[][]) => {
  if (failKeys && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:mail-click-key-live"))) throw new Error("redis: connection reset");
  return actual(commands);
}) as typeof memory.pipeline;

const SEQUENCE = { medium: "sequence" as const, campaign: "s-0123456789abcdef-0123456789abcdef" };

async function main(): Promise<void> {
  memory.clear();
  process.env.MARKETING_DAILY_CAP = "100000";
  sesObservation.configured = true;
  sesObservation.room = 100000;
  const owner = "linkkeys@example.com";
  await claimHandle(owner, "linkkeys", "Synthetic Link Keys", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_LinkKeys00001", subscriptionId: "sub_LinkKeys00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Synthetic Link Keys", address: "1 Test St, Portland, OR 97201" });
  const store = (await storeForEmail(owner))!;
  // One reader who allowed their link use to be seen, so the batch writes a key.
  await upsertContact(store.listId!, "reader@example.com", { agreed: true, explicit: true, source: "free", sid: store.sid, clicks: true, title: "The Guide" }, ROOM);

  part("The link keys cannot be written: nothing is sent, and what was taken is given back");
  const before = await usedThisMonth(store.listId, windowId(store));
  dispatch.calls = 0;
  dispatch.outcome = "sent";
  failKeys = true;
  const failed = await sendTo(store, ["reader@example.com"], "Synthetic", "Test only", "link-keys-retry", SEQUENCE).then(
    (r) => r,
    (error: unknown) => ({ threw: String(error) }),
  );
  failKeys = false;
  is("tried again later, never thrown", "stopped" in failed ? failed.stopped : "threw", "retry");
  is("the reader is still to be sent", "rest" in failed ? failed.rest : null, ["reader@example.com"]);
  is("nothing reached the provider", dispatch.calls, 0);
  is("the month's reservation is given back", await usedThisMonth(store.listId, windowId(store)), before);

  part("Tried again with Redis answering: sent once");
  const again = await sendTo(store, ["reader@example.com"], "Synthetic", "Test only", "link-keys-retry", SEQUENCE);
  is("sent, nothing left", [again.stopped, again.done, again.rest], [null, ["reader@example.com"], []]);
  is("one batch to the provider", dispatch.calls, 1);
  is("one email taken from the month", await usedThisMonth(store.listId, windowId(store)), before + 1);
  clock.restore();
  done();
}

main().catch((error) => {
  clock.restore();
  console.error(error);
  process.exit(1);
});
