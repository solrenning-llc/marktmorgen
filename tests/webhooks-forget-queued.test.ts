/**
 * A store's buyers' data does not outlive its webhooks (lib/webhooks.ts,
 * forgetStoreWebhooks and removeEndpoint; retention in lib/data-families.ts,
 * "nl:hooks:d:"). forgetStoreWebhooks deletes the deliveries its log names,
 * at most LOG_SIZE; older ones still waiting for a try stay on the queue. At
 * their next try the endpoint is gone (its config deleted, or the endpoint
 * removed), and the failed delivery was written back with its whole message,
 * buyers' names and addresses included, for DELIVERY_SECONDS more. Checked
 * here, with the endpoint answering 500 so every delivery waits for a retry:
 *
 *   - after a store's webhooks are forgotten and its waiting deliveries are
 *     tried, no delivery kept anywhere holds a buyer's address, and none of
 *     the store's deliveries is left on the queue;
 *   - after an endpoint is removed, the same: its waiting deliveries fail
 *     without a request and keep no message.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { LOG_SIZE, QUEUE_KEY, RETRY_MINUTES, addEndpoint, deliverDue, emitEvent, forgetStoreWebhooks, removeEndpoint, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let requests = 0;
const server = http.createServer((request, response) => {
  request.on("data", () => undefined);
  request.on("end", () => {
    requests += 1;
    response.writeHead(500);
    response.end("down");
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

/** The queue's lease (LEASE_SCRIPT), as Redis runs it: taken only when the delivery is on the queue and due. */
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

const EVENTS = LOG_SIZE + 10;
const buyerEmail = (shop: string, n: number) => `buyer-${shop}-${n}@buyers.example.org`;

/** The delivery keys whose kept text names one of this shop's buyers. */
async function keptWithBuyers(shop: string): Promise<string[]> {
  const keys = redis.keys().filter((key) => key.startsWith("nl:hooks:d:"));
  const values = keys.length ? await original(keys.map((key) => ["GET", key])) : [];
  return keys.filter((_, at) => typeof values[at] === "string" && (values[at] as string).includes(`buyer-${shop}-`));
}

async function queuedOf(statsId: string): Promise<string[]> {
  const [members] = await original([["ZRANGEBYSCORE", QUEUE_KEY, "-inf", "+inf"]]);
  return (members as string[]).filter((member) => member.startsWith(`${statsId}|`));
}

async function paidStoreWithEndpoint(shop: string) {
  const email = `${shop}@example.com`;
  await claimHandle(email, shop, `Shop ${shop}`, "");
  await ensureStatsId(email);
  await setSubscription(email, { customerId: `cus_${shop.replace(/-/g, "")}0001`, subscriptionId: `sub_${shop.replace(/-/g, "")}0001`, active: true, period: paidPeriod() });
  const store = (await storeForEmail(email))!;
  const added = await addEndpoint(store, `https://hooks.example.com/${shop}`, ["sale.completed"]);
  if (!added.ok) throw new Error("endpoint not added");
  for (let n = 0; n < EVENTS; n += 1) {
    await emitEvent(store, "sale.completed", `cs_test_${shop}_${n}`, { buyer: { email: buyerEmail(shop, n), name: `Buyer ${n}` }, amount_cents: 1_000 });
  }
  return { store, endpointId: added.view.endpoints[0].id };
}

async function main(): Promise<void> {
  redis.clear();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never } });
  // Past the longest wait between two tries, so every waiting delivery is due.
  const later = () => Date.now() + (Math.max(...RETRY_MINUTES) + 5) * 60_000;

  part("A forgotten store's waiting deliveries keep no buyer data");
  const forgotten = await paidStoreWithEndpoint("forget-shop");
  is("every event was tried once and waits for a retry", [requests, (await webhooksView(forgotten.store)).log.every((d) => d.state === "retrying")], [EVENTS, true]);
  is("more deliveries wait than the log names", (await queuedOf(forgotten.store.statsId!)).length, EVENTS);
  await forgetStoreWebhooks(forgotten.store.statsId);
  const sentBeforeForget = requests;
  await deliverDue(Date.now() + 30_000, later());
  is("nothing more is sent on the store's behalf", requests, sentBeforeForget);
  is("none of its deliveries is left on the queue", await queuedOf(forgotten.store.statsId!), []);
  is("no delivery kept holds a buyer's address", await keptWithBuyers("forget-shop"), []);

  part("A removed endpoint's waiting deliveries keep no buyer data");
  const removed = await paidStoreWithEndpoint("remove-shop");
  await removeEndpoint(removed.store, removed.endpointId);
  const sentBeforeRemove = requests;
  await deliverDue(Date.now() + 30_000, later());
  const log = (await webhooksView(removed.store)).log;
  is("its waiting deliveries fail without a request", [requests, log.length, log.every((d) => d.state === "failed" && d.lastError === "The endpoint was removed.")], [sentBeforeRemove, LOG_SIZE, true]);
  is("none of them is left on the queue", await queuedOf(removed.store.statsId!), []);
  is("no delivery kept holds a buyer's address", await keptWithBuyers("remove-shop"), []);

  server.close();
  done();
}

main().catch((error) => {
  console.error(error);
  server.close();
  process.exit(1);
});
