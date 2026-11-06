/**
 * 232 [CA1] unit 4b4b2: while a store's plan renewal is unpaid (or a payment
 * for its plan is disputed), webhook deliveries are not sent: the endpoint is
 * never called, the delivery is marked not sent at once with the reason, it
 * is not tried again, and it counts as one of the month's deliveries (so what
 * is refused stays inside the priced month). A delivery already retrying when
 * the pause starts is stopped the same way. Adding an endpoint waits too,
 * through the studio and the API; changing and removing stay open. Events
 * after payment are sent as usual. Everything goes through the real
 * lib/safe-fetch.ts to a local HTTP server.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as studioHooks } from "@/app/api/store/webhooks/route";
import { addEndpoint, deliverDue, emitEvent, setSendHooksForTests, watchStripe, webhooksView } from "@/lib/webhooks";
import { setStripeAccount } from "@/lib/store";
import { claimHandle, ensureStatsId, recordPlanDispute, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { WEBHOOK_ADD_PAUSED_WORDS, WEBHOOK_PAUSED_COUNTED, WEBHOOK_PAUSED_NOT_SENT_WORDS } from "@/lib/integration-pause";
import { readFileSync } from "node:fs";
import { RENEWAL_PAUSED_WORDS } from "@/lib/renewal-unpaid-words";
import { DISPUTE_PAUSED_WORDS } from "@/lib/plan-dispute-rules";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const received: string[] = [];
/** What the endpoint answers next; 200 when nothing is queued. */
const answers: number[] = [];
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk.toString()));
  request.on("end", () => {
    received.push(body);
    response.writeHead(answers.shift() ?? 200);
    response.end("ok");
  });
});
class LocalAgent extends https.Agent {
  constructor(private port: number) {
    super({ keepAlive: false });
  }
  createConnection(): net.Socket {
    return net.connect(this.port, "127.0.0.1");
  }
}

