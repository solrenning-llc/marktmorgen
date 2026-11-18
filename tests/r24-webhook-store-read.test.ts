/**
 * A webhook delivery whose store cannot be read just now (lib/webhooks.ts, runClaimed; CX-123 rule 24).
 *
 * Before: the store was read with `storeForHandle(...).catch(() => null)`, so a Redis call that timed out or failed
 * was taken for "the store could not be found", and the delivery (a paid sale.completed among them) was marked
 * failed for good and taken off the queue: never tried again, though nothing was wrong with the store or the
 * endpoint. Now a store that cannot be read is unknown: the delivery stays on the queue under its lease, is tried
 * again when the lease ends, and is delivered once the store reads. A store that is really gone is still failed.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts), a local HTTP server behind lib/safe-fetch.ts.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { RETRY_MINUTES, addEndpoint, deliverDue, emitEvent, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const received: string[] = [];
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

/** The queue's lease (LEASE_SCRIPT), as Redis runs it; and, while `failHandleReads` is above zero, the store's handle read fails as a timeout would. */
const original = redis.pipeline.bind(redis);
let failHandleReads = 0;
redis.pipeline = async (commands: (string | number)[][]) => {
  const [only] = commands;
  if (commands.length === 1 && only[0] === "EVAL" && String(only[1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) {
    const [, , , key, member, now, until] = only.map(String);
    const [due] = await original([["ZSCORE", key, member]]);
    if (due === null || due === undefined || Number(due) > Number(now)) return [0];
    await original([["ZADD", key, Number(until), member]]);
    return [1];
  }
  if (failHandleReads > 0 && commands.length === 1 && only[0] === "GET" && String(only[1]).startsWith("nl:store:handle:")) {
    failHandleReads -= 1;
    throw new Error("Redis request timed out");
  }
  return original(commands);
};

const LEASE_MS = 10 * 60 * 1000;

async function main(): Promise<void> {
  redis.clear();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never } });

  await claimHandle("hook-read@example.com", "hook-read-shop", "Hook Read Shop", "");
  await ensureStatsId("hook-read@example.com");
  await setSubscription("hook-read@example.com", { customerId: "cus_HookRead0001", subscriptionId: "sub_HookRead0001", active: true, period: paidPeriod() });
  const store = (await storeForEmail("hook-read@example.com"))!;
  const added = await addEndpoint(store, "https://hooks.example.com/sales", ["sale.completed"]);
  if (!added.ok) throw new Error("not added");
  const line = async () => (await webhooksView(store)).log[0];
  const queued = async () => ((await original([["ZRANGEBYSCORE", "nl:hooks:q", "-inf", "+inf"]]))[0] as string[]).length;

  part("A retry whose store read times out is not failed for good");
  answers.push(500);
  const t0 = Date.now();
  is("the first try is made and answered 500", [await emitEvent(store, "sale.completed", "cs_test_storeread01", { amount_cents: 6900 }, t0), received.length], [1, 1]);
  is("it waits for its retry", (await line())?.state, "retrying");
  const usedBefore = await allowanceUsed(store, "webhook");

  const retryAt = t0 + RETRY_MINUTES[0] * 60_000 + 1000;
  failHandleReads = 1;
  await deliverDue(Date.now() + 10_000, retryAt);
  is("the store's read failed once", failHandleReads, 0);
  const afterBlip = await line();
  is("the delivery is not marked failed on an unknown store read", afterBlip?.state, "retrying");
  is("nor given the words of a store that is gone", afterBlip?.lastError === "The store could not be found.", false);
  is("it stays on the queue", await queued(), 1);
  is("nothing was sent and no delivery of the month taken", [received.length, await allowanceUsed(store, "webhook")], [1, usedBefore]);

  is("not tried again before its lease ends", (await deliverDue(Date.now() + 10_000, retryAt + 1000)).tried, 0);
  const later = retryAt + LEASE_MS + 1000;
  is("once the store reads, it is tried and delivered", await deliverDue(Date.now() + 10_000, later), { tried: 1, delivered: 1 });
  is("delivered once", [(await line())?.state, received.length, await queued()], ["delivered", 2, 0]);

  part("The first try, made at once, whose store read times out");
  const t1 = Date.now();
  failHandleReads = 1;
  await emitEvent(store, "sale.completed", "cs_test_storeread02", { amount_cents: 6900 }, t1);
  is("the store's read failed once", failHandleReads, 0);
  is("not marked failed: still queued", [(await line())?.state, await queued(), received.length], ["queued", 1, 2]);
  is("tried again when the lease ends, and delivered", await deliverDue(Date.now() + 10_000, Date.now() + LEASE_MS + 1000), { tried: 1, delivered: 1 });
  is("delivered", [(await line())?.state, received.length], ["delivered", 3]);

  part("A store that is really gone is still failed, at once");
  answers.push(500);
  const t2 = Date.now();
  await emitEvent(store, "sale.completed", "cs_test_storeread03", { amount_cents: 6900 }, t2);
  is("waiting for its retry", (await line())?.state, "retrying");
  await original([["DEL", "nl:store:handle:hook-read-shop"]]);
  await deliverDue(Date.now() + 10_000, t2 + RETRY_MINUTES[0] * 60_000 + 1000);
  const gone = await line();
  is("failed with the words of a store that is gone, and off the queue", [gone?.state, gone?.lastError, await queued()], ["failed", "The store could not be found.", 0]);

  server.close();
  done();
}

main().catch((error) => {
  console.error(error);
  server.close();
  process.exit(1);
});
