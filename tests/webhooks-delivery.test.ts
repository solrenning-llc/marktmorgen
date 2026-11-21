/**
 * Webhooks delivered to a real HTTP endpoint (lib/webhooks.ts; ClickFunnels
 * audit F58, added 17 October 2026). Until this file no test had sent one:
 * the delivery here goes through lib/safe-fetch.ts to a local server, with
 * only the name lookup and the socket redirected (setSendHooksForTests), so
 * the address checks, the headers, the signature and the retries are the
 * production ones. Checked:
 *
 *   - an endpoint is https on a public host, five at most, each once, with at
 *     least one event; its secret is shown once;
 *   - a delivery is signed: HMAC-SHA256 of "<timestamp>.<body>" under the
 *     endpoint's secret, with the event id, type and delivery id in headers;
 *   - the same thing noticed twice is sent once; an endpoint hears only the
 *     events it chose;
 *   - an endpoint that fails is tried again on the published schedule with a
 *     fresh timestamp and signature and the same event id, so a receiver can
 *     refuse a stale replay and drop a repeat; after seven tries it is failed;
 *   - a redirect is not followed; a removed endpoint is not sent to;
 *   - one store can neither see, change, remove nor test another store's
 *     endpoints, and the same seed makes different event ids in two stores;
 *   - test messages are limited per minute;
 *   - since 18 October 2026 every try is one of the store's webhook
 *     deliveries for its month: past the figure nothing is sent, and the
 *     delivery is marked failed with the reason; a store with no plan sends
 *     none.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { MAX_ATTEMPTS, MAX_ENDPOINTS, RETRY_MINUTES, addEndpoint, deliverDue, emitEvent, eventIdFor, removeEndpoint, sendTest, setEndpointEvents, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Received = { path: string; headers: http.IncomingHttpHeaders; body: string };
const received: Received[] = [];
/** What the endpoint answers next; it answers 200 when nothing is queued. */
const answers: number[] = [];

const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk.toString()));
  request.on("end", () => {
    received.push({ path: request.url ?? "", headers: request.headers, body });
    const status = answers.shift() ?? 200;
    response.writeHead(status, status === 302 ? { Location: "https://elsewhere.example.net/" } : {});
    response.end("ok");
  });
});

/** Every request leaves on a plain socket to the local server, whatever address was checked. */
class LocalAgent extends https.Agent {
  constructor(private port: number) {
    super({ keepAlive: false });
  }
  createConnection(): net.Socket {
    return net.connect(this.port, "127.0.0.1");
  }
}

const verify = (secret: string, header: string, body: string) => {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!match) return false;
  return createHmac("sha256", secret).update(`${match[1]}.${body}`).digest("hex") === match[2];
};

/**
 * The in-memory store models only the scripts it was taught. The webhook
 * queue's lease (lib/webhooks.ts, LEASE_SCRIPT) is modelled here, as Redis
 * runs it: taken only when the delivery is on the queue and due.
 */
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

