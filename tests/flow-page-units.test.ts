/**
 * The siblings of tests/flow-save-units.test.ts (regra 30, 7 November 2026): what the studio's email page and the
 * removal of a workflow move of the store's workflows, and the studio requests taken for it. One studio request is
 * priced at its shape (tests/plan-cost-registry.ts, UNIT_COST.studio).
 *
 *   1. The email page (app/studio/email/page.tsx) read the whole list of workflows inside its own STUDIO_PAGE_UNITS
 *      (the worst list the code allows is about 15.8 MB through the database) and sent it on to the browser in the
 *      page's flight data, escaped once more inside the HTML. Held here: the page reads it through the same meter
 *      as the studio's actions (lib/flows.ts, readFlowsForPage), which measures it and takes what it comes to
 *      before reading it; without those studio requests nothing of it is read and the page says why, in words.
 *   2. Removing a workflow erases every run of it (purgeFlow): for each person, their run, its history, their
 *      start, their place in two indexes and their steps in the queue under every address the store has had, about
 *      seven commands and up to a dozen kilobytes a person, for thousands of people over 400 days, all inside the
 *      one studio request of the removal. Held here: the runs are counted and the erasure is taken for before the
 *      list is written; without those studio requests the workflow stays, with every run of it.
 *   3. "Resolve a held run" read the list twice, once through the meter and once more, unmetered, inside
 *      resolveHeldRun. Held here: once.
 *
 * Measured with the in-memory Redis on the real code: every command and byte sent and answered, the response's
 * bytes, and the studio requests taken (allowanceUsed). Synthetic stores and people only.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import * as flowsModule from "@/lib/flows";
import { readFlows, saveFlow } from "@/lib/flows";
import { readFlowListStrict } from "@/lib/flow-list";
import { personOf } from "@/lib/flow-runs";
import { MAX_FLOWS, MAX_STEPS } from "@/lib/flow-limits";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { countUnits } from "@/lib/person-agenda-read";
import { allowanceUsed, forceAllowance } from "@/lib/store-allowance";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { PAGE_INCLUDED_BYTES } from "@/lib/sent-bytes";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { POST as mailRoute } from "@/app/api/store/mail/route";
import { ORIGIN_PER_BYTE, UNIT_COST, request } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "pageunits@example.com";
const utf8 = (text: string) => Buffer.byteLength(text, "utf8");

async function setUp() {
  redis.clear();
  await claimHandle(OWNER, "pageunits", "Page Units Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPage00001", true);
  await setSubscription(OWNER, { customerId: "cus_Page0001", subscriptionId: "sub_Page0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Page Units Kitchen", address: "1 Main St, Portland, OR 97201" });
}

const current = async () => (await storeForEmail(OWNER))!;

const steps = (count: number, chars: number, v: number, fill = "x") =>
  Array.from({ length: count }, (_, i) => ({ delayHours: i * 24, subject: `Step ${i} v${v}`, body: `${fill.repeat(chars - 8)} v${v}`.slice(0, chars) }));

type Tally = { commands: number; dbBytes: number; flowsRead: number; flowsWritten: number };

/** Runs `work` with every database command and byte counted. */
async function tallied<T>(listId: string, work: () => Promise<T>): Promise<{ result: T | "threw"; tally: Tally }> {
  const flowsKey = `nl:mail:flows:${listId}`;
  const base = redis.pipeline.bind(redis);
  const tally: Tally = { commands: 0, dbBytes: 0, flowsRead: 0, flowsWritten: 0 };
  redis.pipeline = async (batch) => {
    tally.commands += batch.length;
    tally.dbBytes += utf8(JSON.stringify(batch));
    for (const c of batch) {
      // A read of the list: a GET of it, or the bounded read (lib/flow-list.ts, READ_FLOWS_WITHIN) given its key.
      if ((c[0] === "GET" && c[1] === flowsKey) || (c[0] === "EVAL" && c.slice(3).includes(flowsKey))) tally.flowsRead += 1;
      if (c[0] === "SET" && c[1] === flowsKey) tally.flowsWritten += 1;
    }
    const reply = await base(batch);
    tally.dbBytes += utf8(JSON.stringify(reply));
    return reply;
  };
  try {
    return { result: await work(), tally };
  } catch {
    return { result: "threw", tally };
  } finally {
    redis.pipeline = base;
  }
}

