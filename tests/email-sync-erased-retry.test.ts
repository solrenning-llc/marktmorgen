/**
 * #4266 (Codex L, hidden #3948): a worker that read an email-sync job before the person's erasure writes it back (SET) and
 * re-queues it (ZADD) after forgetSyncPerson deleted it, when its attempt ends as "retrying".
 * Synthetic only: the in-memory Redis stand-in; no provider is reached (the sealed key does not open, which is a
 * retryable outcome taken before any provider call; a paused provider call ending in a retryable error takes the
 * same runClaimed branch, lib/email-sync.ts:445).
 */
import { forgetSyncPerson, syncDue, QUEUE_KEY } from "@/lib/email-sync";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "zz3948stats";
const ID = "esj_" + "c".repeat(24);
const EMAIL = "erased-buyer@example.com";
const logKey = `nl:esync:log:${STATS}`;
const jobKey = `nl:esync:j:${ID}`;
const cfgKey = `nl:esync:cfg:${STATS}`;
type Batch = (string | number)[][];

async function main(): Promise<void> {
  redis.clear();
  globalThis.fetch = (async () => { throw new Error("no provider call expected"); }) as typeof fetch;
  const now = Date.now();
  const job = { id: ID, statsId: STATS, email: EMAIL, firstName: "Ada", products: [], title: "Paid course", source: "purchase", attempts: 0, state: "queued", next: now - 1000, lastError: "", note: "", lastAt: 0, createdAt: now - 2000 };
  await redis.pipeline([
    ["SET", cfgKey, JSON.stringify({ handle: "zz3948", provider: "kit", key: "sealed-stand-in", last4: "0000", target: { id: "t1", name: "Synthetic list" }, free: true, buyers: "all", products: [], tags: {}, since: now - 60_000, connectedAt: now - 60_000 })],
    ["SET", jobKey, JSON.stringify(job)],
    ["RPUSH", logKey, ID],
    ["ZADD", QUEUE_KEY, now - 1000, `${STATS}|${ID}`],
  ]);

  part("the erasure lands while the worker is inside attempt()");
  const original = redis.pipeline.bind(redis);
  let erased: number | null = null;
  let inErasure = false;
  redis.pipeline = (async (batch: Batch) => {
    const [command] = batch;
    // The queue's lease (LEASE_SCRIPT), which the stand-in does not run, by its three steps.
    if (batch.length === 1 && command?.[0] === "EVAL") {
      const [, , , key, member, at, until] = command;
      const due = redis.run(["ZSCORE", String(key), String(member)]);
      if (due === null || Number(due) > Number(at)) return [0];
      redis.run(["ZADD", String(key), Number(until), String(member)]);
      return [1];
    }
    // attempt() reads the config after runClaimed read the job: the person's erasure completes right here.
    if (!inErasure && erased === null && batch.length === 1 && command?.[0] === "GET" && command[1] === cfgKey) {
      inErasure = true;
      erased = await forgetSyncPerson(STATS, EMAIL);
      inErasure = false;
    }
    return original(batch);
  }) as typeof redis.pipeline;
  await syncDue(now + 60_000, now);
  redis.pipeline = original;

  is("the erasure deleted the person's one job", erased, 1);
  is("after completed erasure, the job record holding the address is gone", redis.run(["GET", jobKey]), null);
  is("after completed erasure, the job is not queued again", redis.run(["ZSCORE", QUEUE_KEY, `${STATS}|${ID}`]), null);
  const back = redis.run(["GET", jobKey]);
  if (typeof back === "string") is("(evidence) the recreated record holds the erased address", JSON.parse(back).email, EMAIL);
  is("(evidence) the erasure had reported this part finished, yet a repeat erasure finds a job again", await forgetSyncPerson(STATS, EMAIL), 0);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
