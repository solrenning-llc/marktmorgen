/**
 * Erasing a person from the email-platform sync finds every job of theirs that still exists, not only the ones in the
 * store's studio log (Claude 2 on #3223). The log keeps the last LOG_SIZE jobs, but a job record lives a week and a
 * retry stays queued for about forty hours: after LOG_SIZE newer sign-ups or purchases (skipped ones count too), a
 * person's job is out of the log while it still holds their address and is still due to be sent.
 *
 *   - The erasure (forgetSyncPerson, lib/person-erasure.ts) deletes it, so syncDue never sends the address after the
 *     erasure; the copy of their data (syncJobsOf, lib/person-copy.ts) lists it.
 *   - A worker that read the job before an erasure and is still waiting on the platform does not write it back
 *     afterwards: no record, no queue member, nothing sent again.
 *   - Every new read is exact (CX-123 rule 24): another shape, or more than can be read whole, throws, so the erasure
 *     is reported incomplete and the copy refuses, with nothing deleted.
 *
 * The platform is never reached: its name lookup (lib/email-platforms.ts setPlatformHooksForTests) is held by the
 * test and then refused, which the code takes as "could not be reached", a retry. Synthetic data only.
 */
import { forgetSyncPerson, queuePerson, syncDue, syncJobsOf, LOG_SIZE, QUEUE_KEY } from "@/lib/email-sync";
import { setPlatformHooksForTests } from "@/lib/email-platforms";
import { UnknownReplyError } from "@/lib/redis-reply";
import { seal } from "@/lib/secret-box";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
type Pipeline = (commands: Command[]) => Promise<unknown[]>;
const original = redis.pipeline.bind(redis) as Pipeline;

const statsId = "e5a11a11e5a11a11e5a11a11e5a11a11";
const store = { statsId, handle: "erase-all" } as unknown as Store;
const theirAddress = "buyer@example.test";
const asked = " Buyer@Example.test ";
const jobKey = (id: string) => `nl:esync:j:${id}`;
const logKey = `nl:esync:log:${statsId}`;
const MINUTE = 60_000;

function seedConfig(): void {
  redis.clear();
  redis.run(["SET", `nl:esync:cfg:${statsId}`, JSON.stringify({
    handle: "erase-all",
    provider: "kit",
    key: seal("kit-synthetic-key-not-real", `email-sync|${statsId}|kit`),
    last4: "real",
    target: { id: "t1", name: "Synthetic list" },
    free: true,
    buyers: "all",
    products: [],
    tags: {},
    since: Date.now() - MINUTE,
    connectedAt: Date.now() - MINUTE,
  })]);
}

/** The platform's name lookups; each is refused at once unless `hold` is set, which decides when. */
let lookups = 0;
let hold: ((refuse: () => void) => void) | null = null;
setPlatformHooksForTests({
  resolve: () => {
    lookups += 1;
    return new Promise((_, reject) => {
      const refuse = () => reject(new Error("synthetic: no network in tests"));
      if (hold) hold(refuse);
      else refuse();
    });
  },
});

let seeds = 0;
const person = (email: string, consent: boolean) => ({
  source: "purchase" as const,
  email,
  name: "Dana Reyes",
  products: [],
  consent,
  seed: `cs_test_eraseall${(seeds += 1)}`,
  at: Date.now(),
});

/** LOG_SIZE + 10 newer people who did not agree: logged, never sent, and enough to push theirs out of the log. */
async function newerSignUps(): Promise<void> {
  for (let i = 0; i < LOG_SIZE + 10; i += 1) await queuePerson(store, person(`other${i}@example.test`, false));
}

/** Their job's id, read from its queue member or record, whatever the log says. */
function theirJobs(): string[] {
  const scan = redis.run(["SCAN", "0", "MATCH", "nl:esync:j:*"]) as [string, string[]];
  return scan[1]
    .filter((key) => {
      const raw = redis.run(["GET", key]);
      return typeof raw === "string" && (JSON.parse(raw) as { email?: string }).email === theirAddress;
    })
    .map((key) => key.slice("nl:esync:j:".length));
}

