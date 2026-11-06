/**
 * Sweep A3 proof (CX-123 rule 24), synthetic only: the in-memory Redis double. lib/imports.ts advanceImports, lines
 * 1382-1387 (the cron that runs every queued import): each job is read with readJob (lines 303-307, `parseJob(raw)`,
 * null for anything but a string), and a job that read as null is SREMoved from nl:imports:active. A GET answering
 * in an unknown shape is therefore "this import is gone": the import is taken off the list of running imports for
 * good. It is never advanced again (its buyers never brought over or emailed) while it still exists, still holds
 * the store's single import slot (nl:imports:busy) and still reads "queued" in the studio. (The proof's job is in
 * a finished state only so that the healthy run, which reads it and leaves it, touches nothing else.)
 */
import { advanceImports, readJob } from "@/lib/imports";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const ACTIVE = "nl:imports:active";

async function main(): Promise<void> {
  redis.clear();
  const id = "c".repeat(24);
  // A job in a finished state: the healthy run reads it and leaves it alone (runImport returns it as it is).
  const job = { id, sid: "s".repeat(16), kind: "contacts", state: "done", at: Date.now(), counts: {}, options: {}, cursor: { batch: 0 }, finishedAt: 0 };
  await real([["SET", `nl:import:${id}`, JSON.stringify(job), "EX", 3600], ["SADD", ACTIVE, id]]);

  part("Healthy control: the job reads, and stays on the active list");
  await advanceImports(Date.now() + 10_000);
  is("still active, still readable", [(await real([["SISMEMBER", ACTIVE, id]]))[0], (await readJob(id))?.id], [1, id]);

  part("DEFECT: the GET of the job answers in an unknown shape");
  redis.pipeline = (async (commands: Command[]) => (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:import:${id}` ? [{ unexpected: true }] : real(commands))) as typeof redis.pipeline;
  await advanceImports(Date.now() + 10_000);
  redis.pipeline = real;
  is("DEFECT: taken off the active list for good, though the job still exists", [(await real([["SISMEMBER", ACTIVE, id]]))[0], (await readJob(id))?.id], [0, id]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
