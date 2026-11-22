/**
 * A file of contacts whose atomic write lands but whose answer, and the read-only recovery after it, are lost
 * (Claude 1's review 6800603295 on #2438, MEDIUM; Claude 5's probe: threw, landed 150, added 0, outcomes "already").
 * The step is retried from the same rows; those rows now read as already on the list, so job.counts.added never
 * counts them. Addresses brought in from elsewhere are of unknown age, so their next emails must still go out in
 * portions that double (lib/mail-health.ts startRamp): the ramp has to count the rows that may have been written,
 * without claiming they were. Synthetic data only; no request leaves the test.
 */
import { leadsKey } from "@/lib/contacts";
import { addRows, finishUpload, runImport, startImport } from "@/lib/imports";
import { healthId } from "@/lib/mail-health";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Command = (string | number)[];

async function main(): Promise<void> {
  globalThis.fetch = (async () => {
    throw new Error("No external requests in the contact file test");
  }) as typeof fetch;
  part("A file whose write landed while its answer was lost still gets its portions");
  redis.clear();
  const owner = "contacts-file-ramp@example.com";
  await claimHandle(owner, "contactsfileramp", "Contacts File Ramp", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_file_ramp", subscriptionId: "sub_file_ramp", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const list = store.listId!;
  const rows = Array.from({ length: 150 }, (_, i) => [String(i + 2), `file${i}@example.com`, `Person ${i}`, ""]);
  const start = await startImport(store, owner, "contacts", { expected: rows.length, file: "contacts.csv", agreed: true });
  if (!start.ok) throw new Error(`import did not start: ${start.reason}`);
  await addRows(store, start.job.id, rows);
  await finishUpload(store, start.job.id);

  const original = redis.pipeline.bind(redis);
  const log = console.error;
  let landed = false;
  console.error = () => {};
  redis.pipeline = async (commands: Command[]) => {
    if (!landed && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:contact-import:"))) {
      landed = true;
      await original(commands);
      return [];
    }
    // The read-only recovery right after it is lost too.
    if (landed && commands.some((c) => c[0] === "HMGET" && c[1] === leadsKey(list)) && commands.length === 2) return [];
    return original(commands);
  };
  try {
    await runImport(start.job.id, Date.now() + 10_000);
  } finally {
    redis.pipeline = original;
    console.error = log;
  }
  is("the write landed: all 150 are on the list", Number(redis.run(["HLEN", leadsKey(list)])), 150);
  const finished = await runImport(start.job.id, Date.now() + 10_000);
  is("the retried step finds them already there and the import ends", finished?.state, "done");
  is("and never claims it added them", finished?.counts.added, 0);
  const ramp = redis.run(["GET", `nl:mail:ramp:${healthId((await storeForEmail(owner))!)}`]);
  is("their next emails still go out in portions that double", typeof ramp, "string");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