/** The webhook queue's lease, as Redis runs it (the in-memory store does not know the script). */
const original = redis.pipeline.bind(redis);
redis.pipeline = async (commands: (string | number)[][]) => {
  const [only] = commands;
  if (commands.length === 1 && only[0] === "EVAL" && String(only[1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) {
    const [, , , key, member, now, until] = only.map(String);
    const [due] = await original([["ZSCORE", key, member]]);
    if (due === null || due === undefined || Number(due) > Number(now)) return [0];
    await original([["ZADD", key, Number(until), member]]);
    return [1];
  }
  return original(commands);
};

const OWNER = "webhook-wait@example.com";
const FAR = Date.now() + 400 * 86_400_000;

async function main(): Promise<void> {
  redis.clear();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never } });

  await claimHandle(OWNER, "webhook-wait-shop", "Webhook Wait Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_WebhookWait1", subscriptionId: "sub_WebhookWait1", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  let store = (await storeForEmail(OWNER))!;
  const added = await addEndpoint(store, "https://hooks.example.com/sales", ["sale.completed"]);
  is("an endpoint is added while paid", added.ok, true);
  const used = () => allowanceUsed(store, "webhook");
  const latest = async () => (await webhooksView(store)).log[0]!;
  const sweep = () => deliverDue(Date.now() + 10_000, FAR);

  part("Paid: a failing endpoint is left retrying");
  answers.push(500);
  await emitEvent(store, "sale.completed", "cs_wait_0000", { amount_cents: 900 });
  let d = await latest();
  is("the first try failed and waits for its retry", [d.state, d.attempts, received.length], ["retrying", 1, 1]);

  part("Renewal unpaid: nothing is sent, the delivery is marked at once");
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: true });
  store = (await storeForEmail(OWNER))!;
  const before = await used();
  is("one delivery is made for the sale", await emitEvent(store, "sale.completed", "cs_wait_0001", { amount_cents: 4900 }), 1);
  d = await latest();
  is("not sent, never tried, with the sentence in the log", [d.state, d.attempts, d.next, d.lastError, received.length], ["failed", 0, 0, `${WEBHOOK_PAUSED_NOT_SENT_WORDS.paused_unpaid} ${WEBHOOK_PAUSED_COUNTED}`, 1]);
  is("the log marks it as not sent for the pause", d.notSentPaused, true);
  is("it counts as one of the month's deliveries, once", (await used()) - before, 1);
  is("the retrying delivery from before the pause is stopped the same way, without a call", [await sweep(), received.length], [{ tried: 1, delivered: 0 }, 1]);
  const stopped = (await webhooksView(store)).log.find((x) => x.attempts === 1)!;
  is("and says why", [stopped.state, stopped.lastError, stopped.notSentPaused], ["failed", `${WEBHOOK_PAUSED_NOT_SENT_WORDS.paused_unpaid} ${WEBHOOK_PAUSED_COUNTED}`, true]);
  is("nothing is left to try", (await sweep()).tried, 0);
  is("two deliveries counted in all", (await used()) - before, 2);

  part("Adding an endpoint waits while unpaid, in the studio's code and through the API");
  const refused = await addEndpoint(store, "https://hooks.example.com/more", ["sale.completed"]);
  is("refused with its sentence", refused.ok ? "added" : [refused.reason, refused.message], ["paused", WEBHOOK_ADD_PAUSED_WORDS.paused_unpaid]);
  is("nothing was added", (await webhooksView(store)).endpoints.length, 1);
  is("the API answers it 409, as a refusal and not a fault", /paused: 409/.test(readFileSync("app/api/v1/hooks/route.ts", "utf8")), true);
  is("the Terms count a delivery not sent while paused", readFileSync("app/terms/page.tsx", "utf8").includes("and each one not sent because your"), true);
  is("the notices name webhooks among what pauses", [RENEWAL_PAUSED_WORDS, DISPUTE_PAUSED_WORDS].every((w) => w.includes("New webhook endpoints cannot be added, and webhooks are not sent to your endpoints, not even later, except events from your Stripe account")), true);
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const viaStudio = await studioHooks(new NextRequest(`https://marktmorgen.com/api/store/webhooks?store=${store.sid}`, { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "add", url: "https://hooks.example.com/route", events: ["sale.completed"] }) }));
  is("the studio's route answers 409 with the sentence", [viaStudio.status, ((await viaStudio.json()) as { message?: string }).message], [409, WEBHOOK_ADD_PAUSED_WORDS.paused_unpaid]);

  part("The Stripe watcher does not read a paused store, and keeps its place");
  process.env.STRIPE_SECRET_KEY = "sk_test_webhook_wait_only";
  const stripeCalls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.stripe.com") return realFetch(input as never, init);
    stripeCalls.push(url.search);
    return Response.json({ data: [], has_more: false });
  }) as typeof fetch;
  is("the store's Stripe account is connected", (await setStripeAccount(OWNER, "acct_WebhookWait01")).ok, true);
  store = (await storeForEmail(OWNER))!;
  const anchorKey = `nl:hooks:anchor:${store.statsId}`;
  await redis.pipeline([["SET", anchorKey, "evt_WaitAnchor01"]]);
  is("paused: no store read, no Stripe call", [await watchStripe(Date.now() + 10_000), stripeCalls.length], [{ stores: 0, events: 0 }, 0]);
  is("the anchor stays where it was", await redis.pipeline([["GET", anchorKey]]), ["evt_WaitAnchor01"]);
  is("and is kept as long as Stripe keeps events", Number((await redis.pipeline([["TTL", anchorKey]]))[0]) > 29 * 86400, true);

  part("Disputed: the dispute's sentence");
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: false });
  store = (await storeForEmail(OWNER))!;
  const now = Math.floor(Date.now() / 1000);
  is("a dispute is written down", Boolean(await recordPlanDispute(storeRef(store), { id: "du_WebhookWait1", status: "open", at: now, coversUntil: now + 30 * 86_400 })), true);
  store = (await storeForEmail(OWNER))!;
  await emitEvent(store, "sale.completed", "cs_wait_0002", { amount_cents: 1900 });
  d = await latest();
  is("not sent, with the dispute's sentence", [d.state, d.lastError, received.length], ["failed", `${WEBHOOK_PAUSED_NOT_SENT_WORDS.paused_disputed} ${WEBHOOK_PAUSED_COUNTED}`, 1]);
  const refusedDisputed = await addEndpoint(store, "https://hooks.example.com/more", ["sale.completed"]);
  is("adding is refused with the dispute's sentence", refusedDisputed.ok ? "added" : refusedDisputed.message, WEBHOOK_ADD_PAUSED_WORDS.paused_disputed);

  part("Settled: sent as usual, adding works again");
  is("the dispute won", Boolean(await recordPlanDispute(storeRef(store), { id: "du_WebhookWait1", status: "won", at: now, coversUntil: now + 30 * 86_400 })), true);
  store = (await storeForEmail(OWNER))!;
  await emitEvent(store, "sale.completed", "cs_wait_0003", { amount_cents: 2900 });
  d = await latest();
  is("a new event is delivered", [d.state, received.length], ["delivered", 2]);
  is("settled: the watcher reads on from the kept anchor", [(await watchStripe(Date.now() + 10_000)).stores, stripeCalls.length, new URLSearchParams(stripeCalls[0] ?? "").get("ending_before")], [1, 1, "evt_WaitAnchor01"]);
  globalThis.fetch = realFetch;
  is("adding an endpoint works again", (await addEndpoint(store, "https://hooks.example.com/more", ["refund.issued"])).ok, true);
  part("A month already used while paused: the pause and the month are both said, never retried");
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: true });
  store = (await storeForEmail(OWNER))!;
  const fill = STORE_ALLOWANCES.pro.webhook - (await used());
  if (fill > 0) await takeAllowance(store, "webhook", fill);
  await emitEvent(store, "sale.completed", "cs_wait_used", { amount_cents: 100 });
  d = await latest();
  is("failed, with the pause first and the month after", [d.state, d.next, d.lastError.startsWith(WEBHOOK_PAUSED_NOT_SENT_WORDS.paused_unpaid), d.lastError.length > WEBHOOK_PAUSED_NOT_SENT_WORDS.paused_unpaid.length, received.length], ["failed", 0, true, true, 2]);
  is("the counted sentence is not claimed for a month already used", d.lastError.includes(WEBHOOK_PAUSED_COUNTED), false);

  part("A count that cannot be made while paused: the pause sentence alone, never retried");
  const counting = redis.pipeline;
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (commands.some((c) => String(c[0]) === "INCRBY")) throw new Error("a store that does not answer");
    return counting(commands);
  };
  await emitEvent(store, "sale.completed", "cs_wait_unknown", { amount_cents: 100 });
  redis.pipeline = counting;
  d = await latest();
  is("failed at once, no claim that it was counted", [d.state, d.next, d.lastError, received.length], ["failed", 0, WEBHOOK_PAUSED_NOT_SENT_WORDS.paused_unpaid, 2]);

  server.close();
  done();
}

main();
