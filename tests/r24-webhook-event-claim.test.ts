/**
 * A webhook event's once-only mark is read exactly (lib/webhooks.ts, emitEvent; CX-123 rule 24, lib/claim-mark.ts).
 *
 * Before: the event's SET NX counted as "this run's to send" on any reply but nil, so a reply in another shape (or a
 * pipeline that answered nothing) made the deliveries and called the creator's endpoint without a mark known to be
 * ours: when the mark had not landed the event was sent again the next time it was noticed, and when the mark was an
 * earlier send's (its deliveries already gone, after a week) a signed duplicate reached the creator's system. Now the
 * mark is ours only on exactly "OK" or on our own value read back; nil, or another value read back, is an event
 * already sent; anything else is unknown: nothing is made or sent, and the call throws so its caller tries again.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts), a local HTTP server behind lib/safe-fetch.ts.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { addEndpoint, emitEvent, eventIdFor, setSendHooksForTests } from "@/lib/webhooks";
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
const isMark = (cmd: Cmd) => cmd[0] === "SET" && String(cmd[1]).startsWith("nl:hooks:evt:") && cmd.includes("NX");
/**
 * How the event mark's SET NX answers: "landed" writes it and answers `reply`; "lost" writes nothing and answers
 * `reply`; "short" writes nothing and the pipeline answers no replies at all. Everything else as Redis runs it.
 */