async function main(): Promise<void> {
  redis.clear();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  // A public address, as a real name would resolve to; the socket goes to the local server.
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never } });


  part("Unknown due observations cannot authorize queue work");
  const queuePipeline = redis.pipeline;
  const malformedQueues: unknown[] = [null, [], [null], ["unknown"], [{}], [[1]], [[""]], [["duplicate", "duplicate"]], [Array.from({ length: 101 }, (_, i) => "member" + i)], [[], []]];
  for (const bad of malformedQueues) {
    let queryCalls = 0;
    let downstream = 0;
    redis.pipeline = async commands => {
      if (commands.length === 1 && commands[0][0] === "ZRANGEBYSCORE") {
        queryCalls += 1;
        return bad as never;
      }
      downstream += 1;
      return queuePipeline(commands);
    };
    try {
      await assert.rejects(deliverDue(Date.now() + 10000), /complete bounded observation/);
      is("malformed due reply stops before reads, leases or cleanup", [queryCalls, downstream, received.length], [1, 0, 0]);
    } finally { redis.pipeline = queuePipeline; }
  }
  is("an explicit empty queue is a valid completed pass", await deliverDue(Date.now() + 10000), { tried: 0, delivered: 0 });

  await claimHandle("one@example.com", "first-shop", "First Shop", "");
  await claimHandle("two@example.com", "second-shop", "Second Shop", "");
  await ensureStatsId("one@example.com");
  await ensureStatsId("two@example.com");
  // Both pay for Store: a webhook's tries come out of the plan's month (lib/store-allowance-rules.ts).
  await setSubscription("one@example.com", { customerId: "cus_HookOne00001", subscriptionId: "sub_HookOne00001", active: true, period: paidPeriod() });
  await setSubscription("two@example.com", { customerId: "cus_HookTwo00001", subscriptionId: "sub_HookTwo00001", active: true, period: paidPeriod() });
  let one = (await storeForEmail("one@example.com"))!;
  const two = (await storeForEmail("two@example.com"))!;

  part("Adding an endpoint");
  const refused = async (url: string, events: unknown = ["sale.completed"]) => {
    const result = await addEndpoint(one, url, events);
    return result.ok ? "added" : result.reason;
  };
  is("plain http is refused", await refused("http://hooks.example.com/in"), "invalid");
  is("a private address is refused", await refused("https://10.0.0.5/in"), "invalid");
  is("a local name is refused", await refused("https://localhost/in"), "invalid");
  is("no event chosen is refused", await refused("https://hooks.example.com/in", []), "events");
  const sales = await addEndpoint(one, "https://hooks.example.com/sales", ["sale.completed"]);
  if (!sales.ok) throw new Error("not added");
  is("added, with its secret shown once", /^whsec_[A-Za-z0-9_-]{32}$/.test(sales.secret), true);
  is("the studio never shows the secret again", JSON.stringify(sales.view).includes(sales.secret), false);
  is("the same address twice is refused", await refused("https://hooks.example.com/sales"), "duplicate");
  const refunds = await addEndpoint(one, "https://hooks.example.com/refunds", ["refund.issued"]);
  if (!refunds.ok) throw new Error("not added");
  for (let i = 3; i <= MAX_ENDPOINTS; i += 1) await addEndpoint(one, `https://hooks.example.com/extra${i}`, ["call.moved"]);
  is(`a ${MAX_ENDPOINTS + 1}th is refused`, await refused("https://hooks.example.com/one-more"), "full");

  part("A delivery, signed");
  const salesId = sales.view.endpoints.find((e) => e.where.endsWith("/sales"))!.id;
  const sent = await emitEvent(one, "sale.completed", "cs_test_sale0001", { amount_cents: 4900 });
  is("sent to the one endpoint that listens for it", [sent, received.length, received[0]?.path], [1, 1, "/sales"]);
  const first = received[0];
  const body = JSON.parse(first.body) as { id: string; type: string; created: number; data: { amount_cents: number } };
  is("the body says what happened", [body.type, body.data.amount_cents], ["sale.completed", 4900]);
  is("headers name the event, its type and the delivery", [first.headers["marktmorgen-event-id"], first.headers["marktmorgen-event-type"], /^dlv_[0-9a-f]{24}$/.test(String(first.headers["marktmorgen-delivery-id"]))], [body.id, "sale.completed", true]);
  is("the signature verifies with the endpoint's secret", verify(sales.secret, String(first.headers["marktmorgen-signature"]), first.body), true);
  is("and not with another secret, nor over another body", [verify(refunds.secret, String(first.headers["marktmorgen-signature"]), first.body), verify(sales.secret, String(first.headers["marktmorgen-signature"]), first.body.replace("4900", "1"))], [false, false]);
  is("its timestamp is now, so an old replay can be refused", Math.abs(Number(first.headers["marktmorgen-timestamp"]) - Math.floor(Date.now() / 1000)) <= 5, true);
  is("the same sale noticed again is not sent again", [await emitEvent(one, "sale.completed", "cs_test_sale0001", { amount_cents: 4900 }), received.length], [0, 1]);
  is("an event nobody listens for is sent nowhere", [await emitEvent(one, "lead.captured", "lead1", {}), received.length], [0, 1]);

  part("Written again after a lost reply, a delivered event is not sent or counted twice");
  const usedBeforeRelost = await allowanceUsed(one, "webhook");
  const receivedBeforeRelost = received.length;
  await emitEvent(one, "sale.completed", "cs_test_relost01", { amount_cents: 4900 });
  await deliverDue(Date.now() + 10_000);
  const relostEvent = eventIdFor(one.statsId as string, "sale.completed", "cs_test_relost01");
  const relostLines = async () => (await webhooksView(one)).log.filter((d) => d.eventId === relostEvent);
  is("delivered once, one of the month's deliveries", [(await relostLines()).map((d) => d.state), received.length - receivedBeforeRelost, (await allowanceUsed(one, "webhook")) - usedBeforeRelost], [["delivered"], 1, 1]);
  // That write's reply was lost: its sent mark was taken back (lib/webhooks.ts emitEvent), and the same event is noticed again.
  await redis.pipeline([["DEL", `nl:hooks:evt:${relostEvent}`]]);
  await emitEvent(one, "sale.completed", "cs_test_relost01", { amount_cents: 4900 });
  await deliverDue(Date.now() + 10_000);
  const relostIds = (await relostLines()).map((d) => d.id);
  const relostQueue = ((await redis.pipeline([["ZRANGEBYSCORE", "nl:hooks:q", "-inf", "+inf"]]))[0] as string[]).filter((m) => relostIds.some((id) => m.endsWith(`|${id}`)));
  is("the same delivery, still delivered: no second request, no second delivery counted, one line, at most one on the queue an endpoint", [(await relostLines()).map((d) => d.state), received.length - receivedBeforeRelost, (await allowanceUsed(one, "webhook")) - usedBeforeRelost, relostQueue.length <= 1], [["delivered"], 1, 1, true]);

  part("A failing endpoint is tried again, signed afresh");
  answers.push(500);
  await emitEvent(one, "sale.completed", "cs_test_sale0002", { amount_cents: 1900 });
  let view = await webhooksView(one);
  const failing = view.log[0];
  is("the first try failed and is waiting", [failing.state, failing.attempts, failing.lastStatus], ["retrying", 1, 500]);
  is(`the next try is ${RETRY_MINUTES[0]} minutes later`, Math.round((failing.next - failing.lastAt) / 60_000), RETRY_MINUTES[0]);

  part("Only the exact numeric lease acknowledgment authorizes a delivery");
  const leasePipeline = redis.pipeline;
  const beforeLeaseRequests = received.length;
  const beforeLeaseView = await webhooksView(one);
  for (const bad of [[], [null], ["1"], [true], [[1]], [2], [-1], [1, 1]]) {
    let leaseCalls = 0;
    redis.pipeline = async commands => {
      if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) {
        leaseCalls += 1;
        return bad as never;
      }
      return leasePipeline(commands);
    };
    try {
      await assert.rejects(deliverDue(Date.now() + 10000, Date.now() + RETRY_MINUTES[0] * 60000 + 1000), /lease was not acknowledged/);
      is("an ambiguous lease never calls the endpoint or rewrites its delivery", [leaseCalls, received.length, (await webhooksView(one)).log], [1, beforeLeaseRequests, beforeLeaseView.log]);
    } finally { redis.pipeline = leasePipeline; }
  }
  redis.pipeline = async commands => commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])') ? [0] : leasePipeline(commands);
  try {
    is("numeric zero means no lease, without an attempted delivery", await deliverDue(Date.now() + 10000, Date.now() + RETRY_MINUTES[0] * 60000 + 1000), { tried: 0, delivered: 0 });
  } finally { redis.pipeline = leasePipeline; }

  is("not before then", (await deliverDue(Date.now() + 10_000)).tried, 0);
  const before = received.length;
  const realNow = Date.now;
  const retryAt = realNow() + RETRY_MINUTES[0] * 60_000 + 1_000;
  Date.now = () => retryAt;
  try {
    is("when it is due it is sent again and delivered", await deliverDue(retryAt + 10_000, retryAt), { tried: 1, delivered: 1 });
  } finally { Date.now = realNow; }
  const again = received[before];
  is("the same event id, a newer timestamp, a signature over the same body", [again.headers["marktmorgen-event-id"], Number(again.headers["marktmorgen-timestamp"]) > Number(received[before - 1].headers["marktmorgen-timestamp"]), verify(sales.secret, String(again.headers["marktmorgen-signature"]), again.body), again.body === received[before - 1].body], [received[before - 1].headers["marktmorgen-event-id"], true, true, true]);

  part("Seven tries, then failed");
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) answers.push(503);
  await emitEvent(one, "sale.completed", "cs_test_sale0003", {});
  for (let i = 1; i < MAX_ATTEMPTS + 2; i += 1) await deliverDue(Date.now() + 10_000, Date.now() + 3 * 86_400_000);
  view = await webhooksView(one);
  is("failed after the published number of tries", [view.log[0].state, view.log[0].attempts], ["failed", MAX_ATTEMPTS]);
  answers.length = 0;

  part("No redirect followed, nothing sent to a removed endpoint");
  answers.push(302);
  await emitEvent(one, "sale.completed", "cs_test_sale0004", {});
  view = await webhooksView(one);
  is("a redirect is a failed try, not a request somewhere else", [view.log[0].state, received.at(-1)?.path], ["retrying", "/sales"]);
  await removeEndpoint(one, salesId);
  const sentBefore = received.length;
  await deliverDue(Date.now() + 10_000, Date.now() + 86_400_000);
  view = await webhooksView(one);
  is("its waiting delivery fails without a request", [view.log[0].state, view.log[0].lastError, received.length], ["failed", "The endpoint was removed.", sentBefore]);

  part("One store cannot reach another's");
  one = (await storeForEmail("one@example.com"))!;
  const refundsId = refunds.view.endpoints.find((e) => e.where.endsWith("/refunds"))!.id;
  is("the other store sees no endpoint and no delivery", [(await webhooksView(two)).endpoints.length, (await webhooksView(two)).log.length], [0, 0]);
  is("nor can it change one", await setEndpointEvents(two, refundsId, ["sale.completed"]), "missing");
  await removeEndpoint(two, refundsId);
  is("nor remove one", (await webhooksView(one)).endpoints.some((e) => e.id === refundsId), true);
  is("nor test one", await sendTest(two, refundsId), { ok: false, reason: "missing" });
  is("the same seed is a different event in each store", eventIdFor(one.statsId!, "sale.completed", "x") === eventIdFor(two.statsId!, "sale.completed", "x"), false);

  part("Test messages, ten a minute");
  const tests = [];
  for (let i = 0; i < 11; i += 1) tests.push(await sendTest(one, refundsId));
  is("ten are sent, the eleventh waits", [tests.slice(0, 10).every((t) => t.ok), tests[10]], [true, { ok: false, reason: "limited" }]);
  const test = received.at(-1)!;
  is("a test says it is one, signed like the rest", [test.headers["marktmorgen-event-type"], verify(refunds.secret, String(test.headers["marktmorgen-signature"]), test.body)], ["test", true]);

  part("Every try is one of the month's webhook deliveries");
  const sentSoFar = received.length;
  // What is left of the month, used, as a busy store would.
  for (;;) if (!(await takeAllowance(one, "webhook")).ok) break;
  const hook = await emitEvent(one, "refund.issued", "re_test_0099", { amount_cents: 100 });
  view = await webhooksView(one);
  is("past the figure a delivery is not tried, and says why", [hook, received.length, view.log[0].state, view.log[0].attempts, view.log[0].lastError.startsWith("Not sent. Your webhook deliveries for this month are used")], [0, sentSoFar, "failed", 0, true]);
  is("it is not tried again either", [(await deliverDue(Date.now() + 10_000, Date.now() + 86_400_000)).tried, received.length], [0, sentSoFar]);
  is("Store's figure is the one published", STORE_ALLOWANCES.creator.webhook > 0, true);

  part("A funded manual test needs its resource cohort before dispatch");
  await claimHandle("funded-hook@example.com", "funded-hook-shop", "Funded Hook Shop", "");
  await ensureStatsId("funded-hook@example.com");
  const retainedOwner = (await storeForEmail("funded-hook@example.com"))!;
  const added = await addEndpoint(retainedOwner, "https://hooks.example.com/funded", ["sale.completed", "refund.issued"]);
  if (!added.ok) throw new Error("retained endpoint not added");
  const endpointId = added.view.endpoints[0].id;
  await setSubscription("funded-hook@example.com", { customerId: "cus_HookFunded001", subscriptionId: "sub_HookFunded001", active: true, period: { ...paidPeriod(), funded: true } });
  const funded = (await storeForEmail("funded-hook@example.com"))!;
  const endpointsBefore = (await webhooksView(funded)).endpoints;
  const refusedEndpoint = await addEndpoint(funded, "https://hooks.example.com/new-funded", ["sale.completed"]);
  is("new funded endpoint requires the resource cohort", !refusedEndpoint.ok && refusedEndpoint.reason, "unavailable");
  is("no endpoint or secret is persisted on refusal", (await webhooksView(funded)).endpoints, endpointsBefore);
  const duplicate = await addEndpoint(funded, "https://hooks.example.com/funded", ["sale.completed"]);
  is("an existing endpoint stays an explicit duplicate", !duplicate.ok && duplicate.reason, "duplicate");
  is("adding another event needs new cohort approval", await setEndpointEvents(funded, endpointId, ["sale.completed", "refund.issued", "membership.started"]), "unavailable");
  is("failed event expansion retains the exact endpoint configuration", (await webhooksView(funded)).endpoints, endpointsBefore);
  const reduced = await setEndpointEvents(funded, endpointId, ["sale.completed"]);
  if (typeof reduced === "string") throw new Error("retained event removal refused");
  is("removing an existing event remains available", reduced.endpoints[0].events, ["sale.completed"]);
  const repeated = await setEndpointEvents(funded, endpointId, ["sale.completed"]);
  is("keeping the same events creates no new funding obligation", typeof repeated !== "string", true);
  is("putting a removed event back requires new approval", await setEndpointEvents(funded, endpointId, ["sale.completed", "refund.issued"]), "unavailable");
  is("the removed event stays removed after refusal", (await webhooksView(funded)).endpoints[0].events, ["sale.completed"]);
  const beforeFunded = received.length;
  const beforeUnits = await allowanceUsed(funded, "webhook");
  const beforeLog = (await webhooksView(funded)).log;
  is("missing financial approval refuses an actual manual test", await sendTest(funded, endpointId), { ok: false, reason: "unavailable" });
  is("no request, delivery log or webhook allowance is consumed", [received.length, await allowanceUsed(funded, "webhook"), (await webhooksView(funded)).log], [beforeFunded, beforeUnits, beforeLog]);
  await removeEndpoint(funded, endpointId);
  is("removing the endpoint remains available", (await webhooksView(funded)).endpoints.length, 0);

  server.close();
  done();
}

main().catch((error) => {
  console.error(error);
  server.close();
  process.exit(1);
});
