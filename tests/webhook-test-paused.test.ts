/**
 * 232 [CA1] unit 4b4b1: while a store's plan renewal is unpaid (or a payment
 * for its plan is disputed), a webhook test message is refused before it is
 * sent or counted, with its own sentence; changing and removing an endpoint
 * stay open, and the test works again once paid (lib/integration-pause.ts).
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as webhooks } from "@/app/api/store/webhooks/route";
import { addEndpoint, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, recordPlanDispute, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { WEBHOOK_TEST_PAUSED_WORDS, integrationPauseWord } from "@/lib/integration-pause";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** Every name lookup a delivery made: refused here, so nothing reaches the network. */
const sent: string[] = [];
setSendHooksForTests({ fetch: { resolve: async (host: string) => { sent.push(host); throw new Error("a stand-in that answers nothing"); } } as never });

const OWNER = "webhook-test-paused@example.com";
const HOST = "marktmorgen.com";
const ORIGIN = `https://${HOST}`;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "webhook-test-paused-shop", "Webhook Test Paused Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_WebhookTestPause", subscriptionId: "sub_WebhookTestPause", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  let store = (await storeForEmail(OWNER))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const call = async (body: Record<string, unknown>) => {
    const res = await webhooks(new NextRequest(`${ORIGIN}/api/store/webhooks?store=${store.sid}`, { method: "POST", headers: { host: HOST, origin: ORIGIN, cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string; message?: string } };
  };
  const added = await addEndpoint(store, "https://hooks.example.com/paused", ["sale.completed"]);
  is("an endpoint is added while paid", added.ok, true);
  const id = (await webhooksView(store)).endpoints[0]!.id;
  const tries = async () => (await webhooksView(store)).log.length;

  part("Paid: the test is sent as before");
  const before = await tries();
  const paid = await call({ action: "test", id });
  is("the test is not refused for a pause", paid.body.error === "paused_unpaid" || paid.body.error === "paused_disputed", false);
  is("and it was tried", (await tries()) > before, true);

  part("Renewal unpaid: no test, nothing tried");
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: true });
  store = (await storeForEmail(OWNER))!;
  is("paused", integrationPauseWord(store), "paused_unpaid");
  const held = await tries();
  const refused = await call({ action: "test", id });
  is("the test is refused with its sentence", [refused.status, refused.body.error, refused.body.message], [409, "paused_unpaid", WEBHOOK_TEST_PAUSED_WORDS.paused_unpaid]);
  is("nothing was tried", await tries(), held);
  const changed = await call({ action: "events", id, events: ["sale.completed", "refund.issued"] });
  is("changing an endpoint's events stays open", [changed.status, changed.body.ok], [200, true]);

  part("Disputed: the dispute's sentence");
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: false });
  store = (await storeForEmail(OWNER))!;
  const now = Math.floor(Date.now() / 1000);
  is("the dispute is written down", Boolean(await recordPlanDispute(storeRef(store), { id: "du_WebhookTestPause1", status: "open", at: now, coversUntil: now + 30 * 86_400 })), true);
  store = (await storeForEmail(OWNER))!;
  is("refused for the dispute", (await call({ action: "test", id })).body.message, WEBHOOK_TEST_PAUSED_WORDS.paused_disputed);

  part("Removing stays open, and the test works again once paid");
  is("the dispute won", Boolean(await recordPlanDispute(storeRef(store), { id: "du_WebhookTestPause1", status: "won", at: now, coversUntil: now + 30 * 86_400 })), true);
  store = (await storeForEmail(OWNER))!;
  const again = await tries();
  await call({ action: "test", id });
  is("the test is tried again", (await tries()) > again, true);
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: true });
  store = (await storeForEmail(OWNER))!;
  const removed = await call({ action: "remove", id });
  // The route's after() (the creator's notice) needs a request scope this test has not, so it
  // answers 500 here after removing; what counts is that the pause did not stop the removal.
  is("removing an endpoint while paused works", [String(removed.body.error).startsWith("paused"), (await webhooksView(store)).endpoints.length], [false, 0]);
  is("no test message reached the endpoint while paused (two tried, both when paid)", sent.filter((h) => h === "hooks.example.com").length, 2);
  done();
}

main();
