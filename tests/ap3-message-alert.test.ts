/**
 * Complement WG (MQ2 group c) of 451 [AP3], unit 1: a buyer's new message in the inbox tells the store's installed
 * studios that asked for "message" (lib/phone-alerts.ts), through the real inbox (lib/inbox.ts) against the
 * in-memory Redis and a stand-in push service (tests/path-push-world.ts). Synthetic stores only. Each part fails
 * on the wrong behavior it names: a lock screen showing the buyer's words, name or address; a device that did not
 * ask being told; a buyer writing again before anyone read it buzzing the phone again; a read conversation never
 * telling again; a flood past QUIET_PER_HOUR; a tap that opens anything but that conversation.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { PHONE_EVENTS, QUIET_PER_HOUR, addDevice, eventsFor, setDeviceEvents } from "@/lib/phone-alerts";
import { fileContact, handOver, openConversation, readInbox, visitorSend } from "@/lib/inbox";
import { can } from "@/lib/team-roles";
import { paidPeriod } from "./billing-period-fixture";
import { pushes } from "./path-push-world";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";

type Payload = { title: string; body: string; url: string; tag: string };
const payloads = () => pushes.map((p) => JSON.parse(p.payload) as Payload);

async function main() {
  const owner = "ap3-owner@example.test";
  await claimHandle(owner, "apmessages", "Synthetic shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_apmessages", subscriptionId: "sub_apmessages", active: true, tier: "creator", period: paidPeriod() });
  let store = (await storeForEmail(owner))!;

  part("A new event, \"message\", for whoever may answer buyers, and only theirs");
  is("it is one of the events", PHONE_EVENTS.includes("message"), true);
  is("each role hears of messages exactly when it may see orders", (["owner", "admin", "editor", "support"] as const).map((r) => eventsFor(r).includes("message") === can(r, "orders")), [true, true, true, true]);

  const asked = await addDevice(store, owner, "owner", { endpoint: "https://fcm.googleapis.com/fcm/send/asks", keys: { p256dh: "test", auth: "test" } }, ["message"], "Phone", Date.now() - 1000);
  const other = await addDevice(store, owner, "owner", { endpoint: "https://fcm.googleapis.com/fcm/send/sales-only", keys: { p256dh: "test", auth: "test" } }, ["sale"], "Tablet", Date.now() - 1000);
  if (!asked.ok || !other.ok) throw new Error("synthetic devices");
  store = (await storeForEmail(owner))!;

  part("A buyer's message: one notification, to the device that asked, with nothing of the buyer on it");
  const words = "Hello, my download link from order 4417 does not open";
  const first = await handOver({ store, email: "buyer.private@example.test", name: "Private Buyer", text: words });
  if (!first.ok) throw new Error(`handOver ${first.reason}`);
  is("one push", pushes.length, 1);
  is("to the device that asked for messages only", pushes.map((p) => p.endpoint), ["https://fcm.googleapis.com/fcm/send/asks"]);
  const [conversation] = await readInbox(store.statsId);
  const sent = payloads()[0];
  is("the words of a lock screen", [sent.title, sent.body, sent.tag], ["New message from a buyer", "In Synthetic shop's inbox. Open it to read and answer.", "message"]);
  is("never the buyer's words, name or address", [words, "download", "Private Buyer", "buyer.private", "example.test"].some((w) => pushes[0].payload.includes(w)), false);
  is("the tap opens that conversation", sent.url, `/studio/inbox?store=${encodeURIComponent(store.sid)}&c=${conversation.id}`);

  part("Writing again before anyone read it is not a second buzz");
  const again = await visitorSend(first.thread.token, "Any news on this?", async () => (await storeForEmail(owner))!);
  is("the message is kept", again.ok, true);
  is("still one push", pushes.length, 1);

  part("Once it was read, the next message tells again, once");
  await openConversation(store.statsId!, conversation.id, (await storeForEmail(owner))!);
  const third = await visitorSend(first.thread.token, "Still not working, sorry.", async () => (await storeForEmail(owner))!);
  is("kept", third.ok, true);
  is("a second push", pushes.length, 2);
  await visitorSend(first.thread.token, "One more detail.", async () => (await storeForEmail(owner))!);
  is("and no third before it is read again", pushes.length, 2);

  part("Two messages at once, after it was read, are still one buzz (Codex C2 on #3619)");
  await openConversation(store.statsId!, conversation.id, (await storeForEmail(owner))!);
  const before = pushes.length;
  const now = Date.now();
  const both = await Promise.all([
    visitorSend(first.thread.token, "First of two at once.", async () => (await storeForEmail(owner))!, now),
    visitorSend(first.thread.token, "Second of two at once.", async () => (await storeForEmail(owner))!, now + 1),
  ]);
  is("both messages are kept", both.map((r) => r.ok), [true, true]);
  is("one push for the two, not one each", pushes.length - before, 1);
  await openConversation(store.statsId!, conversation.id, (await storeForEmail(owner))!);
  await visitorSend(first.thread.token, "After reading them both.", async () => (await storeForEmail(owner))!, now + 2);
  is("and read again, the next message tells again", pushes.length - before, 2);

  part("A message from the contact form is told the same way");
  const contact = await fileContact({ store: (await storeForEmail(owner))!, email: "another.buyer@example.test", name: "Another", text: "A question about sizes." });
  is("filed and told", [contact, pushes.length], [true, 5]);
  is("with nothing of that buyer", pushes[4].payload.includes("another.buyer") || pushes[2].payload.includes("sizes"), false);

  part(`At most QUIET_PER_HOUR (${QUIET_PER_HOUR}) an hour, however many buyers write`);
  for (let i = 0; i < QUIET_PER_HOUR + 5; i++) {
    await handOver({ store: (await storeForEmail(owner))!, email: `flood${i}@example.test`, name: "", text: `Question number ${i}` });
  }
  is("the phone hears of twenty in the hour, no more", pushes.length, QUIET_PER_HOUR);

  part("A device that switches messages off is not told");
  pushes.length = 0;
  const owner2 = "ap3-second@example.test";
  await claimHandle(owner2, "apquiet", "Quiet shop", "");
  await ensureStatsId(owner2);
  await ensureStoreId(owner2);
  await setSubscription(owner2, { customerId: "cus_apquiet", subscriptionId: "sub_apquiet", active: true, tier: "creator", period: paidPeriod() });
  let quiet = (await storeForEmail(owner2))!;
  const device = await addDevice(quiet, owner2, "owner", { endpoint: "https://fcm.googleapis.com/fcm/send/quiet", keys: { p256dh: "test", auth: "test" } }, ["message", "sale"], "Phone", Date.now() - 1000);
  if (!device.ok) throw new Error("synthetic device");
  await setDeviceEvents(quiet, owner2, "owner", device.id, ["sale"]);
  quiet = (await storeForEmail(owner2))!;
  const off = await handOver({ store: quiet, email: "buyer3@example.test", name: "", text: "Hello there" });
  is("the message is kept", off.ok, true);
  is("and no push", pushes.length, 0);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
