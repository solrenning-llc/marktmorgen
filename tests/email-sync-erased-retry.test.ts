/**
 * #4266 (from Codex L's hidden #3948): a worker that read an email-sync job before the person's erasure must not
 * write it back (SET) or queue it again (ZADD) after forgetSyncPerson deleted it, and must not send it to the
 * platform once the erasure has deleted it.
 * Synthetic only: the in-memory Redis stand-in; no provider is reached (the sealed key does not open, which is a
 * retryable outcome taken before any provider call; a provider call ending in a retryable error writes its outcome
 * the same way, lib/email-sync.ts runClaimed).
 */
import { forgetSyncPerson, syncDue, QUEUE_KEY } from "@/lib/email-sync";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "zz4266stats";
const ID = "esj_" + "c".repeat(24);
const EMAIL = "erased-buyer@example.com";
const logKey = `nl:esync:log:${STATS}`;
const jobKey = `nl:esync:j:${ID}`;
const cfgKey = `nl:esync:cfg:${STATS}`;
const badKey = `nl:esync:bad:${STATS}`;
const member = `${STATS}|${ID}`;
type Batch = (string | number)[][];

async function seed(now: number): Promise<void> {
  redis.clear();
  const job = { id: ID, statsId: STATS, email: EMAIL, firstName: "Ada", products: [], title: "Paid course", source: "purchase", attempts: 0, state: "queued", next: now - 1000, lastError: "", note: "", lastAt: 0, createdAt: now - 2000 };
  await redis.pipeline([
    ["SET", cfgKey, JSON.stringify({ handle: "zz4266", provider: "kit", key: "sealed-stand-in", last4: "0000", target: { id: "t1", name: "Synthetic list" }, free: true, buyers: "all", products: [], tags: {}, since: now - 60_000, connectedAt: now - 60_000 })],
    ["SET", jobKey, JSON.stringify(job)],
    ["RPUSH", logKey, ID],
    ["ZADD", QUEUE_KEY, now - 1000, member],
  ]);
}

/** Runs the queue once, completing the person's erasure the first time a batch matches `when`. */
async function runWithErasure(now: number, when: ((batch: Batch) => boolean) | null): Promise<number | null> {
  const original = redis.pipeline.bind(redis);
  let erased: number | null = null;
  let inErasure = false;
  redis.pipeline = (async (batch: Batch) => {
    const [command] = batch;
    // The queue's lease (LEASE_SCRIPT), which the stand-in does not run, by its three steps.
    if (batch.length === 1 && command?.[0] === "EVAL" && String(command[1]).startsWith('local due = redis.call("ZSCORE"')) {
      const [, , , key, leased, at, until] = command;
      const due = redis.run(["ZSCORE", String(key), String(leased)]);
      if (due === null || Number(due) > Number(at)) return [0];
      redis.run(["ZADD", String(key), Number(until), String(leased)]);
      return [1];
    }
    if (when && !inErasure && erased === null && when(batch)) {
      inErasure = true;
      erased = await forgetSyncPerson(STATS, EMAIL);
      inErasure = false;
    }
    return original(batch);
  }) as typeof redis.pipeline;
  try {
    await syncDue(now + 60_000, now);
  } finally {
    redis.pipeline = original;
  }
  return erased;
}

async function main(): Promise<void> {
  globalThis.fetch = (async () => {
    throw new Error("no provider call expected");
  }) as typeof fetch;
  const now = Date.now();

  part("the erasure lands while the worker reads the settings, before the platform is asked");
  await seed(now);
  let erased = await runWithErasure(now, (batch) => batch.some((c) => c[0] === "GET" && c[1] === cfgKey));
  is("the erasure deleted the person's one job", erased, 1);
  is("the job record holding the address is gone", redis.run(["GET", jobKey]), null);
  is("the job is not queued again", redis.run(["ZSCORE", QUEUE_KEY, member]), null);
  is("nothing was tried for the erased job (no key opened, no problem noted)", redis.run(["GET", badKey]), null);
  is("a repeat erasure finds nothing", await forgetSyncPerson(STATS, EMAIL), 0);

  part("the erasure lands after the try started, before its outcome is written (retrying)");
  await seed(now);
  // The sealed key does not open: attempt() notes the problem (SET bad) and the outcome is "retrying".
  erased = await runWithErasure(now, (batch) => batch.some((c) => c[0] === "SET" && c[1] === badKey));
  is("the erasure deleted the person's one job", erased, 1);
  is("after completed erasure, the job record holding the address is gone", redis.run(["GET", jobKey]), null);
  is("after completed erasure, the job is not queued again", redis.run(["ZSCORE", QUEUE_KEY, member]), null);
  const back = redis.run(["GET", jobKey]);
  if (typeof back === "string") is("(evidence) the recreated record holds the erased address", JSON.parse(back).email, EMAIL);
  is("the erasure's finished part stays finished: a repeat erasure finds nothing", await forgetSyncPerson(STATS, EMAIL), 0);
  is("the job is not back in the store's log", redis.run(["LRANGE", logKey, 0, -1]), []);

  part("without an erasure, a retryable try is still written down and queued for its next try");
  await seed(now);
  erased = await runWithErasure(now, null);
  const kept = redis.run(["GET", jobKey]);
  const job = typeof kept === "string" ? JSON.parse(kept) : null;
  is("the job is kept as retrying", job?.state, "retrying");
  is("after its first try", job?.attempts, 1);
  is("queued for its next try, five minutes on", Number(redis.run(["ZSCORE", QUEUE_KEY, member])), job?.next);
  is("still in the store's log", redis.run(["LRANGE", logKey, 0, -1]), [ID]);
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
