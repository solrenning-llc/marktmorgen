/**
 * The studio's "Send failed ones again" (378 [TB4] complement WG (b)): an
 * endpoint's deliveries that failed for good in an interval, sent again from
 * the studio's Webhooks section (app/api/store/webhooks/route.ts, action
 * "resend_range"), by the same range logic as POST /api/v1/hooks/resend
 * (lib/api-hook-resend.ts, resendRange). What is checked, through the real
 * route with a synthetic store, session, delivery records and a local server
 * standing in for the address:
 *
 *   - only the interval's failed deliveries to that endpoint are sent again,
 *     oldest first, once each; a delivered one and another endpoint's never;
 *   - the answer says how many were sent, delivered, skipped and left, with
 *     the log as it is now; pressed again, nothing is sent twice;
 *   - at most ten a press, the rest said as left;
 *   - each one is one of the month's webhook deliveries, and none of the
 *     store's API requests is taken (it is a press in the studio, as one
 *     "Send again" is);
 *   - an interval longer than seven days, backwards or not times, and an
 *     endpoint the store does not have, are refused before any delivery is
 *     read;
 *   - the studio shows it: labeled fields, the limits said, the result in a
 *     polite live region.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST as webhooksRoute } from "@/app/api/store/webhooks/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { MAX_ATTEMPTS, addEndpoint, setSendHooksForTests } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const received: string[] = [];
const server = http.createServer((request, response) => {
  request.on("data", () => {});
  request.on("end", () => {
    received.push(String(request.headers["marktmorgen-event-id"]));
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

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
type Answer = { status: number; body: { ok?: boolean; error?: string; message?: string; sent?: number; delivered?: number; skipped?: number; left?: number; stopped?: string | null; view?: { log: { id: string }[] } } };

let made = 0;
/** A delivery record of the store, as the log keeps one, made `ago` milliseconds back. */
async function delivery(store: Store, endpoint: string, ago: number, state: "failed" | "delivered" = "failed"): Promise<{ id: string; eventId: string }> {
  made += 1;
  const id = `dlv_${made.toString(16).padStart(24, "0")}`;
  const eventId = `evt_${made.toString(16).padStart(32, "0")}`;
  const at = Date.now() - ago;
  const body = JSON.stringify({ id: eventId, type: "sale.completed", created: Math.floor(at / 1000), store: { handle: store.handle }, data: { checkout_session: `cs_studio_range_${made}`, amount_cents: 100 } });
  const row = { id, statsId: store.statsId, endpoint, eventId, type: "sale.completed", body, attempts: state === "failed" ? MAX_ATTEMPTS : 1, state, next: 0, lastStatus: state === "failed" ? 500 : 200, lastError: state === "failed" ? "Answered 500." : "", lastAt: at, createdAt: at };
  await pipeline([["SET", `nl:hooks:d:${id}`, JSON.stringify(row), "EX", 7 * 86_400], ["LPUSH", `nl:hooks:log:${store.statsId}`, id]]);
  return { id, eventId };
}

async function shop(n: number) {
  const owner = `studio-range-${n}@example.com`;
  await claimHandle(owner, `studio-range-${n}`, `Studio Range ${n}`, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: `cus_StudioRange${n}00`, subscriptionId: `sub_StudioRange${n}00`, active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const store = async () => (await storeForEmail(owner))!;
  const endpoints: string[] = [];
  for (const path of ["a", "b"]) {
    const added = await addEndpoint(await store(), `https://hooks.example.com/studio-${n}-${path}`, ["sale.completed"]);
    if (!added.ok) throw new Error("no endpoint");
    endpoints.push(added.view.endpoints.find((e) => e.where.endsWith(`/studio-${n}-${path}`))!.id);
  }
  const session = await openSession(owner);
  const press = async (body: Record<string, unknown>): Promise<Answer> => {
    const res = await webhooksRoute(new NextRequest("https://marktmorgen.com/api/store/webhooks", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ action: "resend_range", ...body }) }));
    return { status: res.status, body: (await res.json()) as Answer["body"] };
  };
  return { store, endpoints, press };
}

