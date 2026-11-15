/**
 * POST /api/v1/hooks/test (378 [TB4] complement WG (b)): one test message to
 * one of the store's webhook endpoints, through the API, by the same sendTest
 * the studio's "Send test" uses (lib/webhooks.ts). What is checked, with
 * synthetic stores and keys and a local server standing in for the address:
 *
 *   - a key that may write sends it; one made to read is refused; an id that
 *     cannot be one is 400 and another store's endpoint 404, nothing sent;
 *   - it is signed like every message, says it was sent with an API key, and
 *     the answer says how it went: delivered with the status, or failed with
 *     the status and why, tried once and never queued again;
 *   - it is one of the store's webhook deliveries for the month, taken before
 *     it is sent: with none left it is 429 monthly_limit and nothing is sent;
 *   - ten a minute for the store, the eleventh 429 rate_limited, nothing sent;
 *   - while the plan's renewal is unpaid it waits with the pause's sentence,
 *     nothing counted or sent;
 *   - the delivery log is not read back for an answer that never sends it.
 */
import { createHmac } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { POST as hookAdd } from "@/app/api/v1/hooks/route";
import { POST as hookTest } from "@/app/api/v1/hooks/test/route";
import { makeKey } from "@/lib/api-keys";
import { API_WRITE_PAUSED_WORDS } from "@/lib/integration-pause";
import { TEST_MESSAGE_WORDS, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
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
/** Every request leaves on a plain socket to the local server, whatever address was checked. */
class LocalAgent extends https.Agent {
  constructor(private port: number) {
    super({ keepAlive: false });
  }
  createConnection(): net.Socket {
    return net.connect(this.port, "127.0.0.1");
  }
}
const verify = (secret: string, header: string, body: string) => {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  return Boolean(match) && createHmac("sha256", secret).update(`${match![1]}.${body}`).digest("hex") === match![2];
};

let commands: (string | number)[][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: (string | number)[][]) => {
  commands.push(...batch);
  return pipeline(batch);
}) as typeof redis.pipeline;

