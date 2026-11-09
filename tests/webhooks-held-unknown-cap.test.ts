/**
 * A webhook delivery held because its API key's state cannot be read waits on the published retry schedule and
 * is then failed with the reason, never tried again at every lease for the seven days a delivery is kept
 * (lib/webhooks.ts attempt, heldNow; emitEvent). Focal return of Claude 2 on #3096 (comment 6712352850).
 *
 * Before: heldNow threw on an unreadable key, the try threw, and the lease brought the delivery back every ten
 * minutes for DELIVERY_SECONDS: about a thousand reads of the key and as many error lines, counted nowhere,
 * each taking one of deliverDue's slots, and the delivery expired with no "failed" line. emitEvent's first
 * try stopped at the first delivery that threw, so the endpoints after it waited for the next deliverDue.
 *
 * Kept (rule 24): an unknown reply is never read as "not held"; nothing is sent until the key reads as in use; a
 * paused key's endpoint receives nothing; a delivery is sent once, and is never lost in silence.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts) and a local HTTP server on 127.0.0.1 standing in
 * for the endpoints, reached through lib/safe-fetch.ts with only the name lookup and the socket redirected.
 */
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { makeKey } from "@/lib/api-keys";
import { makerFor } from "@/lib/api-key-pause";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { MAX_ATTEMPTS, QUEUE_KEY, addEndpoint, deliverDue, emitEvent, eventIdFor, resendDelivery, setSendHooksForTests } from "@/lib/webhooks";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 })) as typeof fetch;

/** The test clock: every reader of Date.now (the lease, the retry schedule, the in-memory expiry) follows it. */
const realNow = Date.now.bind(Date);
let shift = 0;
Date.now = () => realNow() + shift;
const MINUTE = 60_000;

