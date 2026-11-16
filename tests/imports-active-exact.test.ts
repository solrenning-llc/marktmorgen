/**
 * Imports read Redis only in its exact shape (sweep A3 on lib/imports.ts, CX-123 rules 24 and 30), synthetic only:
 * the in-memory Redis double, with one command at a time answering in a shape Redis never gives.
 *
 *   - advanceImports (the five-minute job): a job whose GET answers in an unknown shape stays on the list of running
 *     imports and the pass throws UnknownReplyError; read again later, it advances and finishes. Only a job that
 *     is truly gone (GET answers nothing) leaves the list. Before, an unknown GET took it off the list for good while
 *     it kept the store's one-import slot for up to 14 days (tests/sweep-a3-import-active.proof.test.ts).
 *   - mailStep: an answer of unknown shape to the read of the queue (SRANDMEMBER) is not "nobody left to email",
 *     and one to the SREM that takes those addresses off puts them back; the import stays "mailing" with its
 *     addresses queued, and is marked done only once the queue is empty.
 *   - startImport: an unknown answer to the slot's SET NX is not "claimed"; nothing starts, so one store never runs
 *     two imports at once.
 *   - storeImports (the studio's list, rule 30): an unknown list, or an import on it answering in an unknown shape,
 *     throws rather than tell the creator no import is running and "None yet".
 */
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { addRows, advanceImports, finishUpload, jobOf, readJob, runImport, startImport, storeImports, type ImportJob } from "@/lib/imports";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const ACTIVE = "nl:imports:active";
const OWNER = "imports-exact@example.com";

const ROWS = [
  ["2", "ada@example.com", "Ada", "", "Subscribed"],
  ["3", "bea@example.com", "Bea", "", "Subscribed"],
  ["4", "cy@example.com", "Cy", "", "Subscribed"],
];
const INPUT = { expected: ROWS.length, file: "contacts.csv", agreed: true, consentColumn: true, tags: [], source: "clickfunnels" as const };

/** One command answers in a shape Redis never gives, and is not run; every other command runs as it is. */
function oddly(match: (command: Command) => boolean): void {
  redis.pipeline = (async (commands: Command[]) => (commands.length === 1 && match(commands[0]) ? [{ unexpected: true }] : real(commands))) as typeof redis.pipeline;
}

/** What a promise came to: its value, or the name of what it threw. */
async function outcome<T>(promise: Promise<T>): Promise<{ threw: string } | { value: T }> {
  try {
    return { value: await promise };
  } catch (error) {
    return { threw: error instanceof Error ? error.name : String(error) };
  }
}

const active = async (id: string) => (await real([["SISMEMBER", ACTIVE, id]]))[0];