type Answer = { status: number; body: { data?: Record<string, unknown>; error?: string; message?: string } };
const call = async (handler: (r: Request) => Promise<Response>, path: string, key: string, body: unknown): Promise<Answer> => {
  const res = await handler(new Request(`https://marktmorgen.com${path}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Answer["body"] };
};

async function shop(n: number): Promise<{ owner: string; writer: string; reader: string; id: string; secret: string }> {
  const owner = `api-hook-test-${n}@example.com`;
  await claimHandle(owner, `api-hook-test-${n}`, `API Hook Test ${n}`, "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_HookTest${n}0000`, subscriptionId: `sub_HookTest${n}0000`, active: true, period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const writer = await makeKey(store.sid!, "Synthetic writer", Date.now(), true);
  const reader = await makeKey(store.sid!, "Synthetic reader");
  if (!writer.ok || !reader.ok) throw new Error("no synthetic keys");
  const added = await call(hookAdd, "/api/v1/hooks", writer.key, { url: `https://hooks.example.com/in-${n}`, events: ["sale.completed"] });
  if (added.status !== 200) throw new Error(`no endpoint: ${JSON.stringify(added.body)}`);
  return { owner, writer: writer.key, reader: reader.key, id: String(added.body.data!.id), secret: String(added.body.data!.secret) };
}

async function main(): Promise<void> {
  redis.clear();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never } });
  const one = await shop(1);
  const two = await shop(2);
  const hooksUsed = async (owner: string) => allowanceUsed((await storeForEmail(owner))!, "webhook");

  part("Who may send one, and to which endpoint");
  let before = received.length;
  const readOnly = await call(hookTest, "/api/v1/hooks/test", one.reader, { id: one.id });
  is("a key made to read is refused", [readOnly.status, readOnly.body.error], [403, "read_only"]);
  const badId = await call(hookTest, "/api/v1/hooks/test", one.writer, { id: "not-an-id" });
  is("an id that cannot be one is 400", [badId.status, badId.body.error], [400, "invalid_id"]);
  const noId = await call(hookTest, "/api/v1/hooks/test", one.writer, {});
  is("no id is 400", [noId.status, noId.body.error], [400, "invalid_id"]);
  const theirs = await call(hookTest, "/api/v1/hooks/test", one.writer, { id: two.id });
  is("another store's endpoint is not found", [theirs.status, theirs.body.error], [404, "not_found"]);
  is("nothing was sent for any of them", received.length, before);
  is("and no delivery taken", await hooksUsed(one.owner), 0);

  part("Sent, signed, and said how it went");
  commands = [];
  const sent = await call(hookTest, "/api/v1/hooks/test", one.writer, { id: one.id });
  const msg = received.at(-1)!;
  is("200, delivered, with the status the address answered", [sent.status, sent.body.data?.delivered, sent.body.data?.status, sent.body.data?.error], [200, true, 200, null]);
  is("the answer names the delivery and the endpoint", [/^dlv_[0-9a-f]{24}$/.test(String(sent.body.data?.delivery)), sent.body.data?.endpoint, sent.body.data?.type], [true, one.id, "test"]);
  is("one message reached the address", received.length, before + 1);
  is("a test, signed under the endpoint's secret like every message", [msg.headers["marktmorgen-event-type"], verify(one.secret, String(msg.headers["marktmorgen-signature"]), msg.body)], ["test", true]);
  is("it says it was sent with an API key, and that nothing happened", (JSON.parse(msg.body) as { data: { message: string } }).data.message, TEST_MESSAGE_WORDS.api);
  is("one of the month's webhook deliveries", await hooksUsed(one.owner), 1);
  is("the delivery log is not read back for the answer", commands.some((c) => c[0] === "LRANGE" && String(c[1]).startsWith("nl:hooks:log:")), false);
  const listed = (await webhooksView((await storeForEmail(one.owner))!)).log.find((d) => d.id === sent.body.data?.delivery);
  is("listed with the store's deliveries, as the studio's test is", listed !== undefined, true);

  part("An address that fails is said as failed, tried once");
  answers.push(500);
  before = received.length;
  const failed = await call(hookTest, "/api/v1/hooks/test", one.writer, { id: one.id });
  is("200 with delivered false, the status and why", [failed.status, failed.body.data?.delivered, failed.body.data?.status, typeof failed.body.data?.error === "string" && String(failed.body.data?.error).length > 0], [200, false, 500, true]);
  is("tried once", received.length, before + 1);
  const failedRow = (await webhooksView((await storeForEmail(one.owner))!)).log.find((d) => d.id === failed.body.data?.delivery);
  is("never put back on the schedule", failedRow?.state, "failed");

  part("Ten a minute for the store");
  const tries: number[] = [];
  // Two were sent above in this minute; eight more make ten.
  for (let i = 0; i < 8; i += 1) tries.push((await call(hookTest, "/api/v1/hooks/test", one.writer, { id: one.id })).status);
  is("up to ten in the minute are sent", tries.every((s) => s === 200), true);
  before = received.length;
  const usedBefore = await hooksUsed(one.owner);
  const eleventh = await call(hookTest, "/api/v1/hooks/test", one.writer, { id: one.id });
  is("the eleventh is 429 rate_limited", [eleventh.status, eleventh.body.error], [429, "rate_limited"]);
  is("nothing sent, no delivery taken", [received.length, await hooksUsed(one.owner)], [before, usedBefore]);

  part("With the month's deliveries used, refused before anything is sent");
  const store2 = (await storeForEmail(two.owner))!;
  for (;;) if (!(await takeAllowance(store2, "webhook")).ok) break;
  before = received.length;
  const used = await call(hookTest, "/api/v1/hooks/test", two.writer, { id: two.id });
  is("429 monthly_limit with the month's sentence", [used.status, used.body.error, typeof used.body.message === "string" && used.body.message.length > 0], [429, "monthly_limit", true]);
  is("nothing sent", received.length, before);

  part("While the renewal is unpaid, it waits with the pause's sentence");
  await setSubscription(one.owner, { active: true, period: paidPeriod(), renewalUnpaid: true });
  before = received.length;
  const usedPaused = await hooksUsed(one.owner);
  const paused = await call(hookTest, "/api/v1/hooks/test", one.writer, { id: one.id });
  is("409 paused_unpaid, the API's own sentence", [paused.status, paused.body.error, paused.body.message], [409, "paused_unpaid", API_WRITE_PAUSED_WORDS.paused_unpaid]);
  is("nothing sent, no delivery taken", [received.length, await hooksUsed(one.owner)], [before, usedPaused]);

  server.close();
  done();
}

void main();
