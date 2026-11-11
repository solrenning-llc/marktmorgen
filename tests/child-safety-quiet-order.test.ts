/**
 * The hourly quiet job sends the urgent child-safety reminders before it
 * spends any time taking held products off their stores (Claude 4 on #3486,
 * comment 6802107160; app/api/cron/quiet/route.ts).
 *
 * A busy store lock is exactly what puts a held product in the hide queue,
 * and the hide step waits on such locks; run first, it spent the reminders'
 * 15 seconds (probe: 15,749 ms, 0 reminders with 1 due). So the reminders go
 * first, and the hide step gets only the time left, within its own budget:
 * however long it takes, a due reminder is sent in the same run. Neutral,
 * synthetic products and a stand-in email provider only.
 */
import { NextRequest } from "next/server";
import { GET as quiet } from "@/app/api/cron/quiet/route";
import { ALERTS_DUE } from "@/lib/child-safety-alerts";
import { keepKey } from "@/lib/child-safety-holds";
import { POST as reportRoute } from "@/app/api/report/route";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Sent = { subject: string };
const sent: Sent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const OWNER = "quiet-order@example.com";
const HANDLE = "quietorder";
const QUEUE = "nl:csa:hide";
const WAITING = 25;

type Pipeline = typeof redis.pipeline;
type Commands = Parameters<Pipeline>[0];

/** One run of the hourly job, as the scheduler calls it. */
async function run(): Promise<{ took: number; body: Record<string, unknown> }> {
  redis.run(["DEL", "nl:quiet:lock"]);
  const started = Date.now();
  const response = await quiet(new NextRequest("https://marktmorgen.com/api/cron/quiet"));
  return { took: Date.now() - started, body: (await response.json()) as Record<string, unknown> };
}

async function main(): Promise<void> {
  redis.clear();
  delete process.env.CRON_SECRET;
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  await claimHandle(OWNER, HANDLE, "Quiet Order", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_qorder", subscriptionId: "sub_qorder", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const ids: string[] = [];
  for (let n = 0; n <= WAITING; n++) {
    const made = await addProduct(OWNER, `Neutral product ${n}`, "", "19", null);
    if (!made.ok) throw new Error("no product");
    ids.push(made.product.id);
  }
  // One report opens an alert, with its reminder 24 hours later.
  const reported = ids[WAITING];
  const response = await reportRoute(
    new NextRequest("https://marktmorgen.com/api/report", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://marktmorgen.com", host: "marktmorgen.com" },
      body: JSON.stringify({ kind: "child_safety", url: `https://marktmorgen.com/@${HANDLE}/p/${reported}`, work: "Placeholder words.", name: "", email: "reporter@example.com", signature: "", goodFaith: true, accurate: false }),
    }),
  );
  if (response.status !== 200) throw new Error("no report");
  const open = redis.run(["ZRANGEBYSCORE", ALERTS_DUE, "-inf", "+inf"]) as string[];
  if (open.length !== 1) throw new Error("no open alert");
  const store = (await storeForEmail(OWNER)) as Store;
  const tag = store.statsId || `h:${store.handle}`;
  const owner = redis.keys().find((key) => key.startsWith("nl:store:owner:"));
  if (!owner) throw new Error("no owner key");
  const lock = owner.replace("nl:store:owner:", "nl:store:lock:");
  // The other products held and waiting to be taken off, as holdReported leaves them when the hide did not go through.
  const queue = (at: number) => {
    for (const id of ids.slice(0, WAITING)) {
      redis.run(["SET", keepKey(store, id), "1", "EX", 400 * 86_400]);
      redis.run(["ZADD", QUEUE, at, JSON.stringify([storeRef(store), tag, id])]);
    }
  };
  const makeDue = () => redis.run(["ZADD", ALERTS_DUE, "XX", Date.now() - 60_000, open[0]]);
  const reminders = () => sent.filter((mail) => mail.subject.startsWith("URGENT (reminder")).length;

  part("Every store lock busy, 25 held products waiting and one reminder due (the probe)");
  queue(Date.now() - 60_000);
  makeDue();
  redis.run(["SET", lock, "another-write", "EX", 600]);
  const before = reminders();
  const busy = await run();
  console.log(`        run took ${busy.took} ms: ${JSON.stringify(busy.body)}`);
  is("the due reminder is sent in the same run", [busy.body.reminders, reminders() - before], [1, 1]);
  is("nothing taken off while the lock is busy, and nothing dropped", [busy.body.hidden, (redis.run(["ZRANGEBYSCORE", QUEUE, "-inf", "+inf"]) as string[]).length], [0, WAITING]);
  is("the run ends far inside the route's 60 s", busy.took <= 25_000, true);
  redis.run(["DEL", lock]);

  part("The hide step slow for any reason (its queue answers after 16 s): the due reminder is still sent");
  makeDue();
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => {
    if (commands.some((command) => command[0] === "ZRANGEBYSCORE" && command[1] === QUEUE)) await new Promise((resolve) => setTimeout(resolve, 16_000));
    return original.call(redis, commands);
  }) as Pipeline;
  const slowBefore = reminders();
  const slow = await run().finally(() => {
    redis.pipeline = original;
  });
  console.log(`        run took ${slow.took} ms: ${JSON.stringify(slow.body)}`);
  is("the due reminder is sent", [slow.body.reminders, reminders() - slowBefore], [1, 1]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
