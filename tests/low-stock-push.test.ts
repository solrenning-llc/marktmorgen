/**
 * 623 [SZ7], unit 5a: a phone alert counts as the creator told only when a
 * device answered well (Revisor 1 on #3725, LEVE). The low-stock check runs
 * in the mail job, so it waits for the push service's answer
 * (alertCreator with `wait`); a device whose subscription is over (410)
 * reaches nobody, and with the email refused too, nothing is spent.
 */
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { addDevice, alertCreator, setDeviceEvents } from "@/lib/phone-alerts";
import { setLowStock } from "@/lib/low-stock";
import { tellLowStock } from "@/lib/low-stock-alert";
import { answer, pushes } from "./low-stock-push-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_store_alerts_stand_in";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const OWNER = "push.owner@example.com";
const DAY = 86_400_000;
let refuseEmails = true;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    return refuseEmails ? new Response(JSON.stringify({ message: "synthetic refusal" }), { status: 422 }) : new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  throw new Error(`Only synthetic email: ${url.hostname}`);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "pushlow", "Push Goods", "");
  const store0 = (await ensureStatsId(OWNER))!;
  await setStripeAccount(OWNER, "acct_1TestPushLow0001", true);
  await setSubscription(OWNER, { customerId: "cus_pushlow", subscriptionId: "sub_pushlow", active: true, period: paidPeriod() });
  const added = await addDevice(store0, OWNER, "owner", { endpoint: "https://fcm.googleapis.com/fcm/send/synthetic", keys: { p256dh: "test", auth: "test" } }, [], "Test", Date.now() - 1000);
  if (!added.ok) throw new Error("synthetic device");
  await setDeviceEvents(store0, OWNER, "owner", added.id, ["alert"]);
  const store = (await storeForEmail(OWNER))!;
  const now = Date.now();

  part("Waiting for the answer, alertCreator counts the devices reached");
  answer.ok = true; answer.status = 201; answer.gone = false;
  is("one reached", await alertCreator(store, "alert", { title: "t", body: "b", url: "/studio" }, { seed: "w1", at: now, wait: true }), 1);
  answer.ok = false; answer.status = 404; answer.gone = false;
  is("none reached", await alertCreator(store, "alert", { title: "t", body: "b", url: "/studio" }, { seed: "w2", at: now, wait: true }), 0);

  part("A device that is gone and an email refused: nothing spent");
  const made = await addProduct(OWNER, "Bowl", "", "30", null);
  if (!made.ok) throw new Error("no product");
  await setLowStock(store, made.product.id, 5, 10);
  answer.ok = false; answer.status = 404; answer.gone = false;
  const sent = pushes.length;
  is("unknown, never told", await tellLowStock(store, made.product, 4, now + DAY), "unknown");
  is("a push was tried", pushes.length > sent, true);
  answer.ok = true; answer.status = 201;
  is("the device back: told", await tellLowStock(store, made.product, 4, now + DAY), "told");
  done();
}

void main();
