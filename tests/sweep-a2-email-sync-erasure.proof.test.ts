/**
 * Sweep A2 proof (CX-123 rules 24/30), synthetic only. lib/email-sync.ts:
 *   forgetSyncPerson (lines 731-748, the person-erasure step) reads the store's job log with
 *     `(Array.isArray(logged) ? logged : [])` and each job with `JSON.parse(String(raws[i]))` in a try/catch;
 *   syncJobsOf (lines 755-773, the person's copy of their data) reads both the same way.
 * An unknown reply is "no job of theirs": the erasure step returns 0 (done, nothing held) and the job record that
 * holds the address stays; the copy says there is nothing. Same defect lib/erasure-index.ts forgetNoted fixed with
 * repliesFor/stringList + UnknownReplyError (audit SG2, finding 4): rule 30 sibling.
 */
import { forgetSyncPerson, syncJobsOf, QUEUE_KEY } from "@/lib/email-sync";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "sweepa2sync";
const ID = "esj_" + "a".repeat(24);
const EMAIL = "buyer@example.com";
const job = { id: ID, statsId: STATS, email: EMAIL, title: "Free guide", source: "free", state: "added", attempts: 1, next: 0, lastError: "", note: "", lastAt: 1, createdAt: 1 };
async function seed() {
  redis.clear();
  await redis.pipeline([["RPUSH", `nl:esync:log:${STATS}`, ID], ["SET", `nl:esync:j:${ID}`, JSON.stringify(job)], ["ZADD", QUEUE_KEY, 1, `${STATS}|${ID}`]]);
}
const jobKept = async () => (await redis.pipeline([["GET", `nl:esync:j:${ID}`]]))[0] !== null;
const original = redis.pipeline.bind(redis);
const lose = (match: (c: (string | number)[]) => boolean) => {
  redis.pipeline = (async (commands: (string | number)[][]) => (commands.length >= 1 && match(commands[0]) ? (commands.length === 1 ? [] : commands.map(() => 7)) : original(commands))) as typeof redis.pipeline;
};

async function main() {
  part("Healthy control");
  await seed();
  is("the copy lists the job", (await syncJobsOf(STATS, EMAIL)).map((j) => j.id), [ID]);
  is("the erasure deletes it and counts it", [await forgetSyncPerson(STATS, EMAIL), await jobKept()], [1, false]);

  part("DEFECT: the job log (LRANGE) answers in an unknown shape");
  await seed();
  lose((c) => c[0] === "LRANGE");
  const copy = await syncJobsOf(STATS, EMAIL);
  const erased = await forgetSyncPerson(STATS, EMAIL);
  redis.pipeline = original;
  is("DEFECT: the person's copy says there is no job", copy, []);
  is("DEFECT: the erasure step answers 0 (finished, nothing held) and the job with the address is kept", [erased, await jobKept()], [0, true]);

  part("DEFECT: the job reads (GET) answer in an unknown shape");
  await seed();
  lose((c) => c[0] === "GET" && String(c[1]).startsWith("nl:esync:j:"));
  const erased2 = await forgetSyncPerson(STATS, EMAIL);
  redis.pipeline = original;
  is("DEFECT: 0, job kept", [erased2, await jobKept()], [0, true]);
  done();
}
main();
