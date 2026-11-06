/**
 * Sending a failed webhook delivery again, by hand, from the log (378 [TB4]
 * unit 3), delivered to a real local HTTP server through lib/safe-fetch.ts.
 * Checked: only a delivery that failed for good, of this store, to an
 * endpoint it still has; the same message and event id, signed afresh; tried
 * once and never put back on the schedule, and not again while a resend is
 * delivered; two presses at once send once; not to an endpoint that no longer
 * hears that event; one of the month's deliveries,
 * taken before the call; the tests' limit a minute shared; another store
 * cannot resend it; the route offers it and pauses it like a test.
 */
import { createHmac } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { readFileSync } from "node:fs";
import { MAX_ATTEMPTS, RETRY_MINUTES, addEndpoint, deliverDue, emitEvent, removeEndpoint, resendDelivery, setEndpointEvents, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
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

/** How a receiver checks: the timestamp, then any v1 that its one secret matches. */
function accepts(secret: string, header: string, body: string): boolean {
  const parts = header.split(",");
  const t = /^t=(\d+)$/.exec(parts[0] ?? "")?.[1];
  if (!t) return false;
  const want = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return parts.slice(1).some((part) => part === `v1=${want}`);
}
const v1Count = (header: string) => header.split(",").filter((part) => /^v1=[0-9a-f]{64}$/.test(part)).length;

// The webhook queue's lease script, modelled as Redis runs it (as in tests/webhooks-delivery.test.ts).
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
  await claimHandle("re-one@example.com", "re-first", "Re First", "");
  await claimHandle("re-two@example.com", "re-second", "Re Second", "");
  await ensureStatsId("re-one@example.com");
  await ensureStatsId("re-two@example.com");
  await setSubscription("re-one@example.com", { customerId: "cus_ReOne0000001", subscriptionId: "sub_ReOne0000001", active: true, period: paidPeriod() });
  await setSubscription("re-two@example.com", { customerId: "cus_ReTwo0000001", subscriptionId: "sub_ReTwo0000001", active: true, period: paidPeriod() });
  const one = (await storeForEmail("re-one@example.com"))!;
  const two = (await storeForEmail("re-two@example.com"))!;
  const added = await addEndpoint(one, "https://hooks.example.com/sales", ["sale.completed"]);
  if (!added.ok) throw new Error("not added");

  part("A delivery that fails for good");
  answers.push(...Array.from({ length: MAX_ATTEMPTS }, () => 500));
  await emitEvent(one, "sale.completed", "cs_re_0001", { amount_cents: 100 });
  let when = Date.now();
  for (const minutes of RETRY_MINUTES) {
    when += minutes * 60_000 + 1000;
    await deliverDue(Date.now() + 10_000, when);
  }
  const failed = (await webhooksView(one)).log.find((d) => d.state === "failed")!;
  is("it is failed after every try", [Boolean(failed), failed?.attempts], [true, MAX_ATTEMPTS]);
  const firstBody = received[0].body;

  part("Sent again by hand");
  const used = await allowanceUsed(one, "webhook");
  const sentBefore = received.length;
  const again = await resendDelivery(one, failed.id);
  if (!again.ok) throw new Error(`not resent: ${again.reason}`);
  const message = received[sentBefore];
  is("the same message and event id, signed afresh with the secret", [message?.body === firstBody, String(message?.headers["marktmorgen-event-id"]) === failed.eventId, accepts(added.secret, String(message?.headers["marktmorgen-signature"]), message?.body ?? "")], [true, true, true]);
  is("delivered, as a new line naming the one it sends again", [again.delivery.state, again.view.log[0].resentFrom], ["delivered", failed.id]);
  is("one of the month's deliveries", await allowanceUsed(one, "webhook"), used + 1);
  is("a delivered one is never resent by hand", await resendDelivery(one, again.delivery.id), { ok: false, reason: "not_failed" });
  is("another store cannot resend it", await resendDelivery(two, failed.id), { ok: false, reason: "missing" });
  is("a made-up id is refused", await resendDelivery(one, "dlv_not_a_real_one"), { ok: false, reason: "missing" });

  is("once delivered by hand, not again", await resendDelivery(one, failed.id), { ok: false, reason: "resent" });
  is("the studio sees which resend an original has", (await webhooksView(one)).log.find((d) => d.id === failed.id)?.resentAs, again.delivery.id);

  // Another delivery that fails for good, for the rest.
  const failAll = async (seed: string) => {
    answers.push(...Array.from({ length: MAX_ATTEMPTS }, () => 500));
    await emitEvent(one, "sale.completed", seed, { amount_cents: 200 });
    let at = Date.now();
    for (const minutes of RETRY_MINUTES) {
      at += minutes * 60_000 + 1000;
      await deliverDue(Date.now() + 10_000, at);
    }
    return (await webhooksView(one)).log.find((d) => d.state === "failed" && d.attempts === MAX_ATTEMPTS && !d.resentFrom && d.id !== failed.id && !seen.has(d.id))!;
  };
  const seen = new Set<string>();
  const second = await failAll("cs_re_0002");
  seen.add(second.id);

  part("Tried once, never put back on the schedule");
  answers.push(500);
  const tryAgain = await resendDelivery(one, second.id);
  if (!tryAgain.ok) throw new Error(`not resent: ${tryAgain.reason}`);
  is("a failed resend is shown failed, with nothing waiting", [tryAgain.delivery.state, tryAgain.delivery.next], ["failed", 0]);
  const sent = received.length;
  await deliverDue(Date.now() + 10_000, Date.now() + 25 * 3_600_000);
  is("the job does not try it again", received.length, sent);
  is("a copy that failed is not sent again itself; the original is", await resendDelivery(one, tryAgain.delivery.id), { ok: false, reason: "resent" });
  is("after a failed resend it may be sent again", (await resendDelivery(one, second.id)).ok, true);

  part("Two presses at once send once");
  const third = await failAll("cs_re_0003");
  seen.add(third.id);
  const before = received.length;
  const both = await Promise.all([resendDelivery(one, third.id), resendDelivery(one, third.id)]);
  is("one goes, the other is told it was sent again", [both.filter((r) => r.ok).length, both.filter((r) => !r.ok && r.reason === "resent").length, received.length - before], [1, 1, 1]);

  part("The minute's limit, shared with tests");
  const fifth = await failAll("cs_re_0005");
  seen.add(fifth.id);
  let limited = false;
  // The limit a minute is the tests' own (lib/webhooks.ts); thirty presses are well past it.
  for (let i = 0; i < 30 && !limited; i += 1) {
    answers.push(500);
    const r = await resendDelivery(one, fifth.id);
    if (!r.ok && r.reason === "limited") limited = true;
  }
  is("past the limit a minute, refused", limited, true);

  part("Not to an endpoint that no longer hears it, nor to one removed");
  const endpointId = (await webhooksView(one)).endpoints[0].id;
  await setEndpointEvents(one, endpointId, ["refund.issued"]);
  is("the event taken off the endpoint: refused", await resendDelivery(one, fifth.id), { ok: false, reason: "not_heard" });
  await setEndpointEvents(one, endpointId, ["sale.completed"]);
  await removeEndpoint(one, endpointId);
  is("the endpoint removed: refused", await resendDelivery(one, fifth.id), { ok: false, reason: "missing" });

  part("The studio's route offers it");
  const route = readFileSync("app/api/store/webhooks/route.ts", "utf8");
  is("action resend, paused like a test", [/action === "resend"/.test(route), /resendDelivery\(store, text\(guarded\.body\.delivery, 40\)\)/.test(route), /action === "resend"[\s\S]{0,200}integrationPauseWord\(store\)/.test(route)], [true, true, true]);

  server.close();
  done();
}

main().catch((error) => {
  console.error(error);
  server.close();
  process.exit(1);
});
