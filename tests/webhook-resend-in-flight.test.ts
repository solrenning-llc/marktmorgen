/**
 * Issue #3994 (Codex P, webhooks; Claude 6 block of the coordinator's split, 5437): a press of "send again" marked the
 * original (resentAs = A) and only wrote resend A's own record after calling the endpoint. A second press in that gap
 * read the original naming A, found no record for A, took A as gone, marked the original again and called the
 * endpoint too: one failed event delivered twice.
 *
 * Now the mark also keeps when it was made (resentAt), and a resend it names that has no record yet is in flight, not
 * gone, while RESEND_IN_FLIGHT_MS has not passed. Nothing that can refuse a press comes after the mark any more (the
 * minute's limit, the paid window and the month's delivery are taken first; a press that then loses the mark gives
 * its delivery back), so a mark is left only by a press that went on to call the endpoint, or stopped while it did.
 *
 * Checked: a press during another's call is refused and the endpoint hears once; a mark whose resend never got a
 * record is taken as gone once RESEND_IN_FLIGHT_MS has passed, and not before; a press refused by the minute's limit
 * leaves the original unmarked; two presses at once send once, and the one that lost keeps no delivery of the month.
 * Synthetic store and endpoint (a local HTTP server through lib/safe-fetch.ts); in-memory Redis; no network.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { MAX_ATTEMPTS, RESEND_IN_FLIGHT_MS, RETRY_MINUTES, addEndpoint, deliverDue, emitEvent, resendDelivery, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let calls = 0;
const answers: number[] = [];
/** While set, the endpoint holds its answer until it is released: a resend paused inside its call. */
let hold: Promise<void> | null = null;
let entered: () => void = () => {};
const server = http.createServer((request, response) => {
  request.on("data", () => {});
  request.on("end", async () => {
    calls += 1;
    entered();
    if (hold) await hold;
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

// The webhook queue's lease script, modelled as Redis runs it (as in tests/webhook-resend.test.ts).
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

async function main(): Promise<void> {
  redis.clear();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never } });
  await claimHandle("inflight@example.com", "in-flight", "In Flight", "");
  await ensureStatsId("inflight@example.com");
  await setSubscription("inflight@example.com", { customerId: "cus_InFlight00001", subscriptionId: "sub_InFlight00001", active: true, period: paidPeriod() });
  const one = (await storeForEmail("inflight@example.com"))!;
  if (!(await addEndpoint(one, "https://hooks.example.com/sales", ["sale.completed"])).ok) throw new Error("not added");

  const seen = new Set<string>();
  const failAll = async (seed: string) => {
    answers.push(...Array.from({ length: MAX_ATTEMPTS }, () => 500));
    await emitEvent(one, "sale.completed", seed, { amount_cents: 200 });
    let at = Date.now();
    for (const minutes of RETRY_MINUTES) {
      at += minutes * 60_000 + 1000;
      await deliverDue(Date.now() + 10_000, at);
    }
    const found = (await webhooksView(one)).log.find((d) => d.state === "failed" && d.attempts === MAX_ATTEMPTS && !d.resentFrom && !seen.has(d.id))!;
    seen.add(found.id);
    return found;
  };
  const readOriginal = async (id: string) => JSON.parse(String(redis.run(["GET", `nl:hooks:d:${id}`]))) as { resentAs?: string; resentAt?: number };

  part("A press during another press's call to the endpoint is refused, and the endpoint hears once");
  {
    const failed = await failAll("cs_fl_0001");
    let release: () => void = () => {};
    hold = new Promise<void>((resolve) => (release = resolve));
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const before = calls;
    const first = resendDelivery(one, failed.id);
    await inside;
    // The first press has marked the original and is waiting on the endpoint; its own record is not written yet.
    is("the original names the resend under way, and when it was marked", typeof (await readOriginal(failed.id)).resentAt, "number");
    const second = await resendDelivery(one, failed.id);
    is("the second press is told it was sent again, and never calls the endpoint", [second.ok ? "sent" : second.reason, calls - before], ["resent", 1]);
    release();
    hold = null;
    entered = () => {};
    const done1 = await first;
    is("the first press is delivered", done1.ok && done1.delivery.state, "delivered");
    is("the endpoint heard this event once", calls - before, 1);
  }

  part("A mark whose resend never got a record is gone only once RESEND_IN_FLIGHT_MS has passed");
  {
    const failed = await failAll("cs_fl_0002");
    const key = `nl:hooks:d:${failed.id}`;
    const left = JSON.parse(String(redis.run(["GET", key])));
    // A press that stopped while it called the endpoint: the mark landed, its record never did.
    redis.run(["SET", key, JSON.stringify({ ...left, resentAs: "dlv_000000000000000000000000", resentAt: Date.now() }), "KEEPTTL"]);
    is("inside the window: refused, nothing sent", (await resendDelivery(one, failed.id)).ok ? "sent" : "refused", "refused");
    redis.run(["SET", key, JSON.stringify({ ...left, resentAs: "dlv_000000000000000000000000", resentAt: Date.now() - RESEND_IN_FLIGHT_MS - 1 }), "KEEPTTL"]);
    const after = await resendDelivery(one, failed.id);
    is("past it: sent again", after.ok && after.delivery.state, "delivered");
    redis.run(["SET", `nl:hooks:d:${failed.id}`, JSON.stringify({ ...left, resentAs: "dlv_111111111111111111111111" }), "KEEPTTL"]);
    const old = await resendDelivery(one, failed.id);
    is("a mark from before resentAt (none kept) whose resend is gone: sent again, as before", old.ok && old.delivery.state, "delivered");
  }

  part("Two presses at once send once; the one that lost keeps no delivery of the month");
  {
    const failed = await failAll("cs_fl_0003");
    const used = await allowanceUsed(one, "webhook");
    const before = calls;
    const both = await Promise.all([resendDelivery(one, failed.id), resendDelivery(one, failed.id)]);
    is("one goes, the other is told it was sent again", [both.filter((r) => r.ok).length, both.filter((r) => !r.ok && r.reason === "resent").length, calls - before], [1, 1, 1]);
    is("one delivery of the month taken, not two", await allowanceUsed(one, "webhook"), used + 1);
  }

  part("A press refused by the minute's limit leaves the original unmarked");
  {
    const failed = await failAll("cs_fl_0004");
    let limited = false;
    for (let i = 0; i < 30 && !limited; i += 1) {
      answers.push(500);
      const r = await resendDelivery(one, failed.id);
      if (!r.ok && r.reason === "limited") limited = true;
    }
    const markBefore = (await readOriginal(failed.id)).resentAs;
    const refused = await resendDelivery(one, failed.id);
    is("refused by the limit", refused.ok ? "sent" : refused.reason, "limited");
    is("and its mark is the one before it, not a new one", (await readOriginal(failed.id)).resentAs, markBefore);
  }

  server.close();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
