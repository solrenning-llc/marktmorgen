/**
 * A payment provider's event about a payment made after its buyer's deletion (a person deleted, then back to buy
 * again) and the deletion check of every try (merge of main's #4562/#4555 into #3491, 15 November 2026; synthetic
 * only, a local HTTP server through lib/safe-fetch.ts).
 *
 * emitEvent reads the buyer's deletion print against the payment's time (paidBy, R38): deleted at or after the payment,
 * the event goes out with no address; deleted strictly before it, the buyer is named, a new purchase by a person who
 * came back. Each try then reads the prints again (namesErased): a refund, a dispute or a membership change names a
 * deleted person only when the payment it is about was made after the deletion, and only for that buyer's own
 * address; every other address, a mark written after the payment, a payment time that does not read, and a print
 * whose time does not read are held as main holds them.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { MAX_ATTEMPTS, RETRY_MINUTES, addEndpoint, deliverDue, emitEvent, recentMessages, resendDelivery, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { erasePerson } from "@/lib/person-erasure";
import { suppressCommand } from "@/lib/suppression";
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

// The webhook queue's lease script, modelled as Redis runs it (as in tests/webhook-erased-person.test.ts).
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

/** The bodies sent for one refund (its charge id), as the endpoint received them. */
const sentFor = (charge: string) => received.filter((body) => body.includes(`"${charge}"`));
const buyerSent = (charge: string) => sentFor(charge).map((body) => (JSON.parse(body) as { data: { buyer: { email: string | null } } }).data.buyer.email);

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never } });
  await claimHandle("pa-owner@example.com", "pa-store", "Paid Again", "");
  await ensureStatsId("pa-owner@example.com");
  await ensureListId("pa-owner@example.com");
  await setSubscription("pa-owner@example.com", { customerId: "cus_PaOwner000001", subscriptionId: "sub_PaOwner000001", active: true, period: paidPeriod() });
  let store = (await storeForEmail("pa-owner@example.com"))!;
  const listId = store.listId as string;
  const added = await addEndpoint(store, "https://hooks.example.com/refunds", ["refund.issued"]);
  if (!added.ok) throw new Error("not added");
  let when = Date.now();
  // One clock for the tries and for Redis's (the stand-in's TIME is Date.now).
  Date.now = () => when;
  const nextTry = async (minutes: number) => {
    when += minutes * 60_000 + 1000;
    await deliverDue(when + 60_000, when);
  };
  // Paid an hour before the refund.
  const paid = Math.floor(when / 1000) - 3600;
  const print = (email: string, seconds: number) => redis.pipeline([suppressCommand(listId, email, seconds)]);
  const refund = (charge: string, email: string, extra: Record<string, unknown> = {}) =>
    emitEvent(store, "refund.issued", `${charge}|2900`, { charge, amount_cents: 2900, buyer: { email, name: null }, ...extra }, when, { email, paidAt: paid });

  part("Deleted before they paid again: every try names them, not only the first");
  await print("again@example.com", paid - 100);
  answers.push(500);
  await refund("ch_pa_again", "again@example.com");
  is("the first try named the buyer", buyerSent("ch_pa_again"), ["again@example.com"]);
  await nextTry(RETRY_MINUTES[0]);
  is("the retry named them too", buyerSent("ch_pa_again"), ["again@example.com", "again@example.com"]);
  is("and the store's recent messages hand it back", (await recentMessages(store, "refund.issued", 50)).filter((m) => (m.data as { charge?: string }).charge === "ch_pa_again").length, 1);

  part("Deleted after the event was made: a retry is held, as main holds it");
  answers.push(500);
  await refund("ch_pa_later", "later@example.com");
  is("the first try named the buyer, before the deletion", buyerSent("ch_pa_later"), ["later@example.com"]);
  await erasePerson(store, "later@example.com", { kind: "person" });
  store = (await storeForEmail("pa-owner@example.com"))!;
  await nextTry(RETRY_MINUTES[0]);
  is("no retry sent the deleted address", buyerSent("ch_pa_later"), ["later@example.com"]);
  is("nor do the recent messages hand it back", JSON.stringify(await recentMessages(store, "refund.issued", 50)).includes("later@example.com"), false);

  part("Deleted the second before the payment (two clocks): no address, as at or after it");
  await print("edge@example.com", paid - 1);
  await refund("ch_pa_edge", "edge@example.com");
  is("sent once, with no address", buyerSent("ch_pa_edge"), [null]);

  part("Only the buyer's own address is read against the payment: anyone else deleted holds the message");
  await print("other-buyer@example.com", paid - 100);
  await print("someone@example.com", paid - 100);
  await refund("ch_pa_other", "other-buyer@example.com", { note: "for someone@example.com" });
  is("not sent", sentFor("ch_pa_other").length, 0);

  part("A payment time kept in another shape is unknown: the try holds the message, as main holds a refund");
  await print("shape@example.com", paid - 100);
  answers.push(500);
  await refund("ch_pa_shape", "shape@example.com");
  is("the first try named the buyer", buyerSent("ch_pa_shape"), ["shape@example.com"]);
  const view = await webhooksView(store);
  const row = view.log.find((d) => d.state === "retrying");
  if (!row) throw new Error("no retrying delivery");
  const key = `nl:hooks:d:${row.id}`;
  const [kept] = await original([["GET", key]]);
  await original([["SET", key, JSON.stringify({ ...JSON.parse(String(kept)), paidAt: String(paid) })]]);
  await nextTry(RETRY_MINUTES[0]);
  is("the retry did not send it", buyerSent("ch_pa_shape"), ["shape@example.com"]);

  part("A delivery failed for good about a person who paid again can be sent again by hand");
  await print("hand@example.com", paid - 100);
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) answers.push(500);
  await refund("ch_pa_hand", "hand@example.com");
  for (const minutes of RETRY_MINUTES) await nextTry(minutes);
  is("tried every time", buyerSent("ch_pa_hand").length, MAX_ATTEMPTS);
  const failed = (await webhooksView(store)).log.find((d) => d.state === "failed" && !d.lastError.startsWith("Not sent"));
  if (!failed) throw new Error("no failed delivery");
  const resent = await resendDelivery(store, failed.id, when);
  is("sent again by hand", [resent.ok, buyerSent("ch_pa_hand").length], [true, MAX_ATTEMPTS + 1]);

  server.close();
  done();
}
void main();
