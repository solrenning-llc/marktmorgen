/**
 * Erasing a person from the email-platform sync reads Redis in its exact shape
 * (CX-123 rule 24; Claude 6 audit round 2). forgetSyncPerson is one of the
 * person erasers (lib/person-erasure.ts, ERASERS): a log, a job record or a
 * delete reply in another shape must throw UnknownReplyError, so the erasure is
 * reported incomplete and can be pressed again, never "no jobs", "not theirs"
 * or done. syncJobsOf, the same jobs for the person's copy (lib/person-copy.ts),
 * reads them the same way (rule 30): a copy is never handed over with a part
 * silently missing. Synthetic data only.
 */
import { forgetSyncPerson, syncJobsOf, QUEUE_KEY } from "@/lib/email-sync";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = (commands: (string | number)[][]) => Promise<unknown[]>;
const original = redis.pipeline.bind(redis) as Pipeline;

const statsId = "erasesyncexact0000000000000001";
const logKey = `nl:esync:log:${statsId}`;
const jobKey = (id: string) => `nl:esync:j:${id}`;
const theirs = "esj_aaaaaaaaaaaaaaaaaaaaaaaa";
const other = "esj_bbbbbbbbbbbbbbbbbbbbbbbb";
const expired = "esj_cccccccccccccccccccccccc";
const person = "Buyer@Example.test";
const job = (id: string, email: string) => JSON.stringify({
  id,
  statsId,
  email,
  firstName: null,
  products: [],
  title: "Synthetic product",
  source: "purchase",
  attempts: 1,
  state: "retrying",
  next: 1,
  lastError: "",
  note: "",
  lastAt: 1,
  createdAt: 1,
});

/** The log newest first: their job, another person's, and one whose record has expired; two still queued. */
function seed(): void {
  redis.clear();
  redis.run(["RPUSH", logKey, theirs, other, expired]);
  redis.run(["SET", jobKey(theirs), job(theirs, "buyer@example.test")]);
  redis.run(["SET", jobKey(other), job(other, "someone@example.test")]);
  redis.run(["ZADD", QUEUE_KEY, 1, `${statsId}|${theirs}`, 2, `${statsId}|${other}`]);
}

function state(): unknown {
  return {
    theirs: redis.run(["GET", jobKey(theirs)]) !== null,
    other: redis.run(["GET", jobKey(other)]) !== null,
    log: redis.run(["LRANGE", logKey, 0, -1]),
    queue: redis.run(["ZRANGEBYSCORE", QUEUE_KEY, "-inf", "+inf"]),
  };
}

const untouched = {
  theirs: true,
  other: true,
  log: [theirs, other, expired],
  queue: [`${statsId}|${theirs}`, `${statsId}|${other}`],
};

const isWrite = (commands: (string | number)[][]) => commands.some(([name]) => name === "DEL" || name === "LREM" || name === "ZREM");

/**
 * Runs one call with the reply to one kind of pipeline replaced: "list" (the LRANGE), "jobs" (the GET batch) or
 * "write" (the deletes, which still run). Says what it answered, or "unknown" for UnknownReplyError, and which writes
 * were sent.
 */
async function run<T>(call: () => Promise<T>, swap?: { at: "list" | "jobs" | "write"; reply: (real: unknown[]) => unknown }): Promise<{ got: T | "unknown" | string; writes: number }> {
  let writes = 0;
  (redis as unknown as { pipeline: Pipeline }).pipeline = async (commands) => {
    const kind = commands[0]?.[0] === "LRANGE" ? "list" : commands[0]?.[0] === "GET" ? "jobs" : isWrite(commands) ? "write" : "other";
    if (kind === "write") writes += 1;
    const real = await original(commands);
    return (swap && swap.at === kind ? swap.reply(real) : real) as unknown[];
  };
  try {
    return { got: await call(), writes };
  } catch (error) {
    return { got: error instanceof UnknownReplyError ? "unknown" : `other error: ${String(error)}`, writes };
  } finally {
    (redis as unknown as { pipeline: Pipeline }).pipeline = original;
  }
}

function sparse(length: number, entries: [number, unknown][]): unknown[] {
  const value = new Array<unknown>(length);
  for (const [index, item] of entries) value[index] = item;
  return value;
}

