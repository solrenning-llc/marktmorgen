/**
 * A store's webhook settings read exactly (lib/webhooks.ts, readConfig; CX-123 rule 24).
 *
 * Before: a GET answered cut short or in another shape was parsed as "no settings", so (1) emitEvent made nothing
 * and said so (0), the paid sale's event lost; (2) a delivery due again was failed for good as "no endpoint"; and
 * (3) the Stripe pass took the store out of its set (SREM), so its Stripe events were never read again. Now such a
 * reply is unknown: the event throws for the caller's retry, the delivery stays under its lease and the store stays
 * in the set.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts), a local HTTP server behind lib/safe-fetch.ts.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { RETRY_MINUTES, addEndpoint, deliverDue, emitEvent, setSendHooksForTests, watchStripe, webhooksView } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
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

/** The queue's lease (LEASE_SCRIPT), as Redis runs it; and, while `badConfigReads` is above zero, the settings' GET answers `badReply`. */
const original = redis.pipeline.bind(redis);
let badConfigReads = 0;
let badReply: unknown[] = [];
redis.pipeline = async (commands: (string | number)[][]) => {
  const [only] = commands;
  if (commands.length === 1 && only[0] === "EVAL" && String(only[1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) {
    const [, , , key, member, now, until] = only.map(String);
    const [due] = await original([["ZSCORE", key, member]]);
    if (due === null || due === undefined || Number(due) > Number(now)) return [0];
    await original([["ZADD", key, Number(until), member]]);
    return [1];
  }
  if (badConfigReads > 0 && commands.length === 1 && only[0] === "GET" && String(only[1]).startsWith("nl:hooks:cfg:")) {
    badConfigReads -= 1;
    return badReply;
  }
  return original(commands);
};

const LEASE_MS = 10 * 60 * 1000;

async function main(): Promise<void> {
  redis.clear();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never } });

  await claimHandle("hook-cfg@example.com", "hook-cfg-shop", "Hook Cfg Shop", "");
  await ensureStatsId("hook-cfg@example.com");
  await setSubscription("hook-cfg@example.com", { customerId: "cus_HookCfg00001", subscriptionId: "sub_HookCfg00001", active: true, period: paidPeriod() });
  const store = (await storeForEmail("hook-cfg@example.com"))!;
  const added = await addEndpoint(store, "https://hooks.example.com/sales", ["sale.completed", "refund.created"]);
  if (!added.ok) throw new Error("not added");
  const line = async () => (await webhooksView(store)).log[0];
  const queued = async () => ((await original([["ZRANGEBYSCORE", "nl:hooks:q", "-inf", "+inf"]]))[0] as string[]).length;

  for (const [label, reply] of [["no reply", []], ["a number", [7]], ["two replies", [null, null]]] as [string, unknown[]][]) {
    part(`A sale's event, the settings read as ${label}`);
    badReply = reply;
    badConfigReads = 1;
    const seed = `cs_test_cfgread_${label.replace(/\W/g, "")}`;
    const outcome = await emitEvent(store, "sale.completed", seed, { amount_cents: 6900 }).then(
      (n) => `made ${n}`,
      () => "threw",
    );
    is("unknown, never \"no endpoint listens\"", outcome, "threw");
    is("and made again once the settings read", await emitEvent(store, "sale.completed", seed, { amount_cents: 6900 }), 1);
  }

  part("A delivery due again, the settings read cut short");
  answers.push(500);
  const before = received.length;
  const t0 = Date.now();
  await emitEvent(store, "sale.completed", "cs_test_cfgread_retry", { amount_cents: 6900 }, t0);
  is("it waits for its retry", (await line())?.state, "retrying");
  badReply = [];
  badConfigReads = 1;
  const retryAt = t0 + RETRY_MINUTES[0] * 60_000 + 1000;
  await deliverDue(Date.now() + 10_000, retryAt);
  is("not failed for good", (await line())?.state, "retrying");
  is("it stays on the queue", await queued(), 1);
  is("delivered once the lease ends and the settings read", await deliverDue(Date.now() + 10_000, retryAt + LEASE_MS + 1000), { tried: 1, delivered: 1 });
  is("sent twice in all (the 500, then the delivery)", received.length - before, 2);

  part("The Stripe pass, the settings read cut short");
  const statsId = store.statsId!;
  await original([["SADD", "nl:hooks:stores", statsId]]);
  badReply = [];
  badConfigReads = 1;
  await watchStripe(Date.now() + 10_000).catch(() => null);
  is("the store stays in the set its Stripe events are read from", (await original([["SISMEMBER", "nl:hooks:stores", statsId]]))[0], 1);

  server.close();
  done();
}

main().catch((error) => {
  console.error(error);
  server.close();
  process.exit(1);
});
