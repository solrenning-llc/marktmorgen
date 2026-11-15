/**
 * POST /api/v1/hooks/resend with { endpoint, from, to } (378 [TB4] complement
 * WG (b); lib/api-hook-resend.ts): an endpoint's deliveries that failed for
 * good in an interval, sent again through the API. What is checked, with
 * synthetic stores, keys, delivery records and a local server standing in for
 * the address:
 *
 *   - of twelve failed deliveries over three days, only those of the interval
 *     are sent again, oldest first, once each, with their own event ids; one
 *     delivered, or another endpoint's, never;
 *   - the same call again sends nothing twice, and says why for each;
 *   - at most ten a request, the rest said as left; past the minute's ten it
 *     stops with the reason; with the month's deliveries used it stops before
 *     anything is sent, with the reason;
 *   - each one's reads at their most are taken from the store's API requests
 *     before it is read;
 *   - an interval longer than seven days, or backwards, is 400, and an
 *     endpoint the store does not have 404, before any delivery is read or
 *     any is taken.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { POST as hookResend } from "@/app/api/v1/hooks/resend/route";
import { makeKey } from "@/lib/api-keys";
import { RESEND_WORK, apiReadUnits } from "@/lib/api-read-rules";
import { MAX_ATTEMPTS, addEndpoint, setSendHooksForTests } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Received = { headers: http.IncomingHttpHeaders; body: string };
const received: Received[] = [];
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk.toString()));
  request.on("end", () => {
    received.push({ headers: request.headers, body });
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
let commands: (string | number)[][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: (string | number)[][]) => {
  commands.push(...batch);
  return pipeline(batch);
}) as typeof redis.pipeline;
console.error = () => {};

type Data = { sent: { delivery: string; resent_from: string; event: string; delivered: boolean }[]; skipped: { delivery: string; reason: string }[]; stopped: { error: string; message: string } | null; left: number };
type Answer = { status: number; body: { data?: Data; error?: string; message?: string } };
const call = async (key: string, body: unknown): Promise<Answer> => {
  const res = await hookResend(new Request("https://marktmorgen.com/api/v1/hooks/resend", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Answer["body"] };
};
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

async function shop(n: number): Promise<{ owner: string; store: () => Promise<Store>; writer: string; endpoints: string[] }> {
  const owner = `api-hook-range-${n}@example.com`;
  await claimHandle(owner, `api-hook-range-${n}`, `API Hook Range ${n}`, "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_HookRange${n}000`, subscriptionId: `sub_HookRange${n}000`, active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const store = async () => (await storeForEmail(owner))!;
  const writer = await makeKey((await store()).sid!, "Synthetic writer", Date.now(), true);
  if (!writer.ok) throw new Error("no synthetic key");
  const endpoints: string[] = [];
  for (const path of ["a", "b"]) {
    const added = await addEndpoint(await store(), `https://hooks.example.com/${n}-${path}`, ["sale.completed"]);
    if (!added.ok) throw new Error("no endpoint");
    endpoints.push(added.view.endpoints.find((e) => e.where.endsWith(`/${n}-${path}`))!.id);
  }
  return { owner, store, writer: writer.key, endpoints };
}

let made = 0;
/** A delivery record of the store, as the log keeps one, made `ago` milliseconds back. */
async function delivery(store: Store, endpoint: string, ago: number, state: "failed" | "delivered" = "failed"): Promise<{ id: string; eventId: string }> {
  made += 1;
  const id = `dlv_${made.toString(16).padStart(24, "0")}`;
  const eventId = `evt_${made.toString(16).padStart(32, "0")}`;
  const at = Date.now() - ago;
  const body = JSON.stringify({ id: eventId, type: "sale.completed", created: Math.floor(at / 1000), store: { handle: store.handle }, data: { checkout_session: `cs_range_${made}`, amount_cents: 100 } });
  const row = { id, statsId: store.statsId, endpoint, eventId, type: "sale.completed", body, attempts: state === "failed" ? MAX_ATTEMPTS : 1, state, next: 0, lastStatus: state === "failed" ? 500 : 200, lastError: state === "failed" ? "Answered 500." : "", lastAt: at, createdAt: at };
  await pipeline([["SET", `nl:hooks:d:${id}`, JSON.stringify(row), "EX", 7 * 86_400], ["LPUSH", `nl:hooks:log:${store.statsId}`, id]]);
  return { id, eventId };
}
const eventsReceived = (from: number) => received.slice(from).map((r) => String(r.headers["marktmorgen-event-id"]));

