/**
 * A webhook delivery waiting for its next try when the creator stops the endpoint hearing that event
 * (webhooks/cron audit, Claude 1, 12/11/2026). The scheduled tries (lib/webhooks.ts, runClaimed) checked only that
 * the endpoint still exists, so a sale's message, with the buyer's name and email, went on being posted to an
 * address the creator had unsubscribed from that event, for up to six more tries over about 40 hours, each taking
 * one of the month's deliveries. A resend by hand already refuses it ("not_heard"). Now a scheduled try refuses it
 * the same way: failed with the reason, the endpoint not called, nothing of the month taken.
 * Delivered to a real local HTTP server through lib/safe-fetch.ts; synthetic data only.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { RETRY_MINUTES, addEndpoint, deliverDue, emitEvent, setEndpointEvents, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Received = { headers: http.IncomingHttpHeaders; body: string };
const received: Received[] = [];
const answers: number[] = [];
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk.toString()));
  request.on("end", () => {
    received.push({ headers: request.headers, body });
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

// The webhook queue's lease script, modelled as Redis runs it (as in tests/webhooks-delivery.test.ts).
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
  await claimHandle("unheard@example.com", "unheard-shop", "Unheard Shop", "");
  await ensureStatsId("unheard@example.com");
  await setSubscription("unheard@example.com", { customerId: "cus_Unheard00001", subscriptionId: "sub_Unheard00001", active: true, period: paidPeriod() });
  const one = (await storeForEmail("unheard@example.com"))!;
  const added = await addEndpoint(one, "https://hooks.example.com/sales", ["sale.completed", "refund.issued"]);
  if (!added.ok) throw new Error("not added");
  const endpointId = (await webhooksView(one)).endpoints[0].id;

  part("A sale's delivery fails its first try and waits for the next");
  answers.push(500);
  await emitEvent(one, "sale.completed", "cs_unheard_0001", { amount_cents: 100, buyer: { name: "Ana Buyer", email: "ana-buyer@example.com" } });
  let when = Date.now() + 1_000;
  await deliverDue(Date.now() + 10_000, when);
  const first = (await webhooksView(one)).log[0];
  is("set-up: tried once, waiting to be tried again", [received.length, first?.state], [1, "retrying"]);

  part("The creator stops the endpoint hearing sales");
  const changed = await setEndpointEvents(one, endpointId, ["refund.issued"]);
  is("set-up: the endpoint now hears refunds only", typeof changed === "object" && changed.endpoints[0].events, ["refund.issued"]);
  const used = await allowanceUsed(one, "webhook");
  for (const minutes of RETRY_MINUTES) {
    when += minutes * 60_000 + 1_000;
    await deliverDue(Date.now() + 10_000, when);
  }
  const after = (await webhooksView(one)).log.find((d) => d.id === first.id);
  is("the sale is never posted to it again", received.length, 1);
  is("nothing more of the month is taken", await allowanceUsed(one, "webhook"), used);
  is("the delivery is failed, saying why", [after?.state, /no longer hears/i.test(after?.lastError ?? "")], ["failed", true]);

  part("Control: an event the endpoint still hears is tried again as before");
  answers.push(500, 200);
  await emitEvent(one, "refund.issued", "re_unheard_0001", { amount_cents: 100 });
  when += 1_000;
  await deliverDue(Date.now() + 10_000, when);
  when += RETRY_MINUTES[0] * 60_000 + 1_000;
  await deliverDue(Date.now() + 10_000, when);
  const refund = (await webhooksView(one)).log.find((d) => d.type === "refund.issued");
  is("the refund is delivered on its second try", [received.length, refund?.state], [3, "delivered"]);
  server.close();
  done();
}

main();
