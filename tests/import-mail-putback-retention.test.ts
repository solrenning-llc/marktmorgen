/**
 * An import's queue of buyers still to email (nl:import:<id>:mail) holds their plain addresses, and the store is told
 * they are kept 14 days after the import began (lib/person-data.ts, lib/imports.ts). The mail step reads a portion
 * and takes exactly those off (SREM); when the portion was the whole queue, Redis deletes the emptied key, expiry and
 * all. Every way the step then puts the same addresses back (a lost SREM reply, an unreadable check of deleted
 * addresses, the company's day full, an unsaved hold, a send to try again) must put the expiry back with them:
 * before, a bare SADD made a new key that never expired, so a stalled or abandoned import kept those addresses for
 * good. Synthetic only: the in-memory Redis double, no provider.
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { IMPORT_KEEP_SECONDS, runImport, type ImportJob } from "@/lib/imports";
import { PERSON_DATA } from "@/lib/person-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const OWNER = "import-putback@example.com";

async function main(): Promise<void> {
  part("The promise and the constant are the same number");
  const promised = PERSON_DATA.find((d) => d.file === "lib/imports.ts" && d.how === "expires");
  is("the store is told 14 days, and the code keeps an import's records 14 days", [promised && "days" in promised ? promised.days * 86_400 : null, IMPORT_KEEP_SECONDS], [14 * 86_400, 14 * 86_400]);

  part("Every put-back of the mail queue sends the expiry with it");
  const source = readFileSync("lib/imports.ts", "utf8");
  // Each pipeline that adds to the mail queue, as written: it must also set the queue's expiry in the same call.
  const adds = [...source.matchAll(/redisPipeline\(\[([^\n]*?\["SADD", mailKey\(job\.id\)[^\n]*)\]\)/g)].map((m) => m[1]);
  is("there are adds to the queue to look at", adds.length > 0, true);
  is("none of them is a bare SADD without the queue's expiry", adds.filter((a) => !a.includes(`["EXPIRE", mailKey(job.id), KEEP_SECONDS]`)), []);

  part("A whole queue taken off and put back keeps its expiry");
  redis.clear();
  await claimHandle(OWNER, "import-putback", "Putback Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ImportPutback1", subscriptionId: "sub_ImportPutback1", active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: false });
  const sid = (await storeForEmail(OWNER))!.sid;
  const id = "7".repeat(24);
  const job: ImportJob = {
    id,
    kind: "purchases",
    sid,
    by: OWNER,
    at: Date.now(),
    state: "mailing",
    file: "buyers.csv",
    expected: 3,
    total: 3,
    done: 3,
    cursor: { batch: 0, row: 0 },
    counts: { added: 3, already: 0, skipped: 0, errors: 0, mailed: 0, unmailed: 0, contacts: 0, stopped: 0 },
    options: { agreed: false, consentColumn: false, tags: [], email: true, dateOrder: "", source: "csv" },
    finishedAt: 0,
  };
  const mail = `nl:import:${id}:mail`;
  await real([
    ["SET", `nl:import:${id}`, JSON.stringify(job), "EX", IMPORT_KEEP_SECONDS],
    ["SADD", "nl:imports:active", id],
    ["SADD", mail, "ann@example.com", "ben@example.com", "cal@example.com"],
    ["EXPIRE", mail, IMPORT_KEEP_SECONDS],
    ["SET", `nl:imports:busy:${sid}`, id, "EX", 3600],
  ]);
  // The SREM runs on the server and empties the queue (Redis deletes the key); only its reply is lost on the way.
  redis.pipeline = (async (commands: Command[]) => {
    const replies = await real(commands);
    if (!(commands.length === 1 && commands[0][0] === "SREM" && commands[0][1] === mail)) return replies;
    // Real Redis deletes a set the moment it is empty, expiry and all; the in-memory double keeps it, so do it here.
    if (Number((await real([["SCARD", mail]]))[0]) === 0) await real([["DEL", mail]]);
    return [{ unexpected: true }];
  }) as typeof redis.pipeline;
  const after = await runImport(id, Date.now() + 30_000);
  redis.pipeline = real;
  is("still mailing, the same three addresses queued again", [after?.state, (await real([["SCARD", mail]]))[0]], ["mailing", 3]);
  const ttl = Number((await real([["TTL", mail]]))[0]);
  is("the queue put back expires, within the 14 days promised", ttl > 0 && ttl <= IMPORT_KEEP_SECONDS, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
