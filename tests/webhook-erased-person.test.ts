/**
 * A webhook delivery still being tried, or sent again by hand, about a person deleted from the store since it was
 * made (Claude 7, webhook hunt, 14 November 2026; synthetic only, a local HTTP server through lib/safe-fetch.ts).
 * lib/person-data.ts says a webhook's message is "never acted on for a deleted address"; before this, a delivery
 * whose first try failed kept posting the deleted buyer's address on every retry, for about forty hours, and a
 * delivery failed for good could be resent with it by hand. Now each try reads the store's deletion marks
 * (lib/suppression.ts) for the addresses in its message first: a deleted one is never sent, its message is not kept,
 * and a mark that cannot be read waits like a network failure, never read as "not deleted".
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { MAX_ATTEMPTS, RETRY_MINUTES, addEndpoint, deliverDue, emitEvent, resendDelivery, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { erasePerson } from "@/lib/person-erasure";
import { suppressedKey, suppressionPrint } from "@/lib/suppression";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { TAKE_COMMANDS } from "./plan-cost-registry";

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

// The webhook queue's lease script, modelled as Redis runs it (as in tests/webhooks-delivery.test.ts).
const original = redis.pipeline.bind(redis);
let breakErasedReads = false;
let counting = false;
let counted = 0;
redis.pipeline = async (commands: (string | number)[][]) => {
  if (counting) counted += commands.length;
  const [only] = commands;
  if (commands.length === 1 && only[0] === "EVAL" && String(only[1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) {
    const [, , , key, member, now, until] = only.map(String);
    const [due] = await original([["ZSCORE", key, member]]);
    if (due === null || due === undefined || Number(due) > Number(now)) return [0];
    await original([["ZADD", key, Number(until), member]]);
    return [1];
  }
  if (breakErasedReads && commands.some((c) => c[0] === "HMGET" && String(c[1]).startsWith("nl:erased:"))) {
    return commands.map((c) => (c[0] === "HMGET" && String(c[1]).startsWith("nl:erased:") ? { result: "?" } : null));
  }
  return original(commands);
};

const sentTo = (email: string) => received.filter((body) => body.includes(email)).length;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never } });
  await claimHandle("hk-owner@example.com", "hk-store", "Hook Store", "");
  await ensureStatsId("hk-owner@example.com");
  await setSubscription("hk-owner@example.com", { customerId: "cus_HkOwner000001", subscriptionId: "sub_HkOwner000001", active: true, period: paidPeriod() });
  let store = (await storeForEmail("hk-owner@example.com"))!;
  const added = await addEndpoint(store, "https://hooks.example.com/sales", ["sale.completed"]);
  if (!added.ok) throw new Error("not added");
  let when = Date.now();
  // One clock for the tries and for Redis's (the stand-in's TIME is Date.now), so a deletion's second and a message's
  // time compare as they would on one server: the tries below move hours ahead of the wall clock.
  Date.now = () => when;
  const nextTry = async (minutes: number) => {
    when += minutes * 60_000 + 1000;
    await deliverDue(when + 60_000, when);
  };

  part("A retry about a person deleted since the first try is never sent");
  answers.push(500);
  await emitEvent(store, "sale.completed", "cs_hk_0001", { amount_cents: 4900, buyer: { email: "gone@example.com", name: null } }, when);
  await deliverDue(when + 60_000, when);
  is("the first try went out with the address, before the deletion", sentTo("gone@example.com"), 1);
  const erased = await erasePerson(store, "gone@example.com", { kind: "person" });
  is("the person is deleted from the store", erased.ok, true);
  store = (await storeForEmail("hk-owner@example.com"))!;
  for (const minutes of RETRY_MINUTES) await nextTry(minutes);
  is("no retry sent the deleted address", sentTo("gone@example.com"), 1);

  part("A delivery failed for good is not resent by hand with a deleted address");
  answers.push(...Array.from({ length: MAX_ATTEMPTS }, () => 500));
  await emitEvent(store, "sale.completed", "cs_hk_0002", { amount_cents: 4900, buyer: { email: "later@example.com", name: null } }, when);
  await deliverDue(when + 60_000, when);
  for (const minutes of RETRY_MINUTES) await nextTry(minutes);
  is("it was tried every time before the deletion", sentTo("later@example.com"), MAX_ATTEMPTS);
  const failed = (await webhooksView(store)).log.find((d) => d.state === "failed" && d.attempts === MAX_ATTEMPTS);
  is("it failed for good", Boolean(failed), true);
  await erasePerson(store, "later@example.com", { kind: "person" });
  store = (await storeForEmail("hk-owner@example.com"))!;
  if (failed) await resendDelivery(store, failed.id, when + 1000);
  is("the resend did not send the deleted address", sentTo("later@example.com"), MAX_ATTEMPTS);

  part("Someone not deleted is still retried and sent");
  answers.push(500);
  await emitEvent(store, "sale.completed", "cs_hk_0003", { amount_cents: 4900, buyer: { email: "kept@example.com", name: null } }, when);
  await deliverDue(when + 60_000, when);
  await nextTry(RETRY_MINUTES[0]);
  is("the retry went out", sentTo("kept@example.com"), 2);

  part("A try's commands stay inside the registry's line for a webhook's try");
  answers.push(500);
  await emitEvent(store, "sale.completed", "cs_hk_0005", { amount_cents: 4900, buyer: { email: "count@example.com", name: null } }, when);
  await deliverDue(when + 60_000, when);
  counting = true;
  await nextTry(RETRY_MINUTES[0]);
  counting = false;
  is("the retry went out", sentTo("count@example.com"), 2);
  is(`one try, the deletion check included, sends at most 20 + TAKE_COMMANDS commands (${counted} sent)`, counted <= 20 + TAKE_COMMANDS, true);

  part("A deletion mark that cannot be read is never read as \"not deleted\"");
  answers.push(500);
  await emitEvent(store, "sale.completed", "cs_hk_0004", { amount_cents: 4900, buyer: { email: "unsure@example.com", name: null } }, when);
  await deliverDue(when + 60_000, when);
  breakErasedReads = true;
  await nextTry(RETRY_MINUTES[0]);
  breakErasedReads = false;
  is("the retry did not go out while the mark was unread", sentTo("unsure@example.com"), 1);
  await nextTry(RETRY_MINUTES[1]);
  is("it is sent at the next try, once the mark reads", sentTo("unsure@example.com"), 2);

  part("A person deleted and back since is told of what they did after it (MQ-PRE on #4555)");
  await erasePerson(store, "back@example.com", { kind: "person" });
  store = (await storeForEmail("hk-owner@example.com"))!;
  // A new sale made after the deletion, two seconds past it on any clock.
  const after = when + 2000;
  await emitEvent(store, "sale.completed", "cs_hk_0006", { amount_cents: 4900, buyer: { email: "back@example.com", name: null } }, after);
  await deliverDue(after + 60_000, after);
  is("the sale made after the deletion is sent", sentTo("back@example.com"), 1);

  part("A deletion mark that does not read as a second holds the delivery, and one from before it lets it go");
  if (!store.listId) throw new Error("no list");
  const odd = "odd@example.com";
  await original([["HSET", suppressedKey(store.listId), suppressionPrint(store.listId, odd), "soon"]]);
  await emitEvent(store, "sale.completed", "cs_hk_0007", { amount_cents: 4900, buyer: { email: odd, name: null } }, when);
  await deliverDue(when + 60_000, when);
  is("a mark that is not a second sends nothing", sentTo(odd), 0);
  await original([["HSET", suppressedKey(store.listId), suppressionPrint(store.listId, odd), 0]]);
  await nextTry(RETRY_MINUTES[0]);
  is("a mark from before the sale lets it go at the next try", sentTo(odd), 1);

  server.close();
  done();
}
void main();
