/**
 * The store's Path read in an unknown shape (rule 24): never read as "not
 * started". Read as none, the owner's Path data file was answered as
 * {path: null} (no data), the reminder said "not-started" and joining the
 * board "not_started". Unknown now throws; every caller already answers a
 * throw honestly (the data file and board routes 503, the studio pages'
 * "could not be read" state, the reminder "unavailable").
 * Text that is kept but is not a record (broken JSON, an unknown version,
 * the text "null", empty text) is also unknown: only Path writes this key,
 * always with pathJson, so it is never "not started" either.
 * Synthetic only: the Redis stub.
 */
import { pathJson, readPath, type PathRecord } from "@/lib/path";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const store = { sid: "0123456789abcdef0123456789abcdef" };
const real = redis.pipeline.bind(redis);
const record: PathRecord = { answers: { goalCents: 0, goalCurrency: "usd", skills: "Teaching", subject: "Guides", minutes: 15, audience: "none", timeZone: "America/New_York" }, startedAt: 1790000000000, checkins: ["2026-10-19"], best: 0, bestAt: 1790000000000, money: null, counts: null };

async function outcome(reply: unknown[]): Promise<unknown> {
  redis.pipeline = (async () => [...reply]) as typeof redis.pipeline;
  try {
    return await readPath(store);
  } catch {
    return "rejected";
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  redis.clear();
  part("Unknown answers are never 'not started'");
  for (const [label, reply] of [["no reply", []], ["undefined", [undefined]], ["a number", [4]], ["an object", [{}]], ["two replies", [null, null]]] as const) {
    is(label, await outcome([...reply]), "rejected");
  }
  part("Kept text that is not a record is never 'not started'");
  const unknownVersion = JSON.stringify({ ...JSON.parse(pathJson(record)), v: 2 });
  for (const [label, text] of [["broken JSON", "{\"v\":1,"], ["an unknown version", unknownVersion], ["the text null", "null"], ["empty text", ""]] as const) {
    is(label, await outcome([text]), "rejected");
  }
  part("Control: no record at all is 'not started'");
  is("null", await readPath(store), null);
  part("Control: a kept record is read");
  const kept = (await outcome([pathJson(record)])) as PathRecord | string | null;
  is("a record", typeof kept === "object" && kept !== null ? kept.startedAt : kept, record.startedAt);
  done();
}

void main();
