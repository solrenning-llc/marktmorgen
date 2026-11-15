/**
 * The email job (app/api/cron/mail) reads the store behind a scheduled email
 * exactly (CX-123 rule 24): a store read that came back out of shape is
 * unknown, never "the store is not here anymore".
 *
 * Before, the job loaded stores with storeForHandle, which answers null both
 * for a store that is gone and for a reply out of shape. One garbled reply at
 * the minute a scheduled broadcast fell due marked it "failed" and took it off
 * the queue for good, and a due sequence step dropped everyone in its batch
 * from the sequence, silently. Now such a read throws: the broadcast stays in
 * line and the step goes back in the queue, both taken up by a later run.
 *
 * Synthetic data only; no email is sent.
 */
import { GET as mail } from "@/app/api/cron/mail/route";
import { claimHandle, ensureListId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

delete process.env.CRON_SECRET;
process.env.RESEND_API_KEY = "re_test_scheduled_store_unknown";
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const request = { headers: new Headers(), nextUrl: new URL("https://marktmorgen.com/api/cron/mail") } as unknown as Parameters<typeof mail>[0];
const HANDLE = "sched-unknown";
const HANDLE_KEY = `nl:store:handle:${HANDLE}`;
const BC = "333333333333333333333333";
const BC_KEY = `nl:mail:bc:${BC}`;
const BC_QUEUE = "nl:mail:queue";
const FLOW_QUEUE = "nl:mail:flowq";
const FLOW_LEASE = "nl:mail:flowq:lease";

const pipeline = redis.pipeline.bind(redis);
/** While true, every read of the store's handle key answers out of shape. */
let garbled = false;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (garbled && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === HANDLE_KEY) return [1];
  return pipeline(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const owner = "sched-unknown-owner@example.com";
  await claimHandle(owner, HANDLE, "Scheduled Unknown", "");
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_SchedUnk01", subscriptionId: "sub_SchedUnk01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Scheduled Unknown", address: "1 Test Street, Test City" });
  const store = (await storeForEmail(owner))!;
  const now = Math.floor(Date.now() / 1000);

  // A broadcast scheduled earlier and due now, not listed yet.
  const scheduled = { id: BC, listId: store.listId, handle: store.handle, subject: "Subject", body: "Message", productId: null, notProductId: null, who: "all", narrow: null, status: "scheduled", createdAt: now - 3_600, sendAt: now - 60, finishedAt: 0, total: 0, sent: 0, note: "", failures: 0, listed: false, tagged: true, test: null };
  // A sequence step due now for one person (no flow needs to exist: the store is read first).
  const member = `${store.listId}|${store.handle}|flowx|0|reader@example.com`;
  await pipeline([
    ["SET", BC_KEY, JSON.stringify(scheduled)],
    ["SADD", BC_QUEUE, BC],
    ["ZADD", FLOW_QUEUE, now - 60, member],
  ]);

  part("The store reads out of shape when the scheduled email falls due");
  garbled = true;
  const response = await mail(request);
  garbled = false;
  is("the job answers", response.status, 200);
  const after = JSON.parse(String((await pipeline([["GET", BC_KEY]]))[0])) as { status: string; note: string };
  is("the broadcast is not failed as if its store were gone", after.status, "scheduled");
  is("the broadcast stays in line", (await pipeline([["SISMEMBER", BC_QUEUE, BC]]))[0], 1);
  const queued = (await pipeline([["ZSCORE", FLOW_QUEUE, member]]))[0];
  const leased = (await pipeline([["ZSCORE", FLOW_LEASE, member]]))[0];
  is("the sequence step is kept for a later run, not dropped", queued !== null || leased !== null, true);

  part("A confirmed absent store still ends them, as before");
  await pipeline([["DEL", HANDLE_KEY], ["ZADD", FLOW_QUEUE, now - 60, member], ["ZREM", FLOW_LEASE, member], ["DEL", "nl:mail:lock"]]);
  const gone = await mail(request);
  is("the job answers", gone.status, 200);
  const ended = JSON.parse(String((await pipeline([["GET", BC_KEY]]))[0])) as { status: string };
  is("the broadcast of a store that is gone fails", ended.status, "failed");
  is("and leaves the line", (await pipeline([["SISMEMBER", BC_QUEUE, BC]]))[0], 0);
  is("the step of a store that is gone is dropped", [(await pipeline([["ZSCORE", FLOW_QUEUE, member]]))[0], (await pipeline([["ZSCORE", FLOW_LEASE, member]]))[0]], [null, null]);

  done();
}

void main();
