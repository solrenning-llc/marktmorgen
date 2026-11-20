/**
 * A store alert is never said, and its mark never written, for a store whose erasure began while its numbers were
 * being read (Codex L-20261120-1842): checkAlerts reads stats, sales and the goal on an old Store, then takes
 * nl:alert:<statsId>:<kind> and posts, pushes and emails; each alert's mark is taken through claimWhileStoreLive.
 * Synthetic store, the in-memory Redis and stubbed Stripe, chat and email only.
 */
import { checkAlerts } from "@/lib/store-alerts";
import { setChatAddress } from "@/lib/chat-summary";
import { setSalesGoal } from "@/lib/sales-goal";
import { ERASING_KEY, claimHandle, ensureStatsId, ensureStoreId, erasingField, setChatSales, setStripeAccount, setSubscription, storeForEmail, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_store_alerts_stand_in";
process.env.RESEND_API_KEY = "re_test_store_alerts_stand_in";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const SLACK = "https://hooks.slack.com/services/T000/B000/abcdefghijklmnop";
const DAY = 86_400_000;
const posted: string[] = [];
const emails: string[] = [];
let handle = "";
/** Run once, inside the first Stripe read, while checkAlerts still holds the old Store. */
let during: (() => Promise<void>) | null = null;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.hostname === "hooks.slack.com") {
    posted.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return new Response("ok", { status: 200 });
  }
  if (url.hostname === "api.resend.com") {
    emails.push(String(init?.body));
    return json({ id: `email_${emails.length}` });
  }
  const step = during;
  during = null;
  if (step) await step();
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    return json({ object: "list", has_more: false, data: [{
      id: "cs_test_alerterase0001", status: "complete", payment_status: "paid", amount_total: 60_000, currency: "usd",
      created: Math.floor(Date.now() / 1000), customer_details: { email: "buyer@example.com", name: "Pat Buyer" },
      metadata: { store: handle, product: "nope", title: "Weeknight Club", channel: "instagram" },
    }] });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function seed(owner: string, name: string): Promise<Store> {
  redis.clear();
  handle = name;
  await claimHandle(owner, name, "Harbor Kitchen", "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestAlertErase01", true);
  await setSubscription(owner, { customerId: `cus_${name}`, subscriptionId: `sub_${name}`, active: true, period: paidPeriod() });
  let store = (await storeForEmail(owner))!;
  await setChatAddress(store.statsId!, "Harbor Kitchen", SLACK);
  await setChatSales(owner, true);
  store = (await storeForEmail(owner))!;
  // The month's goal, reached by the one sale: the alert this test waits for.
  await setSalesGoal(store.statsId!, 50_000, "usd");
  return store;
}

const goalMark = (store: Store) => `nl:alert:${store.statsId}:goal-reached:${new Date().toISOString().slice(0, 7)}`;
const kept = (key: string) => Number(redis.run(["EXISTS", key]));

async function main(): Promise<void> {
  part("A live store: the goal reached is said once, by chat and email");
  posted.length = 0;
  emails.length = 0;
  const live = await seed("alert-live@example.com", "alertlive");
  is("said once", (await checkAlerts(live)).said, 1);
  is("in the chat", posted.some((p) => p.startsWith("Harbor Kitchen reached its $500 goal")), true);
  is("by email", emails.length, 1);
  is("its mark kept", kept(goalMark(live)), 1);

  part("An erasure that begins while the numbers are read: nothing said, no mark");
  posted.length = 0;
  emails.length = 0;
  const store = await seed("alert-erased@example.com", "alerterased");
  during = async () => {
    await redis.pipeline([
      ["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())],
      ["DEL", storeIdCommand(store.sid)[1]],
    ]);
  };
  is("nothing said", (await checkAlerts(store)).said, 0);
  is("no chat post to the erased store's channel", posted.length, 0);
  is("no email to its old address", emails.length, 0);
  is("no alert mark recreated", kept(goalMark(store)), 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