async function queuedImport(): Promise<string> {
  const store = (await storeForEmail(OWNER))!;
  const started = await startImport(store, OWNER, "contacts", INPUT);
  if (!started.ok) throw new Error(`not started: ${started.reason}`);
  await addRows(store, started.job.id, ROWS);
  const finished = await finishUpload(store, started.job.id);
  if (!finished.ok || finished.job.state !== "queued") throw new Error("not queued");
  return started.job.id;
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "imports-exact", "Imports Exact Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ImportsExact01", subscriptionId: "sub_ImportsExact01", active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: false });
  const store = (await storeForEmail(OWNER))!;
  const sid = store.sid;

  part("Healthy control: the five-minute job advances an import and finishes it");
  const first = await queuedImport();
  is("queued and on the active list", [(await readJob(first))?.state, await active(first)], ["queued", 1]);
  const pass = await advanceImports(Date.now() + 30_000);
  is("worked and finished", [pass.worked, pass.finished], [1, 1]);
  is("done, every row brought in, off the list, the store's slot free", [(await readJob(first))?.state, (await readJob(first))?.counts.added, await active(first), (await real([["GET", `nl:imports:busy:${sid}`]]))[0]], ["done", 3, 0, null]);

  part("Healthy control: an import that is truly gone leaves the list");
  const gone = "d".repeat(24);
  await real([["SADD", ACTIVE, gone]]);
  await advanceImports(Date.now() + 30_000);
  is("a GET that answers nothing takes it off", await active(gone), 0);

  part("An unknown GET of a job keeps it on the active list, and the pass says it could not read");
  const second = await queuedImport();
  oddly((command) => command[0] === "GET" && command[1] === `nl:import:${second}`);
  const unread = await outcome(advanceImports(Date.now() + 30_000));
  redis.pipeline = real;
  is("the pass throws UnknownReplyError", unread, { threw: "UnknownReplyError" });
  is("still on the active list, still queued, nothing done", [await active(second), (await readJob(second))?.state, (await readJob(second))?.done], [1, "queued", 0]);
  const later = await advanceImports(Date.now() + 30_000);
  // The same three people as the first import: each is looked at and found already on the list.
  is("read again later, it advances and finishes", [later.finished, (await readJob(second))?.state, (await readJob(second))?.done, (await readJob(second))?.counts.already, await active(second)], [1, "done", 3, 3, 0]);

  part("An unknown list of running imports takes nothing off it");
  // Each part from here starts with the store's slot free, so a part that failed does not hold the next one.
  await real([["DEL", `nl:imports:busy:${sid}`]]);
  const third = await queuedImport();
  oddly((command) => command[0] === "SMEMBERS" && command[1] === ACTIVE);
  const unlisted = await outcome(advanceImports(Date.now() + 30_000));
  redis.pipeline = real;
  is("the pass throws UnknownReplyError", unlisted, { threw: "UnknownReplyError" });
  is("the import is still active and queued", [await active(third), (await readJob(third))?.state], [1, "queued"]);
  await advanceImports(Date.now() + 30_000);
  is("and the next pass finishes it", (await readJob(third))?.state, "done");

  part("Healthy control: one import at a time per store");
  await real([["DEL", `nl:imports:busy:${sid}`]]);
  const running = await queuedImport();
  const busy = await startImport(store, OWNER, "contacts", INPUT);
  is("a second start while one runs is busy", busy.ok ? "started" : busy.reason, "busy");

  part("An unknown answer to the store's import slot starts nothing");
  const before = (await real([["LLEN", `nl:imports:list:${sid}`]]))[0];
  await real([["DEL", `nl:imports:busy:${sid}`]]);
  oddly((command) => command[0] === "SET" && String(command[1]).startsWith("nl:imports:busy:") && command.includes("NX"));
  const unclaimed = await outcome(startImport(store, OWNER, "contacts", INPUT));
  redis.pipeline = real;
  is("startImport throws UnknownReplyError", unclaimed, { threw: "UnknownReplyError" });
  is("no second import was made", (await real([["LLEN", `nl:imports:list:${sid}`]]))[0], before);
  await runImport(running, Date.now() + 30_000);
  is("the running one is not disturbed", (await readJob(running))?.state, "done");

  part("Healthy control: the studio lists the store's imports");
  const listed = await storeImports(store);
  is("every import made here, newest first", [listed.length, listed[0]?.id], [4, running]);

  part("An unknown list of the store's imports is not \"None yet\"");
  oddly((command) => command[0] === "LRANGE" && command[1] === `nl:imports:list:${sid}`);
  const unlistedStore = await outcome(storeImports(store));
  redis.pipeline = real;
  is("storeImports throws UnknownReplyError", unlistedStore, { threw: "UnknownReplyError" });

  part("An import on the list answering in an unknown shape is not left out");
  redis.pipeline = (async (commands: Command[]) => {
    const replies = await real(commands);
    return commands.length > 1 && commands.every((command) => command[0] === "GET" && String(command[1]).startsWith("nl:import:")) ? [{ unexpected: true }, ...replies.slice(1)] : replies;
  }) as typeof redis.pipeline;
  const oneUnread = await outcome(storeImports(store));
  redis.pipeline = real;
  is("storeImports throws UnknownReplyError", oneUnread, { threw: "UnknownReplyError" });
  const gonePast = "a".repeat(24);
  await real([["LPUSH", `nl:imports:list:${sid}`, gonePast]]);
  is("healthy control: an import that is truly gone is left out", (await storeImports(store)).map((job) => job.id).includes(gonePast), false);

  // Codex V on #3661 (6788586117), the studio's sibling (rule 30): GET nl:import:A answering a well-formed import of this
  // store that names another id is not import A, so the list is unknown, never shown with it as A nor with A left out.
  part("A record kept under one import's id that names another is not that import");
  const misfiled = "b".repeat(24);
  const kept = JSON.parse(String((await real([["GET", `nl:import:${running}`]]))[0]));
  await real([["SET", `nl:import:${misfiled}`, JSON.stringify({ ...kept, id: "c".repeat(24) })], ["LPUSH", `nl:imports:list:${sid}`, misfiled]]);
  is("storeImports throws UnknownReplyError", await outcome(storeImports(store)), { threw: "UnknownReplyError" });
  await real([["LREM", `nl:imports:list:${sid}`, 0, misfiled], ["DEL", `nl:import:${misfiled}`]]);
  is("healthy control: with it gone, the list reads again", (await storeImports(store))[0]?.id, running);

  // Revisor 2 on #3686 (MEDIUM): a kept text that does not read as an import, and an entry of the list that is not an
  // import id, are unknown, not left out of the studio's list (rule 30).
  part("A kept text that is not an import, and an entry that is not an id, make the list unknown");
  const unreadable = "d".repeat(24);
  await real([["SET", `nl:import:${unreadable}`, "{not json"], ["LPUSH", `nl:imports:list:${sid}`, unreadable]]);
  is("an unreadable kept text: storeImports throws UnknownReplyError", await outcome(storeImports(store)), { threw: "UnknownReplyError" });
  await real([["LREM", `nl:imports:list:${sid}`, 0, unreadable], ["DEL", `nl:import:${unreadable}`]]);
  await real([["LPUSH", `nl:imports:list:${sid}`, "not-an-import-id"]]);
  is("an entry that is not an import id: storeImports throws UnknownReplyError", await outcome(storeImports(store)), { threw: "UnknownReplyError" });
  await real([["LREM", `nl:imports:list:${sid}`, 0, "not-an-import-id"]]);
  is("healthy control: with both gone, the list reads again", (await storeImports(store))[0]?.id, running);

  // Claude 4 (cloud A) LOW and Claude 1 (cloud reviewer C3) LEVE on #3686: an import on this store's list whose store
  // is missing, null, empty or not text says nothing of whose it is, so the list is unknown, never shorter (rule 30),
  // as its MCP sibling storeImportsRead already reads it (Codex G on #1933). One naming another store is still left out.
  part("An import on the store's list kept without a store that reads is unknown, never left out");
  for (const [label, value] of [["missing", undefined], ["null", null], ["a number", 7], ["empty", ""]] as [string, unknown][]) {
    const nameless = "e".repeat(24);
    const record: Record<string, unknown> = { ...JSON.parse(String((await real([["GET", `nl:import:${running}`]]))[0])), id: nameless };
    if (value === undefined) delete record.sid;
    else record.sid = value;
    await real([["SET", `nl:import:${nameless}`, JSON.stringify(record)], ["LPUSH", `nl:imports:list:${sid}`, nameless]]);
    is(`its store ${label}: storeImports throws UnknownReplyError`, await outcome(storeImports(store)), { threw: "UnknownReplyError" });
    await real([["LREM", `nl:imports:list:${sid}`, 0, nameless], ["DEL", `nl:import:${nameless}`]]);
  }
  {
    const elsewhere = "e".repeat(24);
    const record = { ...JSON.parse(String((await real([["GET", `nl:import:${running}`]]))[0])), id: elsewhere, sid: "9".repeat(32) };
    await real([["SET", `nl:import:${elsewhere}`, JSON.stringify(record)], ["LPUSH", `nl:imports:list:${sid}`, elsewhere]]);
    is("healthy control: an import naming another store is left out", (await storeImports(store)).map((job) => job.id).includes(elsewhere), false);
    await real([["LREM", `nl:imports:list:${sid}`, 0, elsewhere], ["DEL", `nl:import:${elsewhere}`]]);
  }

  // Revisor 2 on #3686 (MEDIUM): the GET of import B's key answering import A's record is not B (readJob, jobOf).
  part("One import's key holding another import's record is not that import");
  const mixed = "f".repeat(24);
  const other = JSON.parse(String((await real([["GET", `nl:import:${running}`]]))[0]));
  await real([["SET", `nl:import:${mixed}`, JSON.stringify(other)]]);
  is("readJob throws UnknownReplyError", await outcome(readJob(mixed)), { threw: "UnknownReplyError" });
  is("jobOf throws UnknownReplyError", await outcome(jobOf(store, mixed)), { threw: "UnknownReplyError" });
  is("healthy control: an import under its own id reads", (await readJob(running))?.id, running);
  await real([["DEL", `nl:import:${mixed}`]]);

  part("Healthy control: the emails of an import are done only when its queue is empty");
  const mailing = (id: string): ImportJob => ({
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
  });
  const put = async (job: ImportJob) =>
    real([
      ["SET", `nl:import:${job.id}`, JSON.stringify(job), "EX", 3600],
      ["SADD", ACTIVE, job.id],
      ["SADD", `nl:import:${job.id}:mail`, "ann@example.com", "ben@example.com", "cal@example.com"],
      ["SET", `nl:imports:busy:${sid}`, job.id, "EX", 3600],
    ]);
  const mailed = "e".repeat(24);
  await put(mailing(mailed));
  const emptied = await runImport(mailed, Date.now() + 30_000);
  is("done once nobody waits, off the list", [emptied?.state, (await real([["SCARD", `nl:import:${mailed}:mail`]]))[0], await active(mailed)], ["done", 0, 0]);

  part("An unknown answer to the read of the queue leaves the addresses queued and the import mailing");
  const odd = "f".repeat(24);
  await put(mailing(odd));
  oddly((command) => command[0] === "SPOP" || command[0] === "SRANDMEMBER");
  const after = await runImport(odd, Date.now() + 30_000);
  redis.pipeline = real;
  is("not done: still mailing, every address still queued, still active", [after?.state, (await readJob(odd))?.state, (await real([["SCARD", `nl:import:${odd}:mail`]]))[0], await active(odd)], ["mailing", "mailing", 3, 1]);
  const resumed = await runImport(odd, Date.now() + 30_000);
  is("read again, the queue empties and it is done", [resumed?.state, (await real([["SCARD", `nl:import:${odd}:mail`]]))[0], await active(odd)], ["done", 0, 0]);

  part("Addresses taken off the queue on the server, with the reply lost on the way back, are queued again");
  // Independent review on #2881, L3: the command that takes addresses off the queue runs on the server, and only
  // its reply comes back unreadable. Before, SPOP had already removed them, and nobody knew which: they were
  // neither emailed nor counted as not emailed.
  const lost = "9".repeat(24);
  await put(mailing(lost));
  const takes = (command: Command) => (command[0] === "SPOP" || command[0] === "SREM") && command[1] === `nl:import:${lost}:mail`;
  redis.pipeline = (async (commands: Command[]) => {
    const replies = await real(commands);
    return commands.length === 1 && takes(commands[0]) ? [{ unexpected: true }] : replies;
  }) as typeof redis.pipeline;
  const garbled = await runImport(lost, Date.now() + 30_000);
  redis.pipeline = real;
  is("still mailing, every address back on the queue, still active", [garbled?.state, (await readJob(lost))?.state, (await real([["SCARD", `nl:import:${lost}:mail`]]))[0], await active(lost)], ["mailing", "mailing", 3, 1]);
  is("the very same three addresses wait", ((await real([["SMEMBERS", `nl:import:${lost}:mail`]]))[0] as string[]).slice().sort(), ["ann@example.com", "ben@example.com", "cal@example.com"]);
  const recovered = await runImport(lost, Date.now() + 30_000);
  is("read again, the queue empties and it is done", [recovered?.state, (await real([["SCARD", `nl:import:${lost}:mail`]]))[0], await active(lost)], ["done", 0, 0]);

  part("Two imports started at once against a slot a finished import still holds: only one starts");
  // Independent review on #2881, L2: both found the slot taken (SET NX), both read a finished holder, and both
  // took the slot with a plain SET, so two imports of one store ran at once.
  const slot = `nl:imports:busy:${sid}`;
  await real([["SET", slot, mailed, "EX", 3600]]);
  let waiting: (() => void)[] = [];
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === slot) {
      // Both starts read the holder before either acts on it, as two requests at the same instant can.
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length === 2) for (const go of waiting.splice(0)) go();
        else setTimeout(() => waiting.splice(0).forEach((go) => go()), 500);
      });
    }
    return real(commands);
  }) as typeof redis.pipeline;
  const both = await Promise.all([startImport(store, OWNER, "contacts", INPUT), startImport(store, OWNER, "contacts", INPUT)]);
  redis.pipeline = real;
  waiting = [];
  const started = both.flatMap((one) => (one.ok ? [one.job.id] : []));
  is("one started, the other told the store is busy", [started.length, both.map((one) => (one.ok ? "started" : one.reason)).sort()], [1, ["busy", "started"]]);
  is("the slot is the one that started", (await real([["GET", slot]]))[0], started[0] ?? null);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
