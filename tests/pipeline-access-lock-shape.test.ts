/**
 * The per-teammate lock of lib/pipeline-access.ts read only from Redis's exact reply (CX-123 rule 24; Codex g on
 * #2036, g-20261116-1838-defect-2036.md). SET NX answers exactly ["OK"] when the lock is taken and exactly [null]
 * when someone else holds it. Before this, any list whose first item was "OK" (["OK", "unexpected"]) counted as the
 * lock taken, though the SET was not confirmed: two pages saving at once both wrote, and the first one's choice was
 * lost. Now any other shape refuses before the record is read or written (PipelineAccessWriteUnconfirmed, 503 on the
 * route), and the release deletes the lock only when its GET answers exactly [token], never on an unknown reply.
 * Synthetic only: the in-memory Redis stub and example.com addresses.
 */
import { setPipelineAccess, setPipelineChoices, readPipelineAccess, PipelineAccessBusyError, PipelineAccessWriteUnconfirmed } from "@/lib/pipeline-access";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { putMember } from "@/lib/team";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Shape = "real" | "ok-and-more" | "empty" | "sparse" | "undefined" | "number" | "proxy" | "nonlist";
const realPipeline = redis.pipeline.bind(redis);
let setShape: Shape = "real";
let getShape: "real" | "token-and-more" | "nonlist" = "real";
let sets = 0;
let writes = 0;
let dels = 0;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const [verb, key] = [String(commands[0]?.[0]), String(commands[0]?.[1])];
  const isLock = commands.length === 1 && key.startsWith("nl:crm:pacc:lock:");
  if (!isLock && (verb === "HSET" || verb === "HDEL") && key.startsWith("nl:crm:pacc:")) writes += 1;
  if (isLock && verb === "DEL") dels += 1;
  if (isLock && verb === "SET") {
    sets += 1;
    switch (setShape) {
      case "real": return realPipeline(commands);
      // The lock is NOT created in any of these: only the reply says "OK" in a shape that is not exactly ["OK"].
      case "ok-and-more": return ["OK", "unexpected"];
      case "empty": return [];
      case "sparse": return Array(1);
      case "undefined": return [undefined];
      case "number": return [1];
      case "proxy": return new Proxy(["OK"], {});
      case "nonlist": return { 0: "OK", length: 1 };
    }
  }
  if (isLock && verb === "GET" && getShape !== "real") {
    const real = (await realPipeline(commands)) as unknown[];
    return getShape === "token-and-more" ? [real[0], "unexpected"] : { 0: real[0], length: 1 };
  }
  return realPipeline(commands);
}) as typeof redis.pipeline;

const lockValue = async (key: string) => ((await realPipeline([["GET", key]])) as unknown[])[0];
const lockSet = async (key: string, value: string) => realPipeline([["SET", key, value]]);
const lockDrop = async (key: string) => realPipeline([["DEL", key]]);
const outcome = (run: () => Promise<unknown>) =>
  run().then(
    () => "saved",
    (error: unknown) => (error instanceof PipelineAccessWriteUnconfirmed ? "unconfirmed" : error instanceof PipelineAccessBusyError ? "busy" : `other: ${String(error)}`),
  );

async function main(): Promise<void> {
  redis.clear();
  const owner = "locks@example.com";
  await claimHandle(owner, "lockshop", "Lock Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1TestPaccLock1", true);
  await setSubscription(owner, { customerId: "cus_PaccLock0001", subscriptionId: "sub_PaccLock0001", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const statsId = store.statsId!;
  await putMember(store, "sam@example.com", "support");
  const pipelines = ["sales0", "coach1"];
  const lockOf = (who: string) => `nl:crm:pacc:lock:${statsId}:${who}`;

  part("Controls: the exact replies");
  is("SET NX answering exactly [\"OK\"]: saved", await outcome(() => setPipelineAccess(statsId, "sam@example.com", pipelines, "sales0", "view", store)), "saved");
  is("and the lock is let go", await lockValue(lockOf("sam@example.com")), null);
  await lockSet(lockOf("sam@example.com"), "someone-else");
  is("SET NX answering exactly [null] (held elsewhere): busy", await outcome(() => setPipelineChoices(statsId, "sam@example.com", pipelines, { coach1: "none" }, store)), "busy");
  await lockDrop(lockOf("sam@example.com"));
  is("the record is the first save's", await readPipelineAccess(statsId, "sam@example.com"), { sales0: "view" });

  for (const shape of ["ok-and-more", "empty", "sparse", "undefined", "number", "proxy", "nonlist"] as const) {
    part(`SET NX answered in an unknown shape (${shape})`);
    setShape = shape;
    writes = 0;
    is("one change: refused as unconfirmed, nothing written", [await outcome(() => setPipelineAccess(statsId, "sam@example.com", pipelines, "coach1", "none", store)), writes], ["unconfirmed", 0]);
    is("Save: refused as unconfirmed, nothing written", [await outcome(() => setPipelineChoices(statsId, "sam@example.com", pipelines, { coach1: "none" }, store)), writes], ["unconfirmed", 0]);
    is("the record is unchanged", await readPipelineAccess(statsId, "sam@example.com"), { sales0: "view" });
    setShape = "real";
  }

  part("Two pages saving at once while SET NX answers [\"OK\", \"unexpected\"] (Codex g's scenario)");
  await putMember(store, "kim@example.com", "support");
  setShape = "ok-and-more";
  writes = 0;
  const [a, b] = await Promise.all([
    outcome(() => setPipelineChoices(statsId, "kim@example.com", pipelines, { sales0: "view" }, store, {})),
    outcome(() => setPipelineChoices(statsId, "kim@example.com", pipelines, { coach1: "none" }, store, {})),
  ]);
  setShape = "real";
  is("neither is taken as saved, and nothing is written", [a, b, writes], ["unconfirmed", "unconfirmed", 0]);
  is("Kim's record is still the one both pages read", await readPipelineAccess(statsId, "kim@example.com"), {});

  for (const shape of ["token-and-more", "nonlist"] as const) {
    part(`The release's GET answered in an unknown shape (${shape})`);
    getShape = shape;
    dels = 0;
    sets = 0;
    is("the change itself is saved", await outcome(() => setPipelineAccess(statsId, "kim@example.com", pipelines, "sales0", "view", store)), "saved");
    getShape = "real";
    is("the lock is not deleted on an unknown reply (it runs out by itself)", [sets, dels, typeof (await lockValue(lockOf("kim@example.com")))], [1, 0, "string"]);
    await lockDrop(lockOf("kim@example.com"));
  }
  done();
}
main();