async function main(): Promise<void> {
  redis.clear();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent((server.address() as net.AddressInfo).port) as never } });

  part("Twelve failed over three days: only the interval's, oldest first, once each");
  const one = await shop(1);
  const [a, b] = one.endpoints;
  const s1 = await one.store();
  const byDay: { id: string; eventId: string }[][] = [[], [], []];
  for (const day of [3, 2, 1]) for (let k = 0; k < 4; k += 1) byDay[3 - day].push(await delivery(s1, a, day * DAY - k * 60_000));
  const deliveredOne = await delivery(s1, a, 1.5 * DAY, "delivered");
  const otherEndpoint = await delivery(s1, b, 1.5 * DAY);
  const interval = { endpoint: a, from: iso(Date.now() - 2.5 * DAY), to: iso(Date.now()) };
  let sent = received.length;
  const apiBefore = await allowanceUsed(await one.store(), "api");
  const hooksBefore = await allowanceUsed(await one.store(), "webhook");
  const first = await call(one.writer, interval);
  const wanted = [...byDay[1], ...byDay[2]];
  is("200, the eight of the interval sent again, nothing stopped or left", [first.status, first.body.data?.sent.length, first.body.data?.stopped, first.body.data?.left], [200, 8, null, 0]);
  is("oldest first, each with its own event id, once each", eventsReceived(sent), wanted.map((d) => d.eventId));
  is("each names the one it sends again", first.body.data?.sent.map((s) => s.resent_from), wanted.map((d) => d.id));
  is("the day before the interval, the delivered one and the other endpoint's are not sent", eventsReceived(sent).some((e) => [...byDay[0].map((d) => d.eventId), deliveredOne.eventId, otherEndpoint.eventId].includes(e)), false);
  is("eight of the month's webhook deliveries", (await allowanceUsed(await one.store(), "webhook")) - hooksBefore, 8);
  is("each one's reads at their most taken from the API requests", (await allowanceUsed(await one.store(), "api")) - apiBefore >= 1 + 8 * apiReadUnits(RESEND_WORK), true);

  part("The same call again sends nothing twice");
  sent = received.length;
  const again = await call(one.writer, interval);
  is("nothing sent", [again.status, again.body.data?.sent.length, received.length - sent], [200, 0, 0]);
  is("each said as already sent again", again.body.data?.skipped.map((s) => [s.delivery, s.reason]), wanted.map((d) => [d.id, "resent"]));

  part("At most ten a request; past the minute's ten it stops with the reason");
  const two = await shop(2);
  const s2 = await two.store();
  const many: { id: string; eventId: string }[] = [];
  for (let k = 12; k >= 1; k -= 1) many.push(await delivery(s2, two.endpoints[0], k * 60_000));
  const recent = { endpoint: two.endpoints[0], from: iso(Date.now() - DAY), to: iso(Date.now()) };
  sent = received.length;
  const ten = await call(two.writer, recent);
  is("ten sent, the oldest ten, two left, not stopped", [ten.body.data?.sent.length, ten.body.data?.left, ten.body.data?.stopped], [10, 2, null]);
  is("in the order they were made", eventsReceived(sent), many.slice(0, 10).map((d) => d.eventId));
  sent = received.length;
  const minute = await call(two.writer, recent);
  is("within the same minute: stopped by the ten a minute, nothing sent, two left", [minute.body.data?.sent.length, minute.body.data?.stopped?.error, minute.body.data?.left, received.length - sent], [0, "rate_limited", 2, 0]);

  part("With the month's deliveries used, it stops before anything is sent");
  const three = await shop(3);
  const s3 = await three.store();
  for (let k = 3; k >= 1; k -= 1) await delivery(s3, three.endpoints[0], k * 60_000);
  for (;;) if (!(await takeAllowance(await three.store(), "webhook")).ok) break;
  sent = received.length;
  const used = await call(three.writer, { endpoint: three.endpoints[0], from: iso(Date.now() - DAY), to: iso(Date.now()) });
  is("stopped with the month's reason, nothing sent, three left", [used.status, used.body.data?.sent.length, used.body.data?.stopped?.error, used.body.data?.left, received.length - sent], [200, 0, "monthly_limit", 3, 0]);

  part("A request that cannot be answered is refused before anything is read");
  for (const [label, body, code] of [
    ["more than seven days", { endpoint: a, from: iso(Date.now() - 8 * DAY), to: iso(Date.now()) }, "invalid_interval"],
    ["backwards", { endpoint: a, from: iso(Date.now()), to: iso(Date.now() - DAY) }, "invalid_interval"],
    ["not times", { endpoint: a, from: "yesterday", to: "today" }, "invalid_interval"],
    ["an endpoint that cannot be an id", { endpoint: "nope", from: iso(Date.now() - DAY), to: iso(Date.now()) }, "invalid_id"],
    ["both a delivery and an endpoint", { endpoint: a, delivery: wanted[0].id, from: iso(Date.now() - DAY), to: iso(Date.now()) }, "invalid_request"],
  ] as const) {
    commands = [];
    const before = await allowanceUsed(await one.store(), "api");
    const r = await call(one.writer, body);
    is(`${label}: 400 ${code}`, [r.status, r.body.error], [400, code]);
    is(`${label}: no delivery read, only the door's request`, [commands.some((c) => String(c[1] ?? "").startsWith("nl:hooks:log:")), (await allowanceUsed(await one.store(), "api")) - before], [false, 1]);
  }
  commands = [];
  const hooksNow = await allowanceUsed(await one.store(), "webhook");
  const theirs = await call(one.writer, { endpoint: two.endpoints[0], from: iso(Date.now() - DAY), to: iso(Date.now()) });
  is("another store's endpoint is 404", [theirs.status, theirs.body.error], [404, "not_found"]);
  is("no delivery read, none taken", [commands.some((c) => String(c[1] ?? "").startsWith("nl:hooks:log:")), (await allowanceUsed(await one.store(), "webhook")) - hooksNow], [false, 0]);

  server.close();
  done();
}

void main();
