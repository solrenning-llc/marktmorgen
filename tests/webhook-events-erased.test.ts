/**
 * The store's recent webhook messages (GET /api/v1/events, lib/webhooks.ts recentMessagesOf; what Zapier shows as a
 * sample) after a person in them was deleted from the store (Claude 7's webhook hunt, 14 November 2026; synthetic
 * only). lib/person-data.ts says a webhook's message is "never acted on for a deleted address"; before this, the
 * read handed the deleted buyer's address back for the week the delivery is kept. Now a message naming a deleted
 * person is left out, and deletion marks that cannot be read are never "not deleted": the read is unreadable.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { DeliveriesUnreadable, addEndpoint, deliverDue, emitEvent, recentMessages, setSendHooksForTests } from "@/lib/webhooks";
import { eventsWork } from "@/lib/api-read-rules";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { erasePerson } from "@/lib/person-erasure";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const server = http.createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    response.writeHead(200);
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
let breakErasedReads = false;
let commandsSent = 0;
let counting = false;
redis.pipeline = async (commands: (string | number)[][]) => {
  if (counting) commandsSent += commands.length;
  const [only] = commands;
  if (commands.length === 1 && only[0] === "EVAL" && String(only[1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) {
    const [, , , key, member, now, until] = only.map(String);
    const [due] = await original([["ZSCORE", key, member]]);
    if (due === null || due === undefined || Number(due) > Number(now)) return [0];
    await original([["ZADD", key, Number(until), member]]);
    return [1];
  }
  if (breakErasedReads && commands.some((c) => c[0] === "HMGET" && String(c[1]).startsWith("nl:erased:"))) {
    return commands.map(() => ({ result: "?" }));
  }
  return original(commands);
};

const names = (messages: Record<string, unknown>[], email: string) => messages.filter((m) => JSON.stringify(m).includes(email)).length;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never } });
  await claimHandle("ev-owner@example.com", "ev-store", "Event Store", "");
  await ensureStatsId("ev-owner@example.com");
  await setSubscription("ev-owner@example.com", { customerId: "cus_EvOwner000001", subscriptionId: "sub_EvOwner000001", active: true, period: paidPeriod() });
  let store = (await storeForEmail("ev-owner@example.com"))!;
  const added = await addEndpoint(store, "https://hooks.example.com/sales", ["sale.completed"]);
  if (!added.ok) throw new Error("not added");
  const when = Date.now();
  for (const [seed, email] of [["cs_ev_0001", "gone@example.com"], ["cs_ev_0002", "kept@example.com"]]) {
    await emitEvent(store, "sale.completed", seed, { amount_cents: 4900, buyer: { email, name: null } }, when);
  }
  await deliverDue(when + 60_000, when);

  part("Before the deletion, both sales are in the store's recent messages");
  const before = await recentMessages(store, "sale.completed", 10);
  is("both buyers are there", [names(before, "gone@example.com"), names(before, "kept@example.com")], [1, 1]);

  part("After it, the deleted buyer's message is left out");
  const erased = await erasePerson(store, "gone@example.com", { kind: "person" });
  is("the person is deleted from the store", erased.ok, true);
  store = (await storeForEmail("ev-owner@example.com"))!;
  counting = true;
  const after = await recentMessages(store, "sale.completed", 10);
  counting = false;
  is("the deleted buyer's address is not handed back", names(after, "gone@example.com"), 0);
  is("the other buyer's message still is", names(after, "kept@example.com"), 1);
  const priced = eventsWork({ deliveries: 2, bytes: 0, sent: 0 }).commands;
  is(`the read's commands, the deletion check included, are inside what it is priced at (${commandsSent} sent, ${priced} priced; the log read here is priced in the probe)`, commandsSent <= priced, true);

  part("Deletion marks that cannot be read are never \"not deleted\"");
  breakErasedReads = true;
  const unread = await recentMessages(store, "sale.completed", 10).then(
    () => "read",
    (error: unknown) => (error instanceof DeliveriesUnreadable ? "unreadable" : String(error)),
  );
  breakErasedReads = false;
  is("the read is unreadable, never a history without the check", unread, "unreadable");

  server.close();
  done();
}
void main();