let markMode: { how: "landed" | "lost" | "short"; reply?: unknown } | null = null;
/** The event mark whose next read-back (a GET of it alone) throws, as a second timeout would. */
let readBackFails: string | null = null;
redis.pipeline = (async (commands: Cmd[]) => {
  const [only] = commands;
  if (readBackFails && commands.length === 1 && only[0] === "GET" && only[1] === readBackFails) {
    readBackFails = null;
    throw new Error("synthetic: the read-back timed out");
  }
  // The queue's lease (LEASE_SCRIPT), as Redis runs it (as in tests/r24-webhook-store-read.test.ts).
  if (commands.length === 1 && only[0] === "EVAL" && String(only[1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) {
    const [, , , key, member, now, until] = only.map(String);
    const [due] = await original([["ZSCORE", key, member]]);
    if (due === null || due === undefined || Number(due) > Number(now)) return [0];
    await original([["ZADD", key, Number(until), member]]);
    return [1];
  }
  const mode = markMode;
  if (!mode || !commands.some(isMark)) return original(commands);
  if (mode.how === "short") return [];
  const kept = commands.filter((cmd) => mode.how === "landed" || !isMark(cmd));
  const out = await original(kept);
  let at = 0;
  return commands.map((cmd) => {
    if (!isMark(cmd)) return out[at++];
    if (mode.how === "landed") at += 1;
    return mode.reply;
  });
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

  await claimHandle("hook-claim@example.com", "hook-claim-shop", "Hook Claim Shop", "");
  await ensureStatsId("hook-claim@example.com");
  await setSubscription("hook-claim@example.com", { customerId: "cus_HookClaim0001", subscriptionId: "sub_HookClaim0001", active: true, period: paidPeriod() });
  const store = (await storeForEmail("hook-claim@example.com"))!;
  const added = await addEndpoint(store, "https://hooks.example.com/sales", ["sale.completed"]);
  if (!added.ok) throw new Error("not added");
  const markOf = (seed: string) => `nl:hooks:evt:${eventIdFor(store.statsId!, "sale.completed", seed)}`;
  const deliveriesGone = async () => {
    const [ids] = await original([["LRANGE", `nl:hooks:log:${store.statsId}`, 0, -1]]);
    if (Array.isArray(ids) && ids.length) await original(ids.map((id) => ["DEL", `nl:hooks:d:${String(id)}`]));
  };

  part("Healthy control: an event is sent once on exactly OK, and not again on nil");
  is("sent at once to the endpoint", [await attempt(() => emitEvent(store, "sale.completed", "cs_claim_ok", { amount_cents: 6900 })), received.length], ["returned 1", 1]);
  is("noticed again: nil, already sent, nothing made", [await attempt(() => emitEvent(store, "sale.completed", "cs_claim_ok", { amount_cents: 6900 })), received.length], ["returned 0", 1]);

  part("The mark's reply lost after it landed: our own value read back, sent once");
  markMode = { how: "landed", reply: "QUEUED" };
  is("read back as ours and sent", [await attempt(() => emitEvent(store, "sale.completed", "cs_claim_landed", { amount_cents: 6900 })), received.length], ["returned 1", 2]);
  markMode = null;
  is("noticed again: not sent twice", [await attempt(() => emitEvent(store, "sale.completed", "cs_claim_landed", { amount_cents: 6900 })), received.length], ["returned 0", 2]);

  part("A reply in another shape, the mark not written: unknown, nothing sent, tried again later");
  markMode = { how: "lost", reply: "QUEUED" };
  is("unknown: it throws, and the endpoint is not called", [await attempt(() => emitEvent(store, "sale.completed", "cs_claim_lost", { amount_cents: 6900 })), received.length], ["UnknownReplyError", 2]);
  markMode = { how: "lost", reply: undefined };
  is("an undefined reply is unknown too", [await attempt(() => emitEvent(store, "sale.completed", "cs_claim_lost", { amount_cents: 6900 })), received.length], ["UnknownReplyError", 2]);
  markMode = { how: "short" };
  is("a pipeline that answered nothing is unknown too", [await attempt(() => emitEvent(store, "sale.completed", "cs_claim_lost", { amount_cents: 6900 })), received.length], ["UnknownReplyError", 2]);
  is("no mark was left behind", (await original([["GET", markOf("cs_claim_lost")]]))[0], null);
  markMode = null;
  is("noticed again with Redis well: sent once", [await attempt(() => emitEvent(store, "sale.completed", "cs_claim_lost", { amount_cents: 6900 })), received.length], ["returned 1", 3]);

  part("An earlier send's mark, its deliveries gone after a week, answered in another shape: never a signed duplicate");
  is("the earlier send", [await attempt(() => emitEvent(store, "sale.completed", "cs_claim_old", { amount_cents: 6900 })), received.length], ["returned 1", 4]);
  await deliveriesGone();
  markMode = { how: "lost", reply: "QUEUED" };
  is("read back as another send's: nothing made, nothing sent", [await attempt(() => emitEvent(store, "sale.completed", "cs_claim_old", { amount_cents: 6900 })), received.length], ["returned 0", 4]);
  markMode = { how: "lost", reply: 1 };
  is("a number in place of OK is not ours either", [await attempt(() => emitEvent(store, "sale.completed", "cs_claim_old", { amount_cents: 6900 })), received.length], ["returned 0", 4]);
  markMode = null;

  part("Claude 2 on #3276, finding 1: the mark landed, its reply lost and its read-back failed: unknown, and the caller's retry sends it once");
  markMode = { how: "landed", reply: undefined };
  readBackFails = markOf("cs_claim_unread");
  is("unknown: it throws, and the endpoint is not called", [await attempt(() => emitEvent(store, "sale.completed", "cs_claim_unread", { amount_cents: 6900 })), received.length], ["UnknownReplyError", 4]);
  markMode = null;
  is("the read-back did fail", readBackFails, null);
  is("our own mark taken back, so the retry is not told it went", (await original([["GET", markOf("cs_claim_unread")]]))[0], null);
  is("the caller's retry sends it once", [await attempt(() => emitEvent(store, "sale.completed", "cs_claim_unread", { amount_cents: 6900 })), received.length], ["returned 1", 5]);
  is("and not again", [await attempt(() => emitEvent(store, "sale.completed", "cs_claim_unread", { amount_cents: 6900 })), received.length], ["returned 0", 5]);

  server.close();
  done();
}

main().catch((error) => {
  console.error(error);
  server.close();
  process.exit(1);
});
