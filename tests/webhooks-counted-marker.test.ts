/**
 * Whether the month counted a webhook delivery is kept on the delivery itself ("counted"), not guessed from
 * its number of tries, and a try whose month's count cannot be made is counted and capped like any other
 * (lib/webhooks.ts attempt). LOWs 1, 2 and 4 of Claude 2's focal return on #3096 (comment 6713512225).
 *
 * LOW 1, before: the rule that drops the message of a delivery the month never counted read `attempts === 0`
 * as "never counted". A try held because its API key could not be read raises `attempts` without taking one
 * of the month's deliveries, so such a delivery, refused later because the month was used, kept its message
 * for up to seven days though the month never counted it.
 *
 * LOW 4, before: a try whose month's count could not be made (the count's reply unknown) waited on the
 * schedule without counting the try, so it came back every five minutes for the seven days a delivery is
 * kept, uncapped, and expired with no "failed" line.
 *
 * LOW 2, before: the words of a delivery failed on an unreadable key said "You can send it again by hand"
 * with no condition, though a resend is refused while the key cannot be read.
 *
 * Kept (rule 24): an absent or off-shape "counted" is never read in a way that loses a message: a delivery
 * written before the marker keeps the old reading (a try raised `attempts` only when the month counted it),
 * and an off-shape one keeps its message; a try whose count's reply is unknown (the count may have landed)
 * marks the delivery as counted, so it keeps its message too. Nothing is sent while the key or the count is
 * unknown, and nothing is sent twice.
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
import { forceAllowance } from "@/lib/store-allowance";
import { MAX_ATTEMPTS, QUEUE_KEY, addEndpoint, deliverDue, emitEvent, eventIdFor, resendDelivery, setSendHooksForTests } from "@/lib/webhooks";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 })) as typeof fetch;

const realNow = Date.now.bind(Date);
let shift = 0;
Date.now = () => realNow() + shift;
const MINUTE = 60_000;

/** Each path the stand-in endpoints were sent, in order; paths in `failing` answer 500. */
const received: string[] = [];
const failing = new Set<string>();
const server = http.createServer((request, response) => {
  request.on("data", () => undefined);
  request.on("end", () => {
    const path = request.url ?? "";
    received.push(path);
    response.writeHead(failing.has(path) ? 500 : 200);
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
redis.pipeline = (async (commands: Commands) => {
  const [only] = commands;
  // The webhook queue's lease (lib/webhooks.ts LEASE_SCRIPT), as Redis runs it: taken only when on the queue and due.
  if (commands.length === 1 && only[0] === "EVAL" && String(only[1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) {
    const [, , , key, member, now, until] = only.map(String);
    const [due] = await real([["ZSCORE", key, member]]);
    if (due === null || due === undefined || Number(due) > Number(now)) return [0];
    await real([["ZADD", key, Number(until), member]]);
    return [1];
  }
  const replies = await real(commands);
  if (bend) commands.forEach((c, i) => { replies[i] = bend!(c, replies[i]); });
  return replies;
}) as typeof redis.pipeline;

const loud = console.error;
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  console.error = () => undefined;
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
  await setSubscription(owner, { customerId: `cus_Counted000${n}`, subscriptionId: `sub_Counted000${n}`, active: true, period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

type Stored = { state: string; attempts: number; lastError: string; body: string; givenUp?: true; counted?: unknown };

async function main(): Promise<void> {
  redis.clear();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never } });

  const endpointsOf = async (id: string) => {
    const [cfg] = await real([["GET", `nl:hooks:cfg:${id}`]]);
    return (JSON.parse(String(cfg)) as { endpoints: { id: string; url: string }[] }).endpoints;
  };
  const deliveryOf = async (owner: string, id: string) => {
    const [raw, due] = await real([["GET", `nl:hooks:d:${id}`], ["ZSCORE", QUEUE_KEY, `${owner}|${id}`]]);
    const delivery = typeof raw === "string" ? (JSON.parse(raw) as Stored) : null;
    return { delivery, queued: due !== null && due !== undefined };
  };
  const idFor = (eventId: string, endpointId: string) => `dlv_${createHash("sha256").update(`${eventId}|${endpointId}`).digest("hex").slice(0, 24)}`;
  const run = async (minutes: number, step = 11) => {
    let tried = 0;
    for (let t = 0; t < minutes; t += step) {
      shift += step * MINUTE;
      tried += (await deliverDue(Date.now() + 60_000)).tried;
    }
    return tried;
  };
  /** The month's webhook deliveries of a store, all used. */
  const spendMonth = async (store: Awaited<ReturnType<typeof shop>>) => {
    if (!(await forceAllowance(store, "webhook", 10_000_000))) throw new Error("setup: the month could not be used");
  };

  // ---- LOW 1 ----------------------------------------------------------------------------------------------
  part("LOW 1: a delivery held on an unreadable key, then refused because the month is used, keeps no message");
  const OWNER1 = "owner-counted1@example.com";
  const store1 = await shop(OWNER1, "counted-shop-one", "1");
  const sid1 = store1.sid;
  const statsId1 = store1.statsId!;
  const key1 = await makeKey(sid1, "Unread sync", Date.now(), false, "none", makerFor(sid1, "owner", OWNER1, true));
  if (!key1.ok) throw new Error("setup: key not made");
  const added1 = await addEndpoint(store1, "https://hooks.example.com/held", ["sale.completed"], Date.now(), key1.made.id);
  if (!added1.ok) throw new Error(`setup: endpoint not added: ${JSON.stringify(added1)}`);
  const [endpoint1] = await endpointsOf(statsId1);
  const keyList1 = `nl:api:keys:${sid1}`;
  bend = (c, reply) => (c[0] === "HMGET" && c[1] === keyList1 && c.includes(key1.made.id) ? "off-shape" : reply);
  const seed1 = "PAYPAL-SALE-COUNTED01";
  await quietly(() => emitEvent(store1, "sale.completed", seed1, { amount_cents: 6900 }));
  const held1 = idFor(eventIdFor(statsId1, "sale.completed", seed1), endpoint1.id);
  const waiting1 = await deliveryOf(statsId1, held1);
  is("held on the unread key: waiting, one try, marked as not counted by the month",
    [waiting1.delivery?.state, waiting1.delivery?.attempts, waiting1.delivery?.counted], ["retrying", 1, false]);
  bend = null;
  await spendMonth(store1);
  await quietly(() => run(20, 6));
  const after1 = await deliveryOf(statsId1, held1);
  is("the key reads again but the month is used: failed, off the queue, nothing sent",
    [after1.delivery?.state, after1.queued, sentTo("/held")], ["failed", false, 0]);
  is("never counted by the month, so its message is not kept past it (no body, given up)",
    [after1.delivery?.body, after1.delivery?.givenUp], ["", true]);
  is("so it cannot be sent again by hand for free", await resendDelivery(store1, held1).then((r) => r.ok, () => "refused"), false);

  part("LOW 1: a delivery the month counted at an earlier try keeps its message, even after a held try");
  const OWNER2 = "owner-counted2@example.com";
  const store2 = await shop(OWNER2, "counted-shop-two", "2");
  const sid2 = store2.sid;
  const statsId2 = store2.statsId!;
  const key2 = await makeKey(sid2, "Flaky sync", Date.now(), false, "none", makerFor(sid2, "owner", OWNER2, true));
  if (!key2.ok) throw new Error("setup: key not made");
  const added2 = await addEndpoint(store2, "https://hooks.example.com/flaky", ["sale.completed"], Date.now(), key2.made.id);
  if (!added2.ok) throw new Error(`setup: endpoint not added: ${JSON.stringify(added2)}`);
  const [endpoint2] = await endpointsOf(statsId2);
  failing.add("/flaky");
  const seed2 = "PAYPAL-SALE-COUNTED02";
  await quietly(() => emitEvent(store2, "sale.completed", seed2, { amount_cents: 6900 }));
  const id2 = idFor(eventIdFor(statsId2, "sale.completed", seed2), endpoint2.id);
  const first2 = await deliveryOf(statsId2, id2);
  is("its first try was counted and answered 500: marked as counted", [first2.delivery?.state, first2.delivery?.attempts, first2.delivery?.counted, sentTo("/flaky")], ["retrying", 1, true, 1]);
  const keyList2 = `nl:api:keys:${sid2}`;
  bend = (c, reply) => (c[0] === "HMGET" && c[1] === keyList2 && c.includes(key2.made.id) ? "off-shape" : reply);
  await quietly(() => run(6, 6));
  const second2 = await deliveryOf(statsId2, id2);
  is("a held try after it keeps the mark: still counted, nothing sent", [second2.delivery?.state, second2.delivery?.attempts, second2.delivery?.counted, sentTo("/flaky")], ["retrying", 2, true, 1]);
  bend = null;
  failing.delete("/flaky");
  await spendMonth(store2);
  await quietly(() => run(30, 6));
  const after2 = await deliveryOf(statsId2, id2);
  is("refused because the month is used: failed, its message kept", [after2.delivery?.state, (after2.delivery?.body ?? "").length > 0, after2.delivery?.givenUp ?? null], ["failed", true, null]);

  part("LOW 1: the marker is read strictly; a delivery written before it keeps the old reading (rule 24)");
  const OWNER3 = "owner-counted3@example.com";
  const store3 = await shop(OWNER3, "counted-shop-three", "3");
  const statsId3 = store3.statsId!;
  const added3 = await addEndpoint(store3, "https://hooks.example.com/legacy", ["sale.completed"], Date.now());
  if (!added3.ok) throw new Error(`setup: endpoint not added: ${JSON.stringify(added3)}`);
  const [endpoint3] = await endpointsOf(statsId3);
  await spendMonth(store3);
  const cases: [string, Record<string, unknown>, boolean][] = [
    ["no marker, tried before (written before the marker: the month counted it): message kept", { attempts: 1 }, true],
    ["no marker, never tried: message not kept", { attempts: 0 }, false],
    ["marked counted, never tried (counted by a paused try): message kept", { attempts: 0, counted: true }, true],
    ["marked not counted, tried twice (held tries): message not kept", { attempts: 2, counted: false }, false],
    ["an off-shape marker is never read as not counted: message kept", { attempts: 0, counted: "yes" }, true],
    ["an off-shape count of tries is never read as never tried: message kept", { attempts: "1" }, true],
  ];
  const ids3: string[] = [];
  for (const [i, [, fields]] of cases.entries()) {
    const id = `dlv_${createHash("sha256").update(`legacy-${i}`).digest("hex").slice(0, 24)}`;
    ids3.push(id);
    const body = JSON.stringify({ id: `evt_legacy_${i}`, type: "sale.completed" });
    const delivery = { id, statsId: statsId3, endpoint: endpoint3.id, eventId: `evt_legacy_${i}`, type: "sale.completed", body, state: "retrying", next: Date.now() - 1, lastStatus: 500, lastError: "Answered 500.", lastAt: Date.now() - MINUTE, createdAt: Date.now() - MINUTE, ...fields };
    await real([["SET", `nl:hooks:d:${id}`, JSON.stringify(delivery), "EX", 86400], ["ZADD", QUEUE_KEY, Date.now() - 1, `${statsId3}|${id}`]]);
  }
  await quietly(() => run(6, 6));
  for (const [i, [what, , kept]] of cases.entries()) {
    const after = await deliveryOf(statsId3, ids3[i]);
    is(what, [after.delivery?.state, (after.delivery?.body ?? "").length > 0], ["failed", kept]);
  }
  is("none of them was sent", sentTo("/legacy"), 0);

  // ---- LOW 2 ----------------------------------------------------------------------------------------------
  part("LOW 2: a delivery failed on an unreadable key says a resend needs the key to be read again");
  const OWNER4 = "owner-counted4@example.com";
  const store4 = await shop(OWNER4, "counted-shop-four", "4");
  const sid4 = store4.sid;
  const statsId4 = store4.statsId!;
  const key4 = await makeKey(sid4, "Unread sync", Date.now(), false, "none", makerFor(sid4, "owner", OWNER4, true));
  if (!key4.ok) throw new Error("setup: key not made");
  const added4 = await addEndpoint(store4, "https://hooks.example.com/unread", ["sale.completed"], Date.now(), key4.made.id);
  if (!added4.ok) throw new Error(`setup: endpoint not added: ${JSON.stringify(added4)}`);
  const [endpoint4] = await endpointsOf(statsId4);
  const keyList4 = `nl:api:keys:${sid4}`;
  bend = (c, reply) => (c[0] === "HMGET" && c[1] === keyList4 && c.includes(key4.made.id) ? "off-shape" : reply);
  const seed4 = "PAYPAL-SALE-COUNTED04";
  await quietly(() => emitEvent(store4, "sale.completed", seed4, { amount_cents: 6900 }));
  await quietly(() => run(3 * 24 * 60));
  const after4 = await deliveryOf(statsId4, idFor(eventIdFor(statsId4, "sale.completed", seed4), endpoint4.id));
  bend = null;
  const words4 = after4.delivery?.lastError ?? "";
  is("failed after its last try, its message kept", [after4.delivery?.state, after4.delivery?.attempts, (after4.delivery?.body ?? "").length > 0], ["failed", MAX_ATTEMPTS, true]);
  is("its words tie the resend to the key being read again", /once the key can be read again/i.test(words4), true);
  is("they never offer a resend with no condition", /You can send it again by hand\.$/.test(words4), false);

  // ---- LOW 4 ----------------------------------------------------------------------------------------------
  part("LOW 4: a delivery whose month's count stays unknown is tried on the schedule, then failed with the reason");
  const OWNER5 = "owner-counted5@example.com";
  const store5 = await shop(OWNER5, "counted-shop-five", "5");
  const statsId5 = store5.statsId!;
  const added5 = await addEndpoint(store5, "https://hooks.example.com/uncounted", ["sale.completed"], Date.now());
  if (!added5.ok) throw new Error(`setup: endpoint not added: ${JSON.stringify(added5)}`);
  const [endpoint5] = await endpointsOf(statsId5);
  const allowPrefix = "nl:allow:webhook:";
  bend = (c, reply) => (c[0] === "INCRBY" && String(c[1]).startsWith(allowPrefix) ? "off-shape" : reply);
  const seed5 = "PAYPAL-SALE-COUNTED05";
  await quietly(() => emitEvent(store5, "sale.completed", seed5, { amount_cents: 6900 }));
  const id5 = idFor(eventIdFor(statsId5, "sale.completed", seed5), endpoint5.id);
  const first5 = await deliveryOf(statsId5, id5);
  is("its first try is counted as a try and waits; marked as maybe counted by the month (the count's reply was unknown), so its message is never dropped on a guess",
    [first5.delivery?.state, first5.delivery?.attempts, first5.delivery?.counted, first5.queued], ["retrying", 1, true, true]);
  const tried5 = await quietly(() => run(7 * 24 * 60));
  const after5 = await deliveryOf(statsId5, id5);
  is(`the job takes it at most once per try left (${MAX_ATTEMPTS - 1}), not every five minutes for seven days`, tried5 <= MAX_ATTEMPTS - 1, true);
  is("it ends failed after its last try, off the queue, never left to expire unsaid",
    [after5.delivery?.state, after5.delivery?.attempts, after5.queued], ["failed", MAX_ATTEMPTS, false]);
  const words5 = after5.delivery?.lastError ?? "";
  is("with the reason: the month's deliveries could not be counted, and a resend once they can be", [/could not be counted/i.test(words5), /once they can be counted again/i.test(words5)], [true, true]);
  is("its message is kept, so it can be sent again by hand", (after5.delivery?.body ?? "").length > 0, true);
  is("the endpoint was never called while the count was unknown", sentTo("/uncounted"), 0);
  is("sent again by hand while the count is still unknown, nothing goes out", [await quietly(() => resendDelivery(store5, id5).then((r) => r.ok, () => "refused")), sentTo("/uncounted")], [false, 0]);
  bend = null;
  const resent5 = await resendDelivery(store5, id5);
  is("once the count can be made, the owner sends it again by hand, once", [resent5.ok, sentTo("/uncounted")], [true, 1]);

  part("LOW 4: a delivery whose count's reply was unknown keeps its message when the month is then used (rule 24)");
  const OWNER6 = "owner-counted6@example.com";
  const store6 = await shop(OWNER6, "counted-shop-six", "6");
  const statsId6 = store6.statsId!;
  const added6 = await addEndpoint(store6, "https://hooks.example.com/maybe", ["sale.completed"], Date.now());
  if (!added6.ok) throw new Error(`setup: endpoint not added: ${JSON.stringify(added6)}`);
  const [endpoint6] = await endpointsOf(statsId6);
  bend = (c, reply) => (c[0] === "INCRBY" && String(c[1]).startsWith(allowPrefix) ? "off-shape" : reply);
  const seed6 = "PAYPAL-SALE-COUNTED06";
  await quietly(() => emitEvent(store6, "sale.completed", seed6, { amount_cents: 6900 }));
  const id6 = idFor(eventIdFor(statsId6, "sale.completed", seed6), endpoint6.id);
  bend = null;
  await spendMonth(store6);
  await quietly(() => run(20, 6));
  const after6 = await deliveryOf(statsId6, id6);
  is("refused because the month is used: failed, nothing sent, its message kept (the unknown count may have landed)",
    [after6.delivery?.state, sentTo("/maybe"), (after6.delivery?.body ?? "").length > 0, after6.delivery?.givenUp ?? null], ["failed", 0, true, null]);

  server.close();
  done();
}
void main();
