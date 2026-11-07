/**
 * Rule 24 (unknown is never "gone"): a webhook delivery waiting on the queue
 * whose store cannot be read at its try (a Redis timeout) is tried again on
 * the published schedule, never marked failed and taken off the queue, so the
 * creator's event is not lost. A store that is really gone still fails it.
 * Same machinery as tests/webhooks-delivery.test.ts: a local server behind
 * setSendHooksForTests, and the queue's lease modelled in the stub.
 */
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { QUEUE_KEY, RETRY_MINUTES, addEndpoint, deliverDue, emitEvent, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const received: string[] = [];
/** What the endpoint answers next; it answers 200 when nothing is queued. */
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

/** Every request leaves on a plain socket to the local server, whatever address was checked. */
class LocalAgent extends https.Agent {
  constructor(private port: number) {
    super({ keepAlive: false });
  }
  createConnection(): net.Socket {
    return net.connect(this.port, "127.0.0.1");
  }
}

const EMAIL = "unread@example.com";
const OWNER_KEY = "nl:store:owner:" + createHash("sha256").update("nimbus-store:" + EMAIL).digest("hex").slice(0, 40);
/** While on, a read of the store's own record times out. */
let ownerReadThrows = false;
let ownerReadsThrown = 0;

// The queue's lease (lib/webhooks.ts, LEASE_SCRIPT), as Redis runs it; and the store's record read failing on demand.
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
  if (ownerReadThrows && commands.some((c) => c[0] === "GET" && c[1] === OWNER_KEY)) {
    ownerReadsThrown += 1;
    throw new Error("Redis request timed out (test)");
  }
  return original(commands);
};

async function main(): Promise<void> {
  redis.clear();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never } });

  await claimHandle(EMAIL, "unread-shop", "Unread Shop", "");
  await ensureStatsId(EMAIL);
  await setSubscription(EMAIL, { customerId: "cus_HookUnread001", subscriptionId: "sub_HookUnread001", active: true, period: paidPeriod() });
  const shop = (await storeForEmail(EMAIL))!;
  const added = await addEndpoint(shop, "https://hooks.example.com/sales", ["sale.completed"]);
  if (!added.ok) throw new Error("not added");

  const queued = async (id: string) => (await redis.pipeline([["ZSCORE", QUEUE_KEY, `${shop.statsId}|${id}`]]))[0];
  const line = async (id: string) => (await webhooksView(shop)).log.find((d) => d.id === id)!;

  part("A delivery waiting for its next try");
  answers.push(500);
  await emitEvent(shop, "sale.completed", "cs_test_unread0001", { amount_cents: 6900 });
  const waiting = (await webhooksView(shop)).log[0];
  is("its first try failed and it waits on the queue", [waiting.state, waiting.attempts, (await queued(waiting.id)) !== null], ["retrying", 1, true]);

  part("Its store cannot be read at the next try");
  const sentBefore = received.length;
  let later = waiting.next + 1_000;
  ownerReadThrows = true;
  try {
    await deliverDue(Date.now() + 30_000, later);
  } finally {
    ownerReadThrows = false;
  }
  is("the store's record read timed out", ownerReadsThrown > 0, true);
  const unread = await line(waiting.id);
  is("the delivery is not failed: it waits to be tried again", unread.state, "retrying");
  is("it is still on the queue", (await queued(waiting.id)) !== null, true);
  is("it does not say the store could not be found", /could not be found/.test(unread.lastError), false);
  is("it says the store could not be read", /could not be read/.test(unread.lastError), true);
  is("nothing was sent, and no try was counted", [received.length - sentBefore, unread.attempts], [0, 1]);
  is(`tried again ${RETRY_MINUTES[1]} minutes later`, Math.round((unread.next - later) / 60_000), RETRY_MINUTES[1]);

  part("Read again, the event is sent: it was not lost");
  later = unread.next + 1_000;
  await deliverDue(Date.now() + 30_000, later);
  const sent = await line(waiting.id);
  is("delivered, sent once, taken off the queue", [sent.state, received.length - sentBefore, (await queued(waiting.id)) === null], ["delivered", 1, true]);

  part("A store that is really gone still fails its delivery");
  answers.push(500);
  await emitEvent(shop, "sale.completed", "cs_test_unread0002", { amount_cents: 6900 });
  const orphan = (await webhooksView(shop)).log.find((d) => d.state === "retrying")!;
  await redis.pipeline([["DEL", "nl:store:handle:unread-shop"]]);
  const sentBeforeGone = received.length;
  await deliverDue(Date.now() + 30_000, orphan.next + 1_000);
  const gone = await line(orphan.id);
  is("failed, said not found, off the queue, nothing sent", [gone.state, gone.lastError, (await queued(orphan.id)) === null, received.length - sentBeforeGone], ["failed", "The store could not be found.", true, 0]);
}

main()
  .then(() => {
    server.close();
    done();
  })
  .catch((error) => {
    console.error(error);
    server.close();
    process.exit(1);
  });