async function main(): Promise<void> {
  part("Healthy erasure is unchanged");
  seed();
  is("their job is erased and counted once", await run(() => forgetSyncPerson(statsId, person)), { got: 1, writes: 1 });
  is("only their job leaves the record, the log and the queue", state(), {
    theirs: false,
    other: true,
    log: [other, expired],
    queue: [`${statsId}|${other}`],
  });
  redis.clear();
  is("an exact empty log is nothing to erase, with nothing written", await run(() => forgetSyncPerson(statsId, person)), { got: 0, writes: 0 });
  seed();
  is("a log with nobody of theirs erases nothing", await run(() => forgetSyncPerson(statsId, "nobody@example.test")), { got: 0, writes: 0 });
  is("nobody else's job is touched", state(), untouched);
  redis.clear();
  redis.run(["RPUSH", logKey, expired]);
  is("a log of expired records only erases nothing", await run(() => forgetSyncPerson(statsId, person)), { got: 0, writes: 0 });

  part("A log in another shape is unknown, never no jobs");
  const lists: [string, (real: unknown[]) => unknown][] = [
    ["a missing reply", () => [null]],
    ["a text reply", () => ["esj_aaaaaaaaaaaaaaaaaaaaaaaa"]],
    ["a number reply", () => [3]],
    ["an object reply", () => [{ 0: theirs, length: 1 }]],
    ["a member that is not text", () => [[theirs, 7]]],
    ["a sparse list", () => [sparse(2, [[1, theirs]])]],
    ["an empty envelope", () => []],
    ["an envelope that is not a list", () => "OK"],
  ];
  for (const [what, reply] of lists) {
    seed();
    is(`erase: ${what} throws UnknownReplyError, with nothing written`, await run(() => forgetSyncPerson(statsId, person), { at: "list", reply }), { got: "unknown", writes: 0 });
    is(`erase: ${what} leaves their job in place for a retry`, state(), untouched);
    seed();
    is(`copy: ${what} throws UnknownReplyError, never an empty copy`, (await run(() => syncJobsOf(statsId, person), { at: "list", reply })).got, "unknown");
  }

  part("A job record in another shape is unknown, never not theirs");
  const records: [string, (real: unknown[]) => unknown][] = [
    ["a short batch", (real) => real.slice(0, 1)],
    ["a long batch", (real) => [...real, null]],
    ["a sparse batch", (real) => sparse(real.length, [[1, real[1]]])],
    ["a record that is a number", (real) => [42, ...real.slice(1)]],
    ["a record that is not JSON", (real) => ["{not json", ...real.slice(1)]],
    ["a record that is JSON but not a job", (real) => ["5", ...real.slice(1)]],
    ["a record without its address", (real) => [JSON.stringify({ id: theirs, state: "queued" }), ...real.slice(1)]],
    ["another person's record without its address", (real) => [real[0], JSON.stringify({ id: other, state: "queued" }), ...real.slice(2)]],
    ["a batch that is not a list", () => "OK"],
  ];
  for (const [what, reply] of records) {
    seed();
    is(`erase: ${what} throws UnknownReplyError, with nothing written`, await run(() => forgetSyncPerson(statsId, person), { at: "jobs", reply }), { got: "unknown", writes: 0 });
    is(`erase: ${what} leaves every job in place`, state(), untouched);
    seed();
    is(`copy: ${what} throws UnknownReplyError, never a part missing`, (await run(() => syncJobsOf(statsId, person), { at: "jobs", reply })).got, "unknown");
  }

  part("Every delete reply is checked before the erasure counts");
  const writes: [string, (real: unknown[]) => unknown][] = [
    ["a short reply", (real) => real.slice(0, 2)],
    ["a long reply", (real) => [...real, 1]],
    ["a sparse reply", (real) => sparse(real.length, [[0, real[0]], [2, real[2]]])],
    ["a DEL that is not a count", (real) => ["OK", ...real.slice(1)]],
    ["a DEL above the jobs named", (real) => [2, ...real.slice(1)]],
    ["an LREM that is negative", (real) => [real[0], -1, real[2]]],
    ["an LREM that is not a whole number", (real) => [real[0], 0.5, real[2]]],
    ["a ZREM that is missing", (real) => [real[0], real[1], null]],
    ["a ZREM above the jobs named", (real) => [real[0], real[1], 2]],
    ["a reply that is not a list", () => "OK"],
  ];
  for (const [what, reply] of writes) {
    seed();
    is(`erase: ${what} throws UnknownReplyError, never reported done`, (await run(() => forgetSyncPerson(statsId, person), { at: "write", reply })).got, "unknown");
  }

  part("The copy of a person's jobs is unchanged when healthy");
  seed();
  const copied = await run(() => syncJobsOf(statsId, person));
  is("their job is in the copy, alone", copied.got === "unknown" || typeof copied.got === "string" ? copied.got : copied.got.map((row) => [row.id, row.email]), [[theirs, "buyer@example.test"]]);
  redis.clear();
  is("an exact empty log is an empty copy", (await run(() => syncJobsOf(statsId, person))).got, []);

  done();
}

void main();
