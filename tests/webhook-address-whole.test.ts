/**
 * The whole address a webhook message names, as erasePerson and Stripe accept it (lib/webhooks.ts, addressesIn; Claude 1
 * cloud R's MEDIUM on #4562): an apostrophe in the local part, a punycode top-level domain and a non-ASCII domain were cut
 * or missed, so the deletion mark was not found, a retry posted the deleted address again and the recent events handed
 * it back. A variant more is asked about, never one fewer. Synthetic only: a local server, the in-memory database.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { RETRY_MINUTES, addEndpoint, addressesIn, deliverDue, emitEvent, recentMessages, setSendHooksForTests } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { erasePerson } from "@/lib/person-erasure";
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
const of = (email: string) => addressesIn(JSON.stringify({ id: "evt_x", type: "sale.completed", data: { buyer: { email } } }));
const sentTo = (email: string) => received.filter((body) => body.includes(email)).length;

async function main(): Promise<void> {
  part("addressesIn finds the whole address a buyer field holds");
  is("RED: an apostrophe in the local part", of("O'Brien@Example.com").includes("o'brien@example.com"), true);
  is("RED: a punycode top-level domain", of("pat@shop.xn--p1ai").includes("pat@shop.xn--p1ai"), true);
  is("RED: a non-ASCII domain", of("pat@bücher.de").includes("pat@bücher.de"), true);

  redis.clear();
  console.error = () => {};
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never } });
  await claimHandle("ap-owner@example.com", "ap-store", "Ap Store", "");
  await ensureStatsId("ap-owner@example.com");
  await setSubscription("ap-owner@example.com", { customerId: "cus_ApOwner000001", subscriptionId: "sub_ApOwner000001", active: true, period: paidPeriod() });
  let store = (await storeForEmail("ap-owner@example.com"))!;
  const added = await addEndpoint(store, "https://hooks.example.com/sales", ["sale.completed"]);
  if (!added.ok) throw new Error("not added");
  let when = Date.now();
  answers.push(500);
  await emitEvent(store, "sale.completed", "cs_ap_0001", { amount_cents: 4900, buyer: { email: "O'Brien@Example.com", name: null } }, when);
  await deliverDue(when + 60_000, when);
  part("A retry and the recent events after o'brien@example.com is deleted");
  is("the first try went out, before the deletion", sentTo("O'Brien@Example.com"), 1);
  const erased = await erasePerson(store, "o'brien@example.com", { kind: "person" });
  is("the person is deleted from the store", erased.ok, true);
  store = (await storeForEmail("ap-owner@example.com"))!;
  when += RETRY_MINUTES[0] * 60_000 + 1000;
  await deliverDue(when + 60_000, when);
  is("RED: no retry sent the deleted address", sentTo("O'Brien@Example.com"), 1);
  const after = await recentMessages(store, "sale.completed", 10);
  is("RED: the recent events do not hand it back", after.filter((m) => JSON.stringify(m).includes("O'Brien@Example.com")).length, 0);
  server.close();
  done();
}
void main();