async function main(): Promise<void> {
  redis.clear();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent((server.address() as net.AddressInfo).port) as never } });

  part("Only the interval's failed deliveries to that endpoint, oldest first, once each");
  const one = await shop(1);
  const [a, b] = one.endpoints;
  const s1 = await one.store();
  const before = await delivery(s1, a, 3 * DAY);
  const inside = [await delivery(s1, a, 2 * DAY), await delivery(s1, a, DAY), await delivery(s1, a, 60_000)];
  const deliveredOne = await delivery(s1, a, 1.5 * DAY, "delivered");
  const otherEndpoint = await delivery(s1, b, 1.5 * DAY);
  const apiBefore = await allowanceUsed(await one.store(), "api");
  const hooksBefore = await allowanceUsed(await one.store(), "webhook");
  let sent = received.length;
  const first = await one.press({ endpoint: a, from: iso(Date.now() - 2.5 * DAY), to: iso(Date.now()) });
  is("200: three sent and delivered, none skipped or left, nothing stopped", [first.status, first.body.ok, first.body.sent, first.body.delivered, first.body.skipped, first.body.left, first.body.stopped], [200, true, 3, 3, 0, 0, null]);
  is("oldest first, with their own event ids", received.slice(sent), inside.map((d) => d.eventId));
  is("the one before the interval, the delivered one and the other endpoint's: never", received.slice(sent).some((e) => [before.eventId, deliveredOne.eventId, otherEndpoint.eventId].includes(e)), false);
  is("the answer carries the log as it is now", (first.body.view?.log.length ?? 0) >= 9, true);
  is("three of the month's webhook deliveries; none of the store's API requests", [(await allowanceUsed(await one.store(), "webhook")) - hooksBefore, (await allowanceUsed(await one.store(), "api")) - apiBefore], [3, 0]);

  part("Pressed again, nothing is sent twice");
  sent = received.length;
  const again = await one.press({ endpoint: a, from: iso(Date.now() - 2.5 * DAY), to: iso(Date.now()) });
  is("nothing sent, the three said as skipped", [again.body.ok, again.body.sent, again.body.skipped, received.length - sent], [true, 0, 3, 0]);

  part("At most ten a press");
  const two = await shop(2);
  const s2 = await two.store();
  for (let k = 12; k >= 1; k -= 1) await delivery(s2, two.endpoints[0], k * 60_000);
  const ten = await two.press({ endpoint: two.endpoints[0], from: iso(Date.now() - DAY), to: iso(Date.now()) });
  is("ten sent, two left", [ten.body.sent, ten.body.left], [10, 2]);

  part("Refused before any delivery is read");
  for (const [label, body, code] of [
    ["more than seven days", { endpoint: a, from: iso(Date.now() - 8 * DAY), to: iso(Date.now()) }, "interval"],
    ["backwards", { endpoint: a, from: iso(Date.now()), to: iso(Date.now() - DAY) }, "interval"],
    ["not times", { endpoint: a, from: "yesterday", to: "today" }, "interval"],
    ["an endpoint that cannot be an id", { endpoint: "nope", from: iso(Date.now() - DAY), to: iso(Date.now()) }, "missing"],
    ["another store's endpoint", { endpoint: two.endpoints[0], from: iso(Date.now() - DAY), to: iso(Date.now()) }, "missing"],
  ] as const) {
    commands = [];
    const r = await one.press(body);
    is(`${label}: refused (${code})`, [r.status >= 400, r.body.error], [true, code]);
    is(`${label}: no delivery read`, commands.some((c) => String(c[1] ?? "").startsWith("nl:hooks:log:") || String(c[1] ?? "").startsWith("nl:hooks:d:")), false);
  }

  part("The studio shows it");
  const editor = readFileSync("components/webhook-editor.tsx", "utf8");
  is("its fields are labeled", ['htmlFor="resend-range-endpoint"', 'htmlFor="resend-range-from"', 'htmlFor="resend-range-to"'].every((w) => editor.includes(w)), true);
  is("the limits are said", editor.includes("at most ${RANGE_MAX_DAYS} days apart") && editor.includes("${RANGE_MAX_SENT} a press"), true);
  is("the result is said in a polite live region", /role="status"[^>]*aria-live="polite"[^>]*>\s*\{rangeResult/.test(editor), true);

  server.close();
  done();
}

void main();
