/**
 * GET /api/v1/hooks/deliveries (378 [TB4] complement WG (b)): the store's
 * recent webhook deliveries through the API (lib/api-read.ts,
 * recentDeliveries; lib/webhooks.ts, deliveryRowsOf). What is checked, with
 * synthetic stores, keys and a local server standing in for the address:
 *
 *   - newest first, what each was and how it went (type, event, endpoint,
 *     state, tries, status, why), never its message: no buyer's address or
 *     name in the answer even when the message carried them;
 *   - `endpoint` keeps only that endpoint's; one that cannot be an id is 400
 *     with nothing read;
 *   - a delivery kept that cannot be read, or that is another store's, is
 *     counted in `unreadable`, never left out without a word; a log or an
 *     answer that cannot be read is 502, never an empty list (rule 24);
 *   - it is measured first and its most set aside before any delivery is
 *     read, then settled at what was read and sent, never more than its most;
 *     with too few requests left it is 429 and no delivery is read.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { GET as deliveriesRead } from "@/app/api/v1/hooks/deliveries/route";
import { makeKey } from "@/lib/api-keys";
import { DELIVERIES_MOST, EVENTS_PROBE_MOST, apiReadUnits, eventsWork } from "@/lib/api-read-rules";
import { addEndpoint, emitEvent, sendTest, setSendHooksForTests } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const answers: number[] = [];
const server = http.createServer((request, response) => {
  request.resume();
  request.on("end", () => {
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

let commands: (string | number)[][] = [];
const pipeline = redis.pipeline.bind(redis);
let answer: ((batch: (string | number)[][]) => unknown[] | null) | null = null;
redis.pipeline = (async (batch: (string | number)[][]) => {
  commands.push(...batch);
  return answer?.(batch) ?? pipeline(batch);
}) as typeof redis.pipeline;
console.error = () => {};

type Row = Record<string, unknown>;
type Body = { data?: Row[]; unreadable?: number; error?: string; message?: string };
const get = async (key: string, query = ""): Promise<{ status: number; body: Body }> => {
  const res = await deliveriesRead(new Request(`https://marktmorgen.com/api/v1/hooks/deliveries${query}`, { headers: { Authorization: `Bearer ${key}` } }));
  return { status: res.status, body: (await res.json()) as Body };
};
const readsADelivery = () => commands.some((c) => (c[0] === "GET" && /^nl:hooks:d:/.test(String(c[1]))) || (c[0] === "EVAL" && String(c[1]).includes("webhook-deliveries-read")));

async function shop(n: number): Promise<{ owner: string; store: () => Promise<Store>; key: string }> {
  const owner = `api-hook-deliveries-${n}@example.com`;
  await claimHandle(owner, `api-hook-deliveries-${n}`, `API Hook Deliveries ${n}`, "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_HookDeliv${n}000`, subscriptionId: `sub_HookDeliv${n}000`, active: true, period: paidPeriod() });
  const store = async () => (await storeForEmail(owner))!;
  const made = await makeKey((await store()).sid!, "Synthetic reader");
  if (!made.ok) throw new Error("no synthetic key");
  return { owner, store, key: made.key };
}

async function main(): Promise<void> {
  redis.clear();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent((server.address() as net.AddressInfo).port) as never } });
  const one = await shop(1);
  const two = await shop(2);
  const a = await addEndpoint(await one.store(), "https://hooks.example.com/a", ["sale.completed"]);
  const b = await addEndpoint(await one.store(), "https://hooks.example.com/b", ["sale.completed"]);
  const theirs = await addEndpoint(await two.store(), "https://hooks.example.com/theirs", ["sale.completed"]);
  if (!a.ok || !b.ok || !theirs.ok) throw new Error("no endpoints");
  const idOf = (view: typeof a, path: string) => (view.ok ? view.view.endpoints.find((e) => e.where.endsWith(path))!.id : "");
  const aId = idOf(a, "/a");
  const bId = idOf(b, "/b");
  const theirsId = idOf(theirs, "/theirs");

  // A sale whose message names a buyer, then a test that reaches A and one that fails at B (newest last).
  await emitEvent(await one.store(), "sale.completed", "cs_live_deliv_1", { checkout_session: "cs_live_deliv_1", amount_cents: 2900, currency: "usd", buyer: { email: "ada@example.com", name: "Ada Lovelace" } });
  const delivered = await sendTest(await one.store(), aId);
  answers.push(500);
  const failed = await sendTest(await one.store(), bId);
  if (!delivered.ok || !failed.ok) throw new Error("no tests");
  await sendTest(await two.store(), theirsId);

  part("What each delivery was and how it went, newest first, never its message");
  commands = [];
  let before = await allowanceUsed(await one.store(), "api");
  const all = await get(one.key);
  const rows = all.body.data ?? [];
  is("200, every delivery of the store's log", [all.status, rows.length >= 3], [200, true]);
  is("newest first: the failed test, then the one delivered", [rows[0]?.id, rows[1]?.id], [failed.delivery.id, delivered.delivery.id]);
  is("the failed one says so, with the status and why", [rows[0]?.endpoint, rows[0]?.type, rows[0]?.state, rows[0]?.attempts, rows[0]?.status, typeof rows[0]?.error === "string"], [bId, "test", "failed", 1, 500, true]);
  is("the delivered one has no error", [rows[1]?.endpoint, rows[1]?.state, rows[1]?.status, rows[1]?.error], [aId, "delivered", 200, null]);
  is("each row has the same fields, and never a message", rows.every((r) => Object.keys(r).sort().join() === "attempts,created_at,endpoint,error,event,id,last_at,next_at,state,status,type"), true);
  const sale = rows.find((r) => r.type === "sale.completed");
  is("the sale's delivery is listed by its event", typeof sale?.event === "string" && String(sale?.event).length > 0, true);
  is("no buyer's address or name is read out of it", /ada@example\.com|Ada Lovelace/.test(JSON.stringify(all.body)), false);
  is("nothing unreadable said when everything read", "unreadable" in all.body, false);
  is("the other store's delivery is not in it", rows.some((r) => r.endpoint === theirsId), false);
  const took = (await allowanceUsed(await one.store(), "api")) - before;
  is("settled at what it read and sent: at least the door's request, never more than its most", took >= 1 && took <= 1 + apiReadUnits(eventsWork(DELIVERIES_MOST)), true);

  part("Only one endpoint's");
  const onlyA = await get(one.key, `?endpoint=${aId}`);
  is("only A's deliveries", [onlyA.status, (onlyA.body.data ?? []).length > 0, (onlyA.body.data ?? []).every((r) => r.endpoint === aId)], [200, true, true]);
  commands = [];
  before = await allowanceUsed(await one.store(), "api");
  const bad = await get(one.key, "?endpoint=nope");
  is("an id that cannot be one is 400", [bad.status, bad.body.error], [400, "invalid_id"]);
  is("nothing read, only the door's request taken", [commands.some((c) => String(c[1] ?? "").startsWith("nl:hooks:log:")), (await allowanceUsed(await one.store(), "api")) - before], [false, 1]);

  part("Unreadable is said, never left out; unknown is 502, never an empty list");
  const statsId = (await one.store()).statsId!;
  await pipeline([["SET", `nl:hooks:d:${delivered.delivery.id}`, "{not json", "EX", 600]]);
  const withBroken = await get(one.key);
  is("a delivery kept that cannot be read is counted", [withBroken.status, withBroken.body.unreadable, (withBroken.body.data ?? []).some((r) => r.id === delivered.delivery.id)], [200, 1, false]);
  const twoStats = (await two.store()).statsId!;
  const [twoLog] = (await pipeline([["LRANGE", `nl:hooks:log:${twoStats}`, 0, 0]])) as [string[]];
  await pipeline([["LPUSH", `nl:hooks:log:${statsId}`, twoLog[0]]]);
  const withTheirs = await get(one.key);
  is("another store's delivery in the log is counted, never sent", [withTheirs.body.unreadable, (withTheirs.body.data ?? []).some((r) => r.id === twoLog[0])], [2, false]);
  for (const [label, when, reply] of [
    ["a log in another shape", (c: (string | number)[]) => c[0] === "LRANGE" && String(c[1]).startsWith("nl:hooks:log:"), ["not a list"]],
    ["a log with an id that is not one", (c: (string | number)[]) => c[0] === "LRANGE" && String(c[1]).startsWith("nl:hooks:log:"), [["dlv_short"]]],
    ["the reading's answer in another shape", (c: (string | number)[]) => c[0] === "EVAL" && String(c[1]).includes("webhook-deliveries-read"), [[0]]],
  ] as const) {
    answer = (batch) => (batch.some(when) ? [...reply] : null);
    const r = await get(one.key);
    answer = null;
    is(`${label} is 502 unavailable, never an empty list`, [r.status, r.body.error, r.body.data], [502, "unavailable", undefined]);
  }

  part("With too few requests left, refused before any delivery is read");
  // A full log of large deliveries (each under what a delivery is kept at), so the reading needs more than its measuring.
  await pipeline([["DEL", `nl:hooks:log:${statsId}`]]);
  for (let i = 0; i < 50; i += 1) {
    const id = `dlv_${i.toString(16).padStart(24, "0")}`;
    const row = { id, statsId, endpoint: aId, eventId: `evt_${i}`, type: "sale.completed", body: "x".repeat(60_000), attempts: 1, state: "delivered", next: 0, lastStatus: 200, lastError: "", lastAt: Date.now(), createdAt: Date.now() };
    await pipeline([["SET", `nl:hooks:d:${id}`, JSON.stringify(row), "EX", 600], ["LPUSH", `nl:hooks:log:${statsId}`, id]]);
  }
  const full = await get(one.key);
  is("a full log of large deliveries is read whole, without their messages", [full.status, (full.body.data ?? []).length, JSON.stringify(full.body).includes("xxxx")], [200, 50, false]);
  const mine = await one.store();
  const free = allowanceFor(mine, "api") - (await allowanceUsed(mine, "api"));
  // Room for the door and the measuring, not for the rest.
  const keep = 1 + apiReadUnits(EVENTS_PROBE_MOST);
  if (free > keep) is("the month is taken down", (await takeAllowance(mine, "api", free - keep)).ok, true);
  commands = [];
  const refused = await get(one.key);
  is("429 monthly_limit, saying no delivery was read", [refused.status, refused.body.error, /no delivery was read/.test(String(refused.body.message))], [429, "monthly_limit", true]);
  is("no delivery read", readsADelivery(), false);

  server.close();
  done();
}

void main();