type Measured = Tally & { status: number; data: Record<string, unknown>; sentBytes: number; units: number };

async function route(session: string, body: Record<string, unknown>): Promise<Measured> {
  const store = await current();
  const usedBefore = await allowanceUsed(store, "studio");
  let status = 0, text = "";
  const { tally } = await tallied(store.listId as string, async () => {
    const response = await mailRoute(new NextRequest("https://marktmorgen.com/api/store/mail", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    status = response.status;
    text = await response.text();
  });
  const units = (await allowanceUsed(await current(), "studio")) - usedBefore;
  return { ...tally, status, data: JSON.parse(text) as Record<string, unknown>, sentBytes: utf8(text), units };
}

/** What moving it cost at the registry's own prices: its commands and database bytes at the studio shape, and what it sent on. */
const costOf = (m: { commands: number; dbBytes: number; sentBytes: number }) => request("studio", m.commands, m.dbBytes) + m.sentBytes * ORIGIN_PER_BYTE;

function covered(what: string, m: { commands: number; dbBytes: number; sentBytes: number; units: number }) {
  console.log(`C5_FLOW_PAGE ${what}`, JSON.stringify({ commands: m.commands, dbBytes: m.dbBytes, sentBytes: m.sentBytes, units: m.units }));
  is(`${what}: past the ${PAGE_INCLUDED_BYTES} bytes one studio request moves, more than one is taken`, m.dbBytes > PAGE_INCLUDED_BYTES || m.sentBytes > PAGE_INCLUDED_BYTES ? m.units >= 1 : true, true);
  is(`${what}: the studio requests taken pay for what it moved at the registry's prices`, m.units * UNIT_COST.studio >= costOf(m), true);
}

type PageRead = { ok: true; flows: unknown[] } | { ok: false; refused: string };
type PageReader = (listId: string | null, charge: (units: number) => Promise<{ ok: true } | { ok: false; message: string }>) => Promise<PageRead>;

/** What the page sends of the list: its flight data, the list's JSON escaped once more inside the HTML, and what it draws of it, at most the list again. */
const pageSent = (flows: unknown[]) => utf8(JSON.stringify(JSON.stringify(flows))) + utf8(JSON.stringify(flows));

/** `count` runs of workflow `flowId`, as enroll leaves them: the index, the run, its history, the start and a queued step. */
async function seedRuns(listId: string, handle: string, flowId: string, count: number): Promise<string[]> {
  const now = Math.floor(Date.now() / 1000);
  const people: string[] = [];
  const batch: (string | number)[][] = [];
  for (let n = 0; n < count; n += 1) {
    const email = `person${n}.with.a.longer.address@example.com`;
    const person = personOf(email);
    people.push(person);
    batch.push(
      ["ZADD", `nl:wf:runs:${flowId}`, now - n, person],
      ["HSET", `nl:wf:run:${flowId}:${person}`, "email", email, "status", "running", "step", 1, "updatedAt", now],
      ["RPUSH", `nl:wf:log:${flowId}:${person}`, JSON.stringify({ at: now, step: 0, kind: "run", state: "started" })],
      ["SET", `nl:mail:enr:${flowId}:${person}`, "1"],
      ["ZADD", "nl:mail:flowq", now + 3600, `${listId}|${handle}|${flowId}|1|${email}`],
    );
  }
  for (let i = 0; i < batch.length; i += 1000) await redis.pipeline(batch.slice(i, i + 1000));
  return people;
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------- part 1
  part("1. The email page reads the workflows through the meter, never whole and unpaid");
  const page = readFileSync("app/studio/email/page.tsx", "utf8");
  is("the page no longer reads the whole list unmetered", /readFlowListStrict\(/.test(page), false);
  is("it reads it through readFlowsForPage, paying from the store's studio requests", /readFlowsForPage\(/.test(page) && /countUnits\(/.test(page), true);
  is("and says, in words, why the sequences are not shown when it was refused", /flowsRefused/.test(page) && /reading them takes studio requests/.test(page), true);

  const reader = (flowsModule as unknown as { readFlowsForPage?: PageReader }).readFlowsForPage;
  is("the page's reader of the workflows exists", typeof reader, "function");
  if (typeof reader === "function") {
    await setUp();
    const chars = Math.floor((400_000 - 4_000) / MAX_STEPS) - 100;
    for (let n = 0; n < MAX_FLOWS; n += 1) {
      const made = await saveFlow(await current(), { name: `Worst ${n}`, trigger: "joined", steps: steps(MAX_STEPS, chars, n) });
      if (!made.ok) throw new Error(`worst ${n}: ${made.reason}`);
    }
    const store = await current();
    const listId = store.listId as string;
    const pay = (units: number) => countUnits(store, units);
    const usedBefore = await allowanceUsed(store, "studio");
    const { result, tally } = await tallied(listId, () => reader(listId, pay));
    const units = (await allowanceUsed(await current(), "studio")) - usedBefore;
    const strict = await readFlowListStrict(listId);
    is("the worst list: every workflow, as readFlowListStrict reads it", result !== "threw" && result.ok ? result.flows : result, strict);
    covered("worst page read", { ...tally, sentBytes: pageSent(strict), units });

    part("1b. Bodies of quotes cross the HTML escaped twice: paid for as such");
    await setUp();
    const quoted = Math.floor(chars / 2);
    for (let n = 0; n < MAX_FLOWS; n += 1) {
      const made = await saveFlow(await current(), { name: `Quoted ${n}`, trigger: "joined", steps: steps(MAX_STEPS, quoted, n, '"') });
      if (!made.ok) throw new Error(`quoted ${n}: ${made.reason}`);
    }
    const qStore = await current();
    const qBefore = await allowanceUsed(qStore, "studio");
    const q = await tallied(qStore.listId as string, () => reader(qStore.listId as string, (u) => countUnits(qStore, u)));
    const qUnits = (await allowanceUsed(await current(), "studio")) - qBefore;
    covered("quoted page read", { ...q.tally, sentBytes: pageSent(await readFlowListStrict(qStore.listId as string)), units: qUnits });

    part("1c. A small list costs nothing beyond the page's own studio requests");
    await setUp();
    const small = await saveFlow(await current(), { name: "Small", trigger: "joined", steps: steps(2, 200, 0) });
    if (!small.ok) throw new Error("no small workflow");
    const sStore = await current();
    const sBefore = await allowanceUsed(sStore, "studio");
    const s = await tallied(sStore.listId as string, () => reader(sStore.listId as string, (u) => countUnits(sStore, u)));
    is("read as it is", s.result !== "threw" && s.result.ok ? s.result.flows : s.result, small.flows);
    is("no studio request more", (await allowanceUsed(await current(), "studio")) - sBefore, 0);
    is("a store with no list has none, read from nowhere", await reader(null, (u) => countUnits(sStore, u)), { ok: true, flows: [] });

    part("1d. Without the studio requests the list needs, it is not read, and the page is told why");
    await setUp();
    for (let n = 0; n < MAX_FLOWS; n += 1) {
      const made = await saveFlow(await current(), { name: `Worst ${n}`, trigger: "joined", steps: steps(MAX_STEPS, chars, n) });
      if (!made.ok) throw new Error(`worst ${n}: ${made.reason}`);
    }
    const rStore = await current();
    await forceAllowance(rStore, "studio", STORE_ALLOWANCES.pro.studio - (await allowanceUsed(rStore, "studio")) - 1);
    const refused = await tallied(rStore.listId as string, () => reader(rStore.listId as string, (u) => countUnits(rStore, u)));
    is("refused, in words", refused.result !== "threw" && !refused.result.ok && refused.result.refused.length > 10, true);
    is("the list was not read", refused.tally.flowsRead, 0);

    part("1e. A size that does not come back: refused, in words, nothing read");
    const base = redis.pipeline.bind(redis);
    redis.pipeline = async (batch) => (batch.some((c) => c[0] === "STRLEN") ? batch.map(() => "not a number") : base(batch));
    let unknown: Awaited<ReturnType<typeof tallied<PageRead>>>;
    try {
      unknown = await tallied(rStore.listId as string, () => reader(rStore.listId as string, async () => ({ ok: true })));
    } finally {
      redis.pipeline = base;
    }
    // Regra 23 (changed after the RED commit): the reader refuses with an empty reason when nothing could be counted,
    // as FlowNotCounted("") does for the route, and the page says it with NOT_COUNTED (lib/person-agenda-read.ts).
    is("refused, with no count to say", unknown.result !== "threw" && !unknown.result.ok ? unknown.result.refused : unknown.result, "");
    is("which the page says in words", /refused \|\| NOT_COUNTED/.test(page), true);
    is("nothing read", unknown.tally.flowsRead, 0);
  }

  // ---------------------------------------------------------------- part 2
  part("2. Removing a workflow with its runs: the erasure is taken for before the list is written");
  await setUp();
  const session = await openSession(OWNER);
  const made = await saveFlow(await current(), { name: "Busy", trigger: "joined", steps: steps(3, 200, 0) });
  if (!made.ok) throw new Error("no workflow");
  const flowId = made.flows[0].id;
  const store = await current();
  const RUNS = 600;
  const people = await seedRuns(store.listId as string, store.handle, flowId, RUNS);
  const removed = await route(session, { action: "flow-remove", id: flowId });
  is("removed", removed.data.ok, true);
  covered(`flow-remove with ${RUNS} runs`, removed);
  const left = await redis.pipeline([["EXISTS", `nl:wf:runs:${flowId}`], ["EXISTS", `nl:wf:run:${flowId}:${people[0]}`], ["EXISTS", `nl:mail:enr:${flowId}:${people[RUNS - 1]}`], ["ZCARD", "nl:mail:flowq"]]);
  is("every run of it erased", left, [0, 0, 0, 0]);

  part("2b. Without the studio requests the erasure needs, the workflow stays, with every run of it");
  await setUp();
  const session2 = await openSession(OWNER);
  const kept = await saveFlow(await current(), { name: "Busy", trigger: "joined", steps: steps(3, 200, 0) });
  if (!kept.ok) throw new Error("no workflow");
  const keptId = kept.flows[0].id;
  const keptStore = await current();
  await seedRuns(keptStore.listId as string, keptStore.handle, keptId, RUNS);
  // Enough for the list, not for erasing six hundred runs.
  await forceAllowance(keptStore, "studio", STORE_ALLOWANCES.pro.studio - (await allowanceUsed(keptStore, "studio")) - 20);
  const before = JSON.stringify(await readFlows(keptStore.listId));
  const refusedRemove = await route(session2, { action: "flow-remove", id: keptId });
  is("answered as studio requests used", [refusedRemove.status, refusedRemove.data.error], [429, "studio_used"]);
  is("the list was not written", [refusedRemove.flowsWritten, JSON.stringify(await readFlows(keptStore.listId)) === before], [0, true]);
  is("every run kept", await redis.pipeline([["ZCARD", `nl:wf:runs:${keptId}`], ["ZCARD", "nl:mail:flowq"]]), [RUNS, RUNS]);

  // ---------------------------------------------------------------- part 3
  part("3. Resolving a held run reads the list once, through the meter");
  await setUp();
  const session3 = await openSession(OWNER);
  const held = await saveFlow(await current(), { name: "Held", trigger: "joined", steps: steps(2, 200, 0) });
  if (!held.ok) throw new Error("no workflow");
  const resolve = await route(session3, { action: "flow-resolve", id: held.flows[0].id, run: "0".repeat(32), choice: "end" });
  is("a run that is not there", [resolve.status, resolve.data.error], [404, "unknown"]);
  is("the list read once", resolve.flowsRead, 1);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