/** Each path the stand-in endpoints were sent, in order. */
const received: string[] = [];
const server = http.createServer((request, response) => {
  request.on("data", () => undefined);
  request.on("end", () => {
    received.push(request.url ?? "");
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
const sentTo = (path: string) => received.filter((p) => p === path).length;

type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis);
/** While set, the reply to each command it matches is replaced by what it returns. */
let bend: ((command: (string | number)[], reply: unknown) => unknown) | null = null;
/** A queue member whose lease answers in a shape claim refuses, so its first try throws. */
let breakLeaseOf = "";
/** Every read of an API key list that asks for this key id (each read of its state). */
let watchKey = "";
let keyReads = 0;
redis.pipeline = (async (commands: Commands) => {
  const [only] = commands;
  // The webhook queue's lease (lib/webhooks.ts LEASE_SCRIPT), as Redis runs it: taken only when on the queue and due.
  if (commands.length === 1 && only[0] === "EVAL" && String(only[1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) {
    const [, , , key, member, now, until] = only.map(String);
    if (breakLeaseOf && member === breakLeaseOf) return ["off-shape"];
    const [due] = await real([["ZSCORE", key, member]]);
    if (due === null || due === undefined || Number(due) > Number(now)) return [0];
    await real([["ZADD", key, Number(until), member]]);
    return [1];
  }
  if (watchKey) keyReads += commands.filter((c) => c[0] === "HMGET" && String(c[1]).startsWith("nl:api:keys:") && c.includes(watchKey)).length;
  const replies = await real(commands);
  if (bend) commands.forEach((c, i) => { replies[i] = bend!(c, replies[i]); });
  return replies;
}) as typeof redis.pipeline;

/** Error lines written meanwhile, counted and kept off the output. */
let errorLines = 0;
const loud = console.error;
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  console.error = () => { errorLines += 1; };
  try {
    return await work();
  } finally {
    console.error = loud;
  }
}

async function shop(owner: string, handle: string, n: string) {
  await claimHandle(owner, handle, `Shop ${n}`, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: `cus_HeldCap000${n}`, subscriptionId: `sub_HeldCap000${n}`, active: true, period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  redis.clear();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never } });

  const OWNER = "owner-heldcap@example.com";
  const store = await shop(OWNER, "held-cap-shop", "1");
  const sid = store.sid;
  const statsId = store.statsId!;
  const unread = await makeKey(sid, "Unread sync", Date.now(), false, "none", makerFor(sid, "owner", OWNER, true));
  const paused = await makeKey(sid, "Paused sync", Date.now(), false, "none", makerFor(sid, "owner", OWNER, true));
  if (!unread.ok || !paused.ok) throw new Error("setup: keys not made");
  await real([["HSET", `nl:api:hold:${sid}`, paused.made.id, "paused"]]);
  for (const [path, by] of [["/unread", unread.made.id], ["/studio", ""], ["/paused", paused.made.id]]) {
    const added = await addEndpoint(store, `https://hooks.example.com${path}`, ["sale.completed"], Date.now(), by);
    if (!added.ok) throw new Error(`setup: endpoint not added: ${JSON.stringify(added)}`);
  }
  const endpointsOf = async (id: string) => {
    const [cfg] = await real([["GET", `nl:hooks:cfg:${id}`]]);
    return (JSON.parse(String(cfg)) as { endpoints: { id: string; url: string }[] }).endpoints;
  };
  const endpoints = await endpointsOf(statsId);
  const deliveryId = (eventId: string, path: string) =>
    `dlv_${createHash("sha256").update(`${eventId}|${endpoints.find((e) => e.url.endsWith(path))!.id}`).digest("hex").slice(0, 24)}`;
  const deliveryOf = async (owner: string, id: string) => {
    const [raw, due] = await real([["GET", `nl:hooks:d:${id}`], ["ZSCORE", QUEUE_KEY, `${owner}|${id}`]]);
    const delivery = typeof raw === "string" ? (JSON.parse(raw) as { state: string; attempts: number; lastError: string; body: string }) : null;
    return { delivery, queued: due !== null && due !== undefined };
  };
  /** Runs the five-minute job every `step` minutes for `minutes`, as the cron would, on the test clock. */
  const run = async (minutes: number, step = 11) => {
    let tried = 0;
    for (let t = 0; t < minutes; t += step) {
      shift += step * MINUTE;
      tried += (await deliverDue(Date.now() + 60_000)).tried;
    }
    return tried;
  };
  const unreadList = `nl:api:keys:${sid}`;
  const unreadBend = (c: (string | number)[], reply: unknown) => (c[0] === "HMGET" && c[1] === unreadList && c.includes(unread.made.id) ? "off-shape" : reply);

  part("A delivery held by a key whose state stays unreadable is tried on the schedule, then failed with the reason");
  bend = unreadBend;
  const seed1 = "PAYPAL-SALE-HELDCAP01";
  const written = await quietly(() => emitEvent(store, "sale.completed", seed1, { amount_cents: 6900 }));
  is("the event is written for the unread key's endpoint and the studio endpoint, not the paused key's", written, 2);
  const event1 = eventIdFor(statsId, "sale.completed", seed1);
  const held1 = deliveryId(event1, "/unread");
  is("the studio endpoint is sent the event at once, though the unread key's endpoint comes first", sentTo("/studio"), 1);
  watchKey = unread.made.id;
  keyReads = 0;
  errorLines = 0;
  const tried = await quietly(() => run(7 * 24 * 60));
  const after1 = await deliveryOf(statsId, held1);
  console.log(`  (seven days on the test clock: ${keyReads} reads of the key, ${tried} tries taken by the job, ${errorLines} error lines)`);
  is(`over the seven days a delivery is kept, its key is read at most once per try left (${MAX_ATTEMPTS - 1}), never at every lease`, keyReads <= MAX_ATTEMPTS - 1, true);
  is(`the job takes it at most once per try left (${MAX_ATTEMPTS - 1}), so it holds no slot of deliverDue at every lease`, tried <= MAX_ATTEMPTS - 1, true);
  is(`at most one error line per try (${MAX_ATTEMPTS}), not one every ten minutes`, errorLines <= MAX_ATTEMPTS, true);
  is("it ends failed after its last try, off the queue, with the reason, never left to expire unsaid",
    [after1.delivery?.state, after1.delivery?.attempts, after1.queued, /could not be read/.test(after1.delivery?.lastError ?? "")],
    ["failed", MAX_ATTEMPTS, false, true]);
  is("its message is kept, so it can be sent again by hand", (after1.delivery?.body ?? "").includes(event1), true);
  is("the unread key's endpoint was never sent anything on a guess", sentTo("/unread"), 0);
  is("the paused key's endpoint was never sent anything", sentTo("/paused"), 0);
  is("the studio endpoint was sent it once, not again", sentTo("/studio"), 1);
  is("the held tries took none of the month's webhook deliveries: only the studio's one was counted", await allowanceUsed(store, "webhook"), 1);
  is("sent again by hand while the key still cannot be read, nothing goes out", [await quietly(() => resendDelivery(store, held1).then((r) => r.ok, () => "refused")), sentTo("/unread")], ["refused", 0]);
  bend = null;
  watchKey = "";
  const resent = await resendDelivery(store, held1);
  is("once the key reads as in use, the owner sends it again by hand, once", [resent.ok, sentTo("/unread")], [true, 1]);

  part("A key that reads again before the last try: the held delivery is sent exactly once");
  bend = unreadBend;
  const base2 = sentTo("/unread");
  const seed2 = "PAYPAL-SALE-HELDCAP02";
  await quietly(() => emitEvent(store, "sale.completed", seed2, { amount_cents: 6900 }));
  const held2 = deliveryId(eventIdFor(statsId, "sale.completed", seed2), "/unread");
  await quietly(() => run(30, 6));
  const waiting = await deliveryOf(statsId, held2);
  is("while the key cannot be read it waits on the queue, with tries counted and nothing sent", [waiting.delivery?.state, waiting.queued, sentTo("/unread")], ["retrying", true, base2]);
  bend = null;
  await run(3 * 24 * 60);
  const sent2 = await deliveryOf(statsId, held2);
  is("when it reads again the next try sends it, once, and it leaves the queue", [sent2.delivery?.state, sent2.queued, sentTo("/unread")], ["delivered", false, base2 + 1]);

  part("A held delivery whose key turns out paused is never sent");
  bend = unreadBend;
  const base3 = sentTo("/unread");
  const seed3 = "PAYPAL-SALE-HELDCAP03";
  await quietly(() => emitEvent(store, "sale.completed", seed3, { amount_cents: 6900 }));
  const held3 = deliveryId(eventIdFor(statsId, "sale.completed", seed3), "/unread");
  await real([["HSET", `nl:api:hold:${sid}`, unread.made.id, "paused"]]);
  bend = null;
  await run(24 * 60);
  const paused3 = await deliveryOf(statsId, held3);
  is("its try reads the key as paused: failed, off the queue, nothing sent", [paused3.delivery?.state, paused3.queued, /paused/.test(paused3.delivery?.lastError ?? ""), sentTo("/unread")], ["failed", false, true, base3]);
  is("the paused key's endpoint still received nothing at all", sentTo("/paused"), 0);

  part("One delivery whose first try throws does not keep the endpoints after it from being sent at once");
  const OWNER2 = "owner-heldcap2@example.com";
  const store2 = await shop(OWNER2, "held-cap-shop-two", "2");
  const statsId2 = store2.statsId!;
  for (const path of ["/first", "/second"]) {
    const added = await addEndpoint(store2, `https://hooks.example.com${path}`, ["sale.completed"], Date.now());
    if (!added.ok) throw new Error(`setup: endpoint not added: ${JSON.stringify(added)}`);
  }
  const endpoints2 = await endpointsOf(statsId2);
  const seed4 = "PAYPAL-SALE-HELDCAP04";
  const event4 = eventIdFor(statsId2, "sale.completed", seed4);
  const firstId = `dlv_${createHash("sha256").update(`${event4}|${endpoints2.find((e) => e.url.endsWith("/first"))!.id}`).digest("hex").slice(0, 24)}`;
  breakLeaseOf = `${statsId2}|${firstId}`;
  const written4 = await quietly(() => emitEvent(store2, "sale.completed", seed4, { amount_cents: 6900 }));
  breakLeaseOf = "";
  is("both deliveries are written", written4, 2);
  is("the second endpoint is sent the event at once", sentTo("/second"), 1);
  const first4 = await deliveryOf(statsId2, firstId);
  is("the first is not lost: written and still on the queue, not sent", [first4.delivery?.state, first4.queued, sentTo("/first")], ["queued", true, 0]);
  await run(15, 5);
  is("the job then sends the first, once, and the second is not sent again", [sentTo("/first"), sentTo("/second")], [1, 1]);

  server.close();
  done();
}
void main();
