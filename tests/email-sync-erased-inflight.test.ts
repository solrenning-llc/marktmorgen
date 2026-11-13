/**
 * #4266, review of #4392 (Codex X4, MEDIUM): the worker compares the job with the record it read, then asks the
 * platform. An erasure landing between the comparison and the platform's request used to report its part finished
 * while the request still went out with the erased address. Now the worker marks its try as in flight, atomically
 * with that comparison (FLY_IF_READ), before the request:
 *   - an erasure landing before the mark: the mark is refused, and the platform is never asked;
 *   - an erasure landing after it, during the request: the erasure deletes the job but says "not finished"
 *     (UnknownReplyError, the erasure's "incomplete"), and finishes once the try is over.
 * Synthetic only: the in-memory Redis stand-in; the platform's host is "resolved" by a test hook that records the
 * request and refuses it, so nothing leaves the machine.
 */
import { createHash } from "node:crypto";
import { forgetSyncPerson, syncDue, QUEUE_KEY } from "@/lib/email-sync";
import { setPlatformHooksForTests } from "@/lib/email-platforms";
import { seal } from "@/lib/secret-box";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "zz4392stats";
const ID = "esj_" + "d".repeat(24);
const EMAIL = "erased-inflight@example.com";
const logKey = `nl:esync:log:${STATS}`;
const jobKey = `nl:esync:j:${ID}`;
const cfgKey = `nl:esync:cfg:${STATS}`;
const member = `${STATS}|${ID}`;
type Batch = (string | number)[][];

async function seed(now: number): Promise<void> {
  redis.clear();
  const job = { id: ID, statsId: STATS, email: EMAIL, firstName: "Ada", products: [], title: "Paid course", source: "purchase", attempts: 0, state: "queued", next: now - 1000, lastError: "", note: "", lastAt: 0, createdAt: now - 2000 };
  const key = seal("kit-synthetic-api-key-0000", `email-sync|${STATS}|kit`);
  await redis.pipeline([
    ["SET", cfgKey, JSON.stringify({ handle: "zz4392", provider: "kit", key, last4: "0000", target: { id: "t1", name: "Synthetic list" }, free: true, buyers: "all", products: [], tags: {}, since: now - 60_000, connectedAt: now - 60_000 })],
    ["SET", jobKey, JSON.stringify(job)],
    ["RPUSH", logKey, ID],
    ["ZADD", QUEUE_KEY, now - 1000, member],
  ]);
}

/** The queue's lease (LEASE_SCRIPT), which the stand-in does not run, by its three steps. */
function lease(batch: Batch): number[] | null {
  const [command] = batch;
  if (batch.length !== 1 || command?.[0] !== "EVAL" || !String(command[1]).startsWith('local due = redis.call("ZSCORE"')) return null;
  const [, , , key, leased, at, until] = command;
  const due = redis.run(["ZSCORE", String(key), String(leased)]);
  if (due === null || Number(due) > Number(at)) return [0];
  redis.run(["ZADD", String(key), Number(until), String(leased)]);
  return [1];
}

type Erasure = { finished: number | null; refused: boolean };
const erase = async (): Promise<Erasure> => {
  try {
    return { finished: await forgetSyncPerson(STATS, EMAIL), refused: false };
  } catch {
    return { finished: null, refused: true };
  }
};

async function main(): Promise<void> {
  process.env.NIMBUS_DATA_KEY = "synthetic-email-sync-inflight-key-2026";
  globalThis.fetch = (async () => {
    throw new Error("no fetch expected");
  }) as typeof fetch;
  const now = Date.now();
  const original = redis.pipeline.bind(redis);

  part("the erasure lands right after the worker compared the job, before the platform is asked");
  await seed(now);
  let asked = 0;
  let erasure: Erasure | null = null;
  let askedAfterErasure = false;
  setPlatformHooksForTests({
    resolve: async () => {
      asked += 1;
      if (erasure?.finished !== null && erasure) askedAfterErasure = true;
      throw new Error("synthetic: the platform's host is not reached in tests");
    },
  });
  redis.pipeline = (async (batch: Batch) => {
    const leased = lease(batch);
    if (leased) return leased;
    const replies = await original(batch);
    // The comparison read: the settings and the job, in one batch. The erasure completes as soon as it returns.
    if (!erasure && batch.some((c) => c[0] === "GET" && c[1] === cfgKey) && batch.some((c) => c[0] === "GET" && c[1] === jobKey)) {
      redis.pipeline = original;
      erasure = await erase();
      redis.pipeline = wrapped;
    }
    return replies;
  }) as typeof redis.pipeline;
  const wrapped = redis.pipeline;
  try {
    await syncDue(now + 60_000, now);
  } finally {
    redis.pipeline = original;
  }
  const first = erasure as Erasure | null;
  is("(control) the erasure ran in the window", first !== null, true);
  is("an erasure that reported its part finished is never followed by a request to the platform", first?.finished !== null && first !== null ? askedAfterErasure : false, false);
  is("the job record holding the address is gone", redis.run(["GET", jobKey]), null);
  is("the job is not queued again", redis.run(["ZSCORE", QUEUE_KEY, member]), null);

  part("the erasure lands during the platform's request");
  await seed(now);
  asked = 0;
  let during: Erasure | null = null;
  setPlatformHooksForTests({
    resolve: async () => {
      asked += 1;
      during ??= await erase();
      throw new Error("synthetic: the platform's host is not reached in tests");
    },
  });
  redis.pipeline = (async (batch: Batch) => lease(batch) ?? original(batch)) as typeof redis.pipeline;
  try {
    await syncDue(now + 60_000, now);
  } finally {
    redis.pipeline = original;
    setPlatformHooksForTests(undefined);
  }
  const mid = during as Erasure | null;
  is("(control) the platform was asked once", asked, 1);
  is("an erasure while the request is in flight does not report its part finished", mid?.refused, true);
  is("the job record holding the address is gone", redis.run(["GET", jobKey]), null);
  is("the job is not queued again", redis.run(["ZSCORE", QUEUE_KEY, member]), null);
  is("once the try is over, the erasure is pressed again and finishes", await erase(), { finished: 0, refused: false });
  is("nothing of the try is left in flight", redis.run(["EXISTS", `nl:esync:fly:${createHash("sha256").update(`${STATS}|${EMAIL}`).digest("hex").slice(0, 40)}`]), 0);
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
