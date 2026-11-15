/**
 * Rule 24 (CX-123), erasure: a person's affiliate bond (lib/affiliate-bond.ts,
 * forgetBondPerson) and their imported purchases (lib/imported-purchases.ts,
 * forgetImportedPerson) are reported deleted only on an exact reply. Before,
 * each summed `Number(reply) || 0`, so a pipeline reply cut short or in
 * another shape counted as "0 deleted" and returned: erasePerson then took the
 * part as finished and could answer that everything about the person was
 * deleted while the key was still there. Now such a reply throws
 * UnknownReplyError, which erasePerson records as a part that could not finish
 * ("incomplete"), so the person or the team deletes again.
 *
 * Synthetic data only, on the in-memory Redis.
 */
import { forgetBondPerson } from "@/lib/affiliate-bond";
import { forgetImportedPerson, importedKey, importedWhoKey } from "@/lib/imported-purchases";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const STATS = "st_erasure_exact";
const EMAIL = "buyer@example.com";

async function outcome(run: () => Promise<number>): Promise<string> {
  try {
    return `counted ${await run()}`;
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`;
  }
}

/** Runs `run` with every pipeline that holds a command matching `hit` answered by `reply` (the commands still run). */
async function withReply(hit: (command: Command) => boolean, reply: (real: unknown[]) => unknown[], run: () => Promise<number>): Promise<string> {
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: Command[]) => {
    const answers = await real(batch);
    return batch.some(hit) ? reply(answers) : answers;
  }) as typeof redis.pipeline;
  try {
    return await outcome(run);
  } finally {
    redis.pipeline = real;
  }
}

const bond = (c: Command) => c[0] === "HDEL" && String(c[1]).endsWith(":bond");
const imported = (c: Command) => c[0] === "DEL" && String(c[1]) === importedKey(STATS, EMAIL);

async function main(): Promise<void> {
  part("A person's affiliate bond: deleted only on an exact reply");
  redis.clear();
  is("a reply cut short is unknown, never 0 deleted", await withReply(bond, () => [], () => forgetBondPerson(STATS, EMAIL)), "unknown");
  is("a reply in another shape is unknown", await withReply(bond, () => ["OK"], () => forgetBondPerson(STATS, EMAIL)), "unknown");
  is("an exact reply counts what went (none here)", await outcome(() => forgetBondPerson(STATS, EMAIL)), "counted 0");

  part("A person's imported purchases: deleted only on an exact reply");
  redis.clear();
  redis.run(["SET", importedKey(STATS, EMAIL), "[]"]);
  redis.run(["HSET", importedWhoKey(STATS), EMAIL, "1"]);
  is("a reply cut short is unknown, never 0 deleted", await withReply(imported, (real) => real.slice(0, 1), () => forgetImportedPerson(STATS, EMAIL)), "unknown");
  redis.run(["SET", importedKey(STATS, EMAIL), "[]"]);
  redis.run(["HSET", importedWhoKey(STATS), EMAIL, "1"]);
  is("a reply in another shape is unknown", await withReply(imported, () => [null, "x"], () => forgetImportedPerson(STATS, EMAIL)), "unknown");
  redis.run(["SET", importedKey(STATS, EMAIL), "[]"]);
  redis.run(["HSET", importedWhoKey(STATS), EMAIL, "1"]);
  is("an exact reply counts both deletions", await outcome(() => forgetImportedPerson(STATS, EMAIL)), "counted 2");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