/** Entries left in any person's job index (an index emptied by the stand-in may linger as a key with none). */
const indexEntries = () =>
  (redis.run(["SCAN", "0", "MATCH", "nl:esync:pj:*"]) as [string, string[]])[1].reduce((sum, key) => sum + Number(redis.run(["ZCARD", key])), 0);
const queued = () => (redis.run(["ZRANGEBYSCORE", QUEUE_KEY, "-inf", "+inf"]) as string[]).filter((m) => m.startsWith(`${statsId}|`));
const logged = () => redis.run(["LRANGE", logKey, 0, -1]) as string[];

const isWrite = (commands: Command[]) => commands.some(([name]) => name === "DEL" || name === "LREM" || name === "ZREM");
type Kind = "index" | "scan" | "write";

/**
 * The pipeline as Upstash runs it, with the queue's lease script (lib/email-sync.ts claim) played here, since the
 * memory stand-in does not run it. With `swap`, the reply to one kind of pipeline is replaced: "index" (the person's
 * job index, read whole), "scan" (each page of the queue, ZSCAN) or "write" (the deletes, which still run).
 */
let swap: { at: Kind; reply: (real: unknown[]) => unknown } | null = null;
let writes = 0;
(redis as unknown as { pipeline: Pipeline }).pipeline = async (commands) => {
  const [first] = commands;
  if (commands.length === 1 && first?.[0] === "EVAL" && String(first[1]).includes('redis.call("ZSCORE"')) {
    const [, , , key, member, now, until] = first;
    const due = redis.run(["ZSCORE", key, member]);
    if (due === null || due === undefined || Number(due) > Number(now)) return [0];
    redis.run(["ZADD", key, until, member]);
    return [1];
  }
  const index = first?.[0] === "ZRANGEBYSCORE" && String(first[1]).startsWith("nl:esync:pj:");
  const kind: Kind | "other" = index ? "index" : first?.[0] === "ZSCAN" ? "scan" : isWrite(commands) ? "write" : "other";
  if (kind === "write") writes += 1;
  const real = await original(commands);
  return (swap && swap.at === kind ? swap.reply(real) : real) as unknown[];
};

async function run<T>(call: () => Promise<T>, with_?: { at: Kind; reply: (real: unknown[]) => unknown }): Promise<{ got: T | "unknown" | "refused"; writes: number }> {
  writes = 0;
  swap = with_ ?? null;
  try {
    return { got: await call(), writes };
  } catch (error) {
    return { got: error instanceof UnknownReplyError ? "unknown" : "refused", writes };
  } finally {
    swap = null;
  }
}

const copyIds = async () => {
  const got = (await run(() => syncJobsOf(statsId, asked))).got;
  return typeof got === "string" ? got : got.map((row) => [row.id, row.email, row.state]);
};

function sparse(length: number, entries: [number, unknown][]): unknown[] {
  const value = new Array<unknown>(length);
  for (const [index, item] of entries) value[index] = item;
  return value;
}

/** Their job, sent once and retrying, then pushed out of the log by newer sign-ups. Returns its id. */
async function retryingOutOfTheLog(): Promise<string> {
  seedConfig();
  is("their sign-up is queued and tried once", await queuePerson(store, person(theirAddress, true)), "queued");
  const [id] = theirJobs();
  await newerSignUps();
  is("their job is out of the studio log, still queued", [logged().includes(id), logged().length, queued()], [false, LOG_SIZE, [`${statsId}|${id}`]]);
  return id;
}

