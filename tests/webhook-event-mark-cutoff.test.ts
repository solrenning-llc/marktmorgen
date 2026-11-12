/**
 * RED (mail-queue hunt): emitEvent (lib/webhooks.ts) takes the event's once-only mark first and writes its
 * deliveries after; when the writes fail it deletes the mark "so the next time it is noticed it is written again".
 * The five-minute job runs it under withCutoff (app/api/cron/mail/route.ts), and every Redis call goes through
 * `timed`, which throws "fetch failed" for any request once the cutoff has passed (lib/fetch-timeout.ts). A cutoff
 * that falls between the mark and the writes therefore fails the writes AND the compensating DEL: the mark stays for
 * EVENT_SECONDS (30 days), the Stripe event is read again next run (the anchor did not move past it), emitEvent
 * answers "already sent" (0), the anchor moves on, and the event is never delivered to any endpoint.
 *
 * Now the mark is read first and taken only after the deliveries are written (their ids are deterministic and
 * written SET NX / ZADD NX, so this cannot send twice): wherever the cutoff falls, the endpoint hears the event
 * exactly once. Synthetic only: in-memory Redis, local HTTP server.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { addEndpoint, deliverDue, emitEvent, setSendHooksForTests } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const received: string[] = [];
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk.toString()));
  request.on("end", () => {
    received.push(body);
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

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
/** The key prefix after whose first write the cutoff "passes": every later call throws, as `timed` does. */
let cutAfter: string | null = null;
let past = false;
redis.pipeline = (async (commands: Cmd[]) => {
  if (past) throw new TypeError("fetch failed", { cause: new Error("there was no time left to ask") });
  const [only] = commands;
  if (commands.length === 1 && only[0] === "EVAL" && String(only[1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) {
    const [, , , key, member, now, until] = only.map(String);
    const [due] = await original([["ZSCORE", key, member]]);
    if (due === null || due === undefined || Number(due) > Number(now)) return [0];
    await original([["ZADD", key, Number(until), member]]);
    return [1];
  }
  const out = await original(commands);
  if (cutAfter && commands.some((cmd) => cmd[0] === "SET" && String(cmd[1]).startsWith(cutAfter!))) past = true;
  return out;
}) as typeof redis.pipeline;

async function attempt(work: () => Promise<number>): Promise<string> {
  try {
    return `returned ${await work()}`;
  } catch (error) {
    return error instanceof Error ? error.name : "threw";
  }
}

async function main(): Promise<void> {
  redis.clear();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never } });

  await claimHandle("hook-cut@example.com", "hook-cut-shop", "Hook Cut Shop", "");
  await ensureStatsId("hook-cut@example.com");
  await setSubscription("hook-cut@example.com", { customerId: "cus_HookCut00001", subscriptionId: "sub_HookCut00001", active: true, period: paidPeriod() });
  const store = (await storeForEmail("hook-cut@example.com"))!;
  const added = await addEndpoint(store, "https://hooks.example.com/sales", ["sale.completed"]);
  if (!added.ok) throw new Error("not added");

  part("Healthy control");
  is("an event is sent once", [await attempt(() => emitEvent(store, "sale.completed", "cs_cut_ok", { amount_cents: 6900 })), received.length], ["returned 1", 1]);

  // Wherever the cutoff falls, the event is noticed again next run (the caller's anchor stays before it unless the
  // call returned), and the job's deliverDue sends what is queued: the endpoint hears it exactly once.
  const cases: [string, string, string][] = [
    ["the cutoff passes right after the event's once-only mark lands", "nl:hooks:evt:", "cs_cut_mark"],
    ["the cutoff passes right after the deliveries are written", "nl:hooks:d:", "cs_cut_dlv"],
  ];
  for (const [title, prefix, seed] of cases) {
    part(title);
    const before = received.length;
    cutAfter = prefix;
    const first = await attempt(() => emitEvent(store, "sale.completed", seed, { amount_cents: 6900 }));
    cutAfter = null;
    past = false;
    // A call that threw leaves the anchor before the event: it is noticed again. One that returned moved past it.
    if (first !== "returned 1") await attempt(() => emitEvent(store, "sale.completed", seed, { amount_cents: 6900 }));
    await deliverDue(Date.now() + 30_000, Date.now() + 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    is("the event reaches its endpoint exactly once", received.length - before, 1);
    await attempt(() => emitEvent(store, "sale.completed", seed, { amount_cents: 6900 }));
    await deliverDue(Date.now() + 30_000, Date.now() + 120_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    is("and never again when noticed once more", received.length - before, 1);
  }

  server.close();
  done();
}

main().catch((error) => {
  console.error(error);
  server.close();
  process.exit(1);
});
