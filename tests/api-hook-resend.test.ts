/**
 * POST /api/v1/hooks/resend (378 [TB4] complement WG (b)): a failed delivery
 * sent again through the API, by the same resendDelivery as the studio's
 * "Send again" (lib/webhooks.ts). What is checked, with synthetic stores and
 * keys and a local server standing in for the address:
 *
 *   - a key that may write sends it again; one made to read is refused; an id
 *     that cannot be one is 400 with nothing read past the door;
 *   - the same message with the same event id, signed afresh, a new line that
 *     names the one it sends again; the answer says how it went;
 *   - once only: again is 409 resent, the delivered copy 409 not_failed,
 *     another store's 404;
 *   - its reads at their most (RESEND_WORK) are taken from the store's API
 *     requests before anything is read: with too few left, 429 and no
 *     delivery read, nothing sent; the try is one of the month's webhook
 *     deliveries, and with none left 429 with nothing sent;
 *   - while the plan's renewal is unpaid it waits with the pause's sentence;
 *   - the delivery log is not read back for the answer.
 */
import { createHmac } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { POST as hookResend } from "@/app/api/v1/hooks/resend/route";
import { makeKey } from "@/lib/api-keys";
import { RESEND_WORK, apiReadUnits } from "@/lib/api-read-rules";
import { API_WRITE_PAUSED_WORDS } from "@/lib/integration-pause";
import { MAX_ATTEMPTS, RETRY_MINUTES, addEndpoint, deliverDue, emitEvent, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Received = { headers: http.IncomingHttpHeaders; body: string };
const received: Received[] = [];
const answers: number[] = [];
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk.toString()));
  request.on("end", () => {
    received.push({ headers: request.headers, body });
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

// The webhook queue's lease script, modelled as Redis runs it (as in tests/webhook-resend.test.ts), and every command seen.
let commands: (string | number)[][] = [];
const original = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: (string | number)[][]) => {
  commands.push(...batch);
  const [only] = batch;
  if (batch.length === 1 && only[0] === "EVAL" && String(only[1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) {
    const [, , , key, member, now, until] = only.map(String);
    const [due] = await original([["ZSCORE", key, member]]);
    if (due === null || due === undefined || Number(due) > Number(now)) return [0];
    await original([["ZADD", key, Number(until), member]]);
    return [1];
  }
  return original(batch);
}) as typeof redis.pipeline;
console.error = () => {};

type Answer = { status: number; body: { data?: Record<string, unknown>; error?: string; message?: string } };
const resend = async (key: string, body: unknown): Promise<Answer> => {
  const res = await hookResend(new Request("https://marktmorgen.com/api/v1/hooks/resend", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Answer["body"] };
};
const readADelivery = () => commands.some((c) => c[0] === "GET" && /^nl:hooks:d:/.test(String(c[1])));

async function shop(n: number): Promise<{ owner: string; store: () => Promise<Store>; writer: string; reader: string; secret: string }> {
  const owner = `api-hook-resend-${n}@example.com`;
  await claimHandle(owner, `api-hook-resend-${n}`, `API Hook Resend ${n}`, "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_HookResend${n}00`, subscriptionId: `sub_HookResend${n}00`, active: true, period: paidPeriod() });
  const store = async () => (await storeForEmail(owner))!;
  const writer = await makeKey((await store()).sid!, "Synthetic writer", Date.now(), true);
  const reader = await makeKey((await store()).sid!, "Synthetic reader");
  if (!writer.ok || !reader.ok) throw new Error("no synthetic keys");
  const added = await addEndpoint(await store(), `https://hooks.example.com/sales-${n}`, ["sale.completed"]);
  if (!added.ok) throw new Error("no endpoint");
  return { owner, store, writer: writer.key, reader: reader.key, secret: added.secret };
}

const seen = new Set<string>();
/** A sale whose every try fails, until it has failed for good. */
async function failedForGood(store: Store, seed: string): Promise<{ id: string; eventId: string; body: string }> {
  const before = received.length;
  answers.push(...Array.from({ length: MAX_ATTEMPTS }, () => 500));
  await emitEvent(store, "sale.completed", seed, { amount_cents: 200 });
  let at = Date.now();
  for (const minutes of RETRY_MINUTES) {
    at += minutes * 60_000 + 1000;
    await deliverDue(Date.now() + 10_000, at);
  }
  const row = (await webhooksView(store)).log.find((d) => d.state === "failed" && d.attempts === MAX_ATTEMPTS && !d.resentFrom && !seen.has(d.id));
  if (!row) throw new Error("no failed delivery");
  seen.add(row.id);
  return { id: row.id, eventId: row.eventId, body: received[before]?.body ?? "" };
}

async function main(): Promise<void> {
  redis.clear();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent((server.address() as net.AddressInfo).port) as never } });
  const one = await shop(1);
  const two = await shop(2);
  const first = await failedForGood(await one.store(), "cs_api_re_0001");
  const apiUsed = async (s = one) => allowanceUsed(await s.store(), "api");
  const hooksUsed = async (s = one) => allowanceUsed(await s.store(), "webhook");

  part("Who may send one again, and which");
  let sent = received.length;
  const readOnly = await resend(one.reader, { delivery: first.id });
  is("a key made to read is refused", [readOnly.status, readOnly.body.error], [403, "read_only"]);
  commands = [];
  let before = await apiUsed();
  const badId = await resend(one.writer, { delivery: "dlv_short" });
  is("an id that cannot be one is 400", [badId.status, badId.body.error], [400, "invalid_id"]);
  is("nothing read past the door's request", [readADelivery(), (await apiUsed()) - before], [false, 1]);
  const theirs = await resend(two.writer, { delivery: first.id });
  is("another store's delivery is not found", [theirs.status, theirs.body.error], [404, "not_found"]);
  is("nothing sent for any of them", received.length, sent);

  part("Sent again: the same message and event id, signed afresh, once");
  commands = [];
  before = await apiUsed();
  const hooksBefore = await hooksUsed();
  sent = received.length;
  const again = await resend(one.writer, { delivery: first.id });
  const message = received[sent];
  is("200, delivered, naming the one it sends again", [again.status, again.body.data?.delivered, again.body.data?.status, again.body.data?.resent_from, again.body.data?.event], [200, true, 200, first.id, first.eventId]);
  is("the same message, with the same event id", [message?.body === first.body, String(message?.headers["marktmorgen-event-id"])], [true, first.eventId]);
  const signature = /^t=(\d+),v1=([0-9a-f]{64})/.exec(String(message?.headers["marktmorgen-signature"]));
  is("signed afresh under the endpoint's secret", Boolean(signature) && createHmac("sha256", one.secret).update(`${signature![1]}.${message?.body}`).digest("hex") === signature![2], true);
  is("its reads at their most taken from the month's API requests, with the door's", (await apiUsed()) - before, 1 + apiReadUnits(RESEND_WORK));
  is("one of the month's webhook deliveries", (await hooksUsed()) - hooksBefore, 1);
  is("the delivery log is not read back for the answer", commands.some((c) => c[0] === "LRANGE" && String(c[1]).startsWith("nl:hooks:log:")), false);
  const twice = await resend(one.writer, { delivery: first.id });
  is("once delivered, not again", [twice.status, twice.body.error], [409, "resent"]);
  const copy = await resend(one.writer, { delivery: String(again.body.data?.delivery) });
  is("the copy, delivered, is never sent twice", [copy.status, copy.body.error], [409, "not_failed"]);

  part("With too few API requests left, nothing is read or sent");
  const second = await failedForGood(await one.store(), "cs_api_re_0002");
  const mine = await one.store();
  const free = allowanceFor(mine, "api") - (await allowanceUsed(mine, "api"));
  // Room for the door's request and less than the reads at their most.
  const keep = apiReadUnits(RESEND_WORK);
  if (free > keep) is("the month is taken down", (await takeAllowance(mine, "api", free - keep)).ok, true);
  commands = [];
  sent = received.length;
  const short = await resend(one.writer, { delivery: second.id });
  is("429 monthly_limit, nothing read", [short.status, short.body.error, readADelivery()], [429, "monthly_limit", false]);
  is("nothing sent", received.length, sent);

  part("With the month's webhook deliveries used, nothing is sent");
  const other = await failedForGood(await two.store(), "cs_api_re_0003");
  const store2 = await two.store();
  for (;;) if (!(await takeAllowance(store2, "webhook")).ok) break;
  sent = received.length;
  const used = await resend(two.writer, { delivery: other.id });
  is("429 monthly_limit with the month's sentence", [used.status, used.body.error, typeof used.body.message === "string" && String(used.body.message).length > 0], [429, "monthly_limit", true]);
  is("nothing sent", received.length, sent);

  part("While the renewal is unpaid, it waits with the pause's sentence");
  await setSubscription(two.owner, { active: true, period: paidPeriod(), renewalUnpaid: true });
  before = await apiUsed(two);
  const paused = await resend(two.writer, { delivery: other.id });
  is("409 paused_unpaid, the API's own sentence", [paused.status, paused.body.error, paused.body.message], [409, "paused_unpaid", API_WRITE_PAUSED_WORDS.paused_unpaid]);
  is("nothing counted", (await apiUsed(two)) - before, 0);

  server.close();
  done();
}

void main();