async function main(): Promise<void> {
  part("A queued job out of the log is erased, so it is never sent after the erasure");
  {
    const id = await retryingOutOfTheLog();
    is("the copy of their data lists it", await copyIds(), [[id, theirAddress, "retrying"]]);
    is("the erasure deletes it and counts it", await run(() => forgetSyncPerson(statsId, asked)), { got: 1, writes: 1 });
    is("no record of theirs and nothing of theirs queued", [theirJobs(), queued()], [[], []]);
    is("the copy is then empty", await copyIds(), []);
    const before = lookups;
    await syncDue(Date.now() + 30_000, Date.now() + 24 * 60 * MINUTE);
    is("the next runs of the queue send nothing", lookups - before, 0);
    is("nobody else's job was touched: the log is still the newer sign-ups", logged().length, LOG_SIZE);
  }

  part("A job written before the person's index existed is found on the queue");
  {
    seedConfig();
    const id = "esj_0123456789abcdef01234567";
    redis.run(["SET", jobKey(id), JSON.stringify({ id, statsId, email: theirAddress, firstName: null, products: [], title: "Synthetic product", source: "purchase", attempts: 1, state: "retrying", next: 1, lastError: "", note: "", lastAt: 1, createdAt: 1 }), "EX", 7 * 86400]);
    redis.run(["ZADD", QUEUE_KEY, 1, `${statsId}|${id}`]);
    redis.run(["ZADD", QUEUE_KEY, 1, `ffffffffffffffffffffffffffffffff|${id}`]);
    await newerSignUps();
    is("the copy lists it", await copyIds(), [[id, theirAddress, "retrying"]]);
    is("the erasure deletes it", (await run(() => forgetSyncPerson(statsId, asked))).got, 1);
    is("its record and its queue member are gone, another store's member is left", [redis.run(["GET", jobKey(id)]), queued(), (redis.run(["ZRANGEBYSCORE", QUEUE_KEY, "-inf", "+inf"]) as string[]).length], [null, [], 1]);
  }

  part("A finished job out of the log and off the queue is still found, through the person's index");
  {
    const id = await retryingOutOfTheLog();
    // Its last try failed for good: off the queue, its record (with the address) kept for the week.
    const record = JSON.parse(String(redis.run(["GET", jobKey(id)]))) as Record<string, unknown>;
    redis.run(["SET", jobKey(id), JSON.stringify({ ...record, state: "failed", next: 0 }), "EX", 7 * 86400]);
    redis.run(["ZREM", QUEUE_KEY, `${statsId}|${id}`]);
    is("the copy lists it", await copyIds(), [[id, theirAddress, "failed"]]);
    is("the erasure deletes it", (await run(() => forgetSyncPerson(statsId, asked))).got, 1);
    is("its record is gone", theirJobs(), []);
    is("a second erasure finds nothing left, with nothing written", await run(() => forgetSyncPerson(statsId, asked)), { got: 0, writes: 0 });
  }

  part("Healthy: a retry that is not erased is written back as before");
  {
    seedConfig();
    await queuePerson(store, person(theirAddress, true));
    const [id] = theirJobs();
    const at = Date.now() + 6 * MINUTE;
    await syncDue(Date.now() + 30_000, at);
    const record = JSON.parse(String(redis.run(["GET", jobKey(id)]))) as { attempts: number; state: string; next: number };
    const score = Number(redis.run(["ZSCORE", QUEUE_KEY, `${statsId}|${id}`]));
    is("tried a second time, still retrying, queued for its next try", [record.attempts, record.state, score === record.next && record.next > Date.now()], [2, "retrying", true]);
    is("the copy lists it", await copyIds(), [[id, theirAddress, "retrying"]]);
  }

  part("An erasure while the platform is being asked is not undone by the worker");
  {
    seedConfig();
    await queuePerson(store, person(theirAddress, true));
    const [id] = theirJobs();
    let erased: unknown = "not run";
    hold = (refuse) => {
      void run(() => forgetSyncPerson(statsId, asked)).then((result) => {
        erased = result.got;
        refuse();
      });
    };
    const before = lookups;
    await syncDue(Date.now() + 30_000, Date.now() + 6 * MINUTE);
    hold = null;
    is("the platform was being asked when the erasure ran, and it erased their job", [lookups - before, erased], [1, 1]);
    is("after the try, no record of theirs, nothing queued and nothing left in their index", [redis.run(["GET", jobKey(id)]), queued(), indexEntries()], [null, [], 0]);
    is("the copy is empty", await copyIds(), []);
    const again = lookups;
    await syncDue(Date.now() + 30_000, Date.now() + 2 * 24 * 60 * MINUTE);
    is("nothing is sent again", lookups - again, 0);
  }

  part("The person's index read in another shape is unknown, never no jobs");
  const indexes: [string, (real: unknown[]) => unknown][] = [
    ["a missing reply", () => [null]],
    ["a text reply", () => ["esj_0123456789abcdef01234567"]],
    ["a number reply", () => [1]],
    ["a member that is not text", () => [["esj_0123456789abcdef01234567", 7]]],
    ["a sparse list", () => [sparse(2, [[1, "esj_0123456789abcdef01234567"]])]],
    ["an empty envelope", () => []],
    ["an envelope that is not a list", () => "OK"],
  ];
  for (const [what, reply] of indexes) {
    const id = await retryingOutOfTheLog();
    is(`erase: ${what} throws UnknownReplyError, with nothing written`, await run(() => forgetSyncPerson(statsId, asked), { at: "index", reply }), { got: "unknown", writes: 0 });
    is(`erase: ${what} leaves their job for a retry`, [theirJobs(), queued()], [[id], [`${statsId}|${id}`]]);
    is(`copy: ${what} throws UnknownReplyError, never a part missing`, (await run(() => syncJobsOf(statsId, asked), { at: "index", reply })).got, "unknown");
  }
  {
    const id = await retryingOutOfTheLog();
    const many = Array.from({ length: 1001 }, (_, i) => `esj_${i.toString(16).padStart(24, "0")}`);
    is("erase: an index longer than can be read whole is refused, with nothing written", await run(() => forgetSyncPerson(statsId, asked), { at: "index", reply: () => [many] }), { got: "refused", writes: 0 });
    is("copy: the same is refused", (await run(() => syncJobsOf(statsId, asked), { at: "index", reply: () => [many] })).got, "refused");
    is("their job is left for a retry", theirJobs(), [id]);
  }

  part("A page of the queue in another shape is unknown, never not queued");
  const pages: [string, (real: unknown[]) => unknown][] = [
    ["a missing reply", () => [null]],
    ["a reply that is not a cursor and a page", () => [["0"]]],
    ["a cursor that is a number", () => [[0, []]]],
    ["a cursor that is not a number", () => [["next", []]]],
    ["a page that is not a list", () => [["0", "member"]]],
    ["a page with a member and no score", (real) => [["0", [...((real[0] as unknown[])[1] as string[]), "lonely"]]]],
    ["a score that is not text", () => [["0", [`${statsId}|esj_0123456789abcdef01234567`, 1]]]],
    ["a sparse page", () => [["0", sparse(2, [[1, "1"]])]]],
    ["an envelope that is not a list", () => "OK"],
  ];
  for (const [what, reply] of pages) {
    const id = await retryingOutOfTheLog();
    is(`erase: ${what} throws UnknownReplyError, with nothing written`, await run(() => forgetSyncPerson(statsId, asked), { at: "scan", reply }), { got: "unknown", writes: 0 });
    is(`erase: ${what} leaves their job for a retry`, [theirJobs(), queued()], [[id], [`${statsId}|${id}`]]);
    is(`copy: ${what} throws UnknownReplyError`, (await run(() => syncJobsOf(statsId, asked), { at: "scan", reply })).got, "unknown");
  }
  {
    const id = await retryingOutOfTheLog();
    const endless = () => [["7", []]];
    is("erase: a queue that never ends within the bound is refused, with nothing written", await run(() => forgetSyncPerson(statsId, asked), { at: "scan", reply: endless }), { got: "refused", writes: 0 });
    is("copy: the same is refused", (await run(() => syncJobsOf(statsId, asked), { at: "scan", reply: endless })).got, "refused");
    is("their job is left for a retry", theirJobs(), [id]);
  }

  part("Every delete reply is checked, the index's too");
  for (const [what, reply] of [
    ["the index DEL above one", (real: unknown[]) => [...real.slice(0, -1), 2]],
    ["the index DEL missing", (real: unknown[]) => [...real.slice(0, -1), null]],
    ["a reply short by the index DEL", (real: unknown[]) => real.slice(0, -1)],
  ] as const) {
    await retryingOutOfTheLog();
    is(`erase: ${what} throws UnknownReplyError, never reported done`, (await run(() => forgetSyncPerson(statsId, asked), { at: "write", reply })).got, "unknown");
  }

  part("Confirmed empty is still nothing");
  redis.clear();
  is("no log, no index, an empty queue: nothing to erase, nothing written", await run(() => forgetSyncPerson(statsId, asked)), { got: 0, writes: 0 });
  is("and an empty copy", await copyIds(), []);

  done();
}

void main();
