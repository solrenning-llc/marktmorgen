/**
 * An endpoint that TOOK the message (answered 2xx) with a body above the read
 * cap is delivered once (Claude 5 outbound audit, 9 Nov 2026, MEDIUM 1). The
 * status is all a delivery needs; before, lib/safe-fetch.ts refused the whole
 * answer as too big while already holding the 2xx, so the delivery was
 * recorded as a failure and sent again on the retry schedule, up to seven
 * times: seven runs of the creator's automation at a receiver that does not
 * deduplicate (Zapier's Catch Hook, Make's webhook), seven of the month's
 * deliveries taken, and "failed" in the log for a delivery that was made.
 *
 * Same harness as tests/webhooks-delivery.test.ts: lib/safe-fetch.ts runs for
 * real, only the name lookup and the socket are redirected to a local server.
 * No request leaves the machine.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { MAX_ATTEMPTS, addEndpoint, deliverDue, emitEvent, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let received = 0;
let chunked = false;
const BIG = Buffer.alloc(20_000, 120); // 20 KB of "x": an HTML page, an n8n echo, a framework's debug page
const BIGGER = Buffer.alloc(200_000, 120); // read over several socket reads, so the streamed cap is the one that trips

const server = http.createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    received += 1;
    if (chunked) {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.write(BIGGER.subarray(0, 100_000));
      response.end(BIGGER.subarray(100_000));
    } else {
      response.writeHead(200, { "Content-Type": "text/html", "Content-Length": String(BIG.length) });
      response.end(BIG);
    }
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
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never } });

  await claimHandle("big@example.com", "big-shop", "Big Shop", "");
  await ensureStatsId("big@example.com");
  await setSubscription("big@example.com", { customerId: "cus_BigBody00001", subscriptionId: "sub_BigBody00001", active: true, period: paidPeriod() });
  const shop = (await storeForEmail("big@example.com"))!;
  const added = await addEndpoint(shop, "https://hooks.example.com/catch", ["sale.completed"]);
  if (!added.ok) throw new Error("endpoint not added");

  for (const mode of [false, true]) {
    chunked = mode;
    part(mode ? "2xx with a 200 KB chunked body (no Content-Length)" : "2xx with a 20 KB body and its Content-Length");
    const before = received;
    const usedBefore = await allowanceUsed(shop, "webhook");
    const event = mode ? "cs_test_bigbody0002" : "cs_test_bigbody0001";
    await emitEvent(shop, "sale.completed", event, { amount_cents: 4900 });
    await deliverDue(Date.now() + 10_000);
    let line = (await webhooksView(shop)).log[0];
    is("the first try is recorded as delivered (the endpoint answered 200)", [line.state, line.lastStatus], ["delivered", 200]);
    // Walk the whole retry schedule.
    for (let i = 1; i < MAX_ATTEMPTS + 2; i += 1) await deliverDue(Date.now() + 10_000, Date.now() + 3 * 86_400_000);
    line = (await webhooksView(shop)).log[0];
    is("the endpoint receives the message once, not once per retry", received - before, 1);
    is("one of the month's webhook deliveries, not seven", (await allowanceUsed(shop, "webhook")) - usedBefore, 1);
    is("its final state is delivered", line.state, "delivered");
  }
  server.close();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
