/**
 * A delivery line's read back is priced in the line it adds to (Claude 7 on #3446, MÉDIO cost, 6889869993).
 *
 * writeLines (lib/webhooks.ts) reads every line it wrote back once, one GET a line, when a SET answers in a shape it
 * cannot read or the call fails; a message not kept whose line is not there gives its day's count back with one DECR
 * (countNotKept). Those commands were priced only by a comment in tests/plan-cost-registry.ts. Now
 * DELIVERY_READ_BACK names them (one GET of at most DELIVERY_WRITE_MAX_BYTES and one DECR a delivery) and
 * UNIT_COST.webhook, the try every delivery's line belongs to, carries them; the notice lines' read back is said in
 * NOT_A_COST beside their daily caps.
 *
 * This test drives a lost SET reply through the real emitEvent, at MAX_ENDPOINTS endpoints with the largest message a
 * line may keep, and through a message not kept, and counts every read back's commands and bytes against
 * DELIVERY_READ_BACK.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts); no endpoint is tried and no request leaves.
 */
import { DELIVERY_WRITE_MAX_BYTES, MAX_ENDPOINTS, MESSAGE_TEXT_MAX } from "@/lib/webhook-limits";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { addEndpoint, emitEvent, setSendHooksForTests } from "@/lib/webhooks";
import { paidPeriod } from "./billing-period-fixture";
import * as registry from "./plan-cost-registry";
import { NOT_A_COST, TAKE_COMMANDS, UNIT_COST, request } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 })) as typeof fetch;
// The endpoints' names resolve to a private address: no try opens a socket.
setSendHooksForTests({ fetch: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] } });
console.error = () => {};

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** While set, a delivery line's SET runs and then answers this (a reply it cannot read). */
let lost: unknown = undefined;
let losing = false;
/** Every command sent, with what it answered, while `watching`. */
let watching: { command: Command; reply: unknown }[] | null = null;
redis.pipeline = (async (commands: Command[]) => {
  // The queue's lease is not taken here, so no delivery is tried.
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) return [0];
  const replies = await real(commands);
  const out = commands.map((command, at) => (losing && command[0] === "SET" && String(command[1]).startsWith("nl:hooks:d:") ? lost : replies[at]));
  watching?.push(...commands.map((command, at) => ({ command, reply: out[at] })));
  return out;
}) as typeof redis.pipeline;

const reg = registry as unknown as Record<string, unknown>;
const readBack = reg.DELIVERY_READ_BACK as { commands?: unknown; bytes?: unknown } | undefined;
const isLineGet = (c: Command) => c[0] === "GET" && String(c[1]).startsWith("nl:hooks:d:");
const bytesOf = (reply: unknown) => (typeof reply === "string" ? Buffer.byteLength(reply) : 0);

async function setup(handle: string) {
  redis.clear();
  const owner = `owner-${handle}@example.com`;
  await claimHandle(owner, handle, "Read Back Shop", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_ReadBack0001", subscriptionId: "sub_ReadBack0001", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  let store = (await storeForEmail(owner))!;
  for (let n = 0; n < MAX_ENDPOINTS; n += 1) {
    if (!(await addEndpoint(store, `https://hooks${n}.example.net/read-back`, ["sale.completed"])).ok) throw new Error("setup: endpoint not added");
    store = (await storeForEmail(owner))!;
  }
  return store;
}

async function main(): Promise<void> {
  part("The read back is named, and every try of the line webhooks carries it (tests/plan-cost-registry.ts)");
  is("one GET and one DECR a delivery at the most", readBack?.commands, 2);
  is("the GET reads a line at most as large as a line may be kept", readBack?.bytes, DELIVERY_WRITE_MAX_BYTES);
  const commands = typeof readBack?.commands === "number" ? readBack.commands : NaN;
  const bytes = typeof readBack?.bytes === "number" ? readBack.bytes : NaN;
  is("UNIT_COST.webhook is a try with the read back of its delivery's line", UNIT_COST.webhook, request("wait", 20 + TAKE_COMMANDS + commands, 40_000 + bytes));
  is("the notice lines' read back is said beside their daily caps", [NOT_A_COST.GIVEN_UP_LINES_PER_DAY?.includes("read back"), NOT_A_COST.SKIPPED_LINES_PER_DAY?.includes("DECR")], [true, true]);

  part(`An emit to ${MAX_ENDPOINTS} endpoints whose SET answered in a shape it cannot read, at the largest message a line keeps`);
  for (const [name, value] of [['"QUEUED"', "QUEUED"], ["1", 1], ["undefined", undefined]] as [string, unknown][]) {
    const store = await setup(`read-back-${name.replace(/\W+/g, "") || "u"}`);
    // A large message that is still kept (one that would be kept past DELIVERY_WRITE_MAX_BYTES is never written).
    const large = { notes: Array.from({ length: 40 }, () => "a".repeat(MESSAGE_TEXT_MAX)) };
    lost = value;
    losing = true;
    watching = [];
    await emitEvent(store, "sale.completed", "cs_ReadBack01", large).catch(() => undefined);
    const sent = watching;
    watching = null;
    losing = false;
    const gets = sent.filter((s) => isLineGet(s.command));
    const lineSets = sent.filter((s) => s.command[0] === "SET" && String(s.command[1]).startsWith("nl:hooks:d:")).length;
    is(`${name}: each line written is read back once, one GET a delivery`, [lineSets, gets.length], [MAX_ENDPOINTS, MAX_ENDPOINTS]);
    is(`${name}: no count is given back for a message that was kept`, sent.filter((s) => s.command[0] === "DECR").length, 0);
    is(`${name}: each read back is a large line, at most DELIVERY_READ_BACK's bytes`, gets.every((g) => bytesOf(g.reply) > 4 * MESSAGE_TEXT_MAX && bytesOf(g.reply) <= bytes), true);
    is(`${name}: inside one GET and one DECR a delivery`, gets.length + sent.filter((s) => s.command[0] === "DECR").length <= MAX_ENDPOINTS * commands, true);
  }

  part("A message not kept whose line is not there: its lines read back, and its day's count given back once");
  {
    const store = await setup("read-back-not-kept");
    const tooLarge = { notes: Array.from({ length: 300 }, () => "x".repeat(MESSAGE_TEXT_MAX)) };
    // The SET does not land and answers a shape it cannot read: the read back finds nothing.
    redis.pipeline = ((inner) => (async (list: Command[]) => {
      if (losing && list.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:hooks:d:"))) {
        const out = list.map((c) => (c[0] === "SET" && String(c[1]).startsWith("nl:hooks:d:") ? "QUEUED" : null));
        watching?.push(...list.map((command, at) => ({ command, reply: out[at] })));
        return out;
      }
      return inner(list);
    }) as typeof redis.pipeline)(redis.pipeline);
    losing = true;
    watching = [];
    const out = await emitEvent(store, "sale.completed", "cs_NotKept01", tooLarge).then(() => "done", () => "threw");
    const sent = watching;
    watching = null;
    losing = false;
    const gets = sent.filter((s) => isLineGet(s.command)).length;
    const decrs = sent.filter((s) => s.command[0] === "DECR").length;
    is("it is not taken as stored", out, "threw");
    is("its lines are read back, at most one GET an endpoint, and its count given back once", [gets >= 1 && gets <= MAX_ENDPOINTS, decrs], [true, 1]);
    is("inside one GET and one DECR a delivery", gets + decrs <= MAX_ENDPOINTS * commands, true);
  }
  done();
}

void main();
