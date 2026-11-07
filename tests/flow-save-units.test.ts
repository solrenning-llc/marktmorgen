/**
 * What a studio action on the store's workflows moves, and the studio requests it takes for that (review of #1927,
 * 7 November 2026). One studio request is priced at its shape: twenty commands and fifty kilobytes through the
 * database (tests/plan-cost-registry.ts, UNIT_COST.studio); past PAGE_INCLUDED_BYTES, one more a megabyte through
 * the database (lib/segments.ts, ledgerUnits) and one a megabyte sent on to the browser (lib/sent-bytes.ts,
 * sentUnits). A save reads the whole list of workflows, writes it back and sends it back, so a long list moved
 * more than one request pays for without taking any more.
 *
 * Measured through the real mail route with the in-memory Redis: every command and byte sent to it and answered,
 * the response's bytes, and the studio requests taken (allowanceUsed). Nothing is forged.
 */
import { NextRequest } from "next/server";
import { readFlows, saveFlow } from "@/lib/flows";
import { MAX_FLOWS, MAX_STEPS } from "@/lib/flow-limits";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { allowanceUsed, forceAllowance } from "@/lib/store-allowance";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { PAGE_INCLUDED_BYTES } from "@/lib/sent-bytes";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { POST as mailRoute } from "@/app/api/store/mail/route";
import { ORIGIN_PER_BYTE, UNIT_COST, request } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "units@example.com";
const utf8 = (text: string) => Buffer.byteLength(text, "utf8");

async function setUp() {
  redis.clear();
  await claimHandle(OWNER, "units", "Units Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestUnit00001", true);
  await setSubscription(OWNER, { customerId: "cus_Unit0001", subscriptionId: "sub_Unit0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Units Kitchen", address: "1 Main St, Portland, OR 97201" });
}

const current = async () => (await storeForEmail(OWNER))!;

/** `count` steps of `chars` characters each, every one written for version `v`. */
const steps = (count: number, chars: number, v: number) =>
  Array.from({ length: count }, (_, i) => ({ delayHours: i * 24, subject: `Step ${i} v${v}`, body: `${"x".repeat(chars - 8)} v${v}`.slice(0, chars) }));

type Measured = { status: number; data: Record<string, unknown>; commands: number; dbBytes: number; sentBytes: number; units: number; flowsRead: number; flowsWritten: number };

async function measure(session: string, body: Record<string, unknown>): Promise<Measured> {
  const list = (await current()).listId as string;
  const flowsKey = `nl:mail:flows:${list}`;
  const usedBefore = await allowanceUsed(await current(), "studio");
  const base = redis.pipeline.bind(redis);
  let commands = 0, dbBytes = 0, flowsRead = 0, flowsWritten = 0;
  redis.pipeline = async (batch) => {
    commands += batch.length;
    dbBytes += utf8(JSON.stringify(batch));
    for (const c of batch) {
      if (c[0] === "GET" && c[1] === flowsKey) flowsRead += 1;
      if (c[0] === "SET" && c[1] === flowsKey) flowsWritten += 1;
    }
    const reply = await base(batch);
    dbBytes += utf8(JSON.stringify(reply));
    return reply;
  };
  let status = 0, text = "";
  try {
    const response = await mailRoute(new NextRequest("https://marktmorgen.com/api/store/mail", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    status = response.status;
    text = await response.text();
  } finally {
    redis.pipeline = base;
  }
  const units = (await allowanceUsed(await current(), "studio")) - usedBefore;
  return { status, data: JSON.parse(text) as Record<string, unknown>, commands, dbBytes, sentBytes: utf8(text), units, flowsRead, flowsWritten };
}

/** What the request cost at the registry's own prices: its commands and database bytes at the studio shape, and what it sent on. */
const costOf = (m: Measured) => request("studio", m.commands, m.dbBytes) + m.sentBytes * ORIGIN_PER_BYTE;

function covered(what: string, m: Measured) {
  console.log(`C5_FLOW_UNITS ${what}`, JSON.stringify({ status: m.status, ok: m.data.ok, commands: m.commands, dbBytes: m.dbBytes, sentBytes: m.sentBytes, units: m.units }));
  is(`${what}: past the ${PAGE_INCLUDED_BYTES} bytes one studio request moves, more than one is taken`, m.dbBytes > PAGE_INCLUDED_BYTES || m.sentBytes > PAGE_INCLUDED_BYTES ? m.units > 1 : true, true);
  is(`${what}: the studio requests taken pay for what it moved at the registry's prices`, m.units * UNIT_COST.studio >= costOf(m), true);
}

async function main(): Promise<void> {
  part("one workflow of five steps of 10,000 characters (the review's case)");
  await setUp();
  const session = await openSession(OWNER);
  const first = await saveFlow(await current(), { name: "Long", trigger: "tagged", tag: "vip", steps: steps(5, 10_000, 0) });
  if (!first.ok) throw new Error(`no workflow: ${first.reason}`);
  const id = first.flows[0].id;
  const saved = await measure(session, { action: "flow", flow: { ...first.flows[0], steps: steps(5, 10_000, 1) } });
  is("saved", saved.data.ok, true);
  covered("flow save", saved);

  part("its siblings on the same list: switching it on, its runs, the starter sequences, removing it");
  const on = await measure(session, { action: "flow-activate", id, active: true });
  is("switched on", on.data.ok, true);
  covered("flow-activate", on);
  const runs = await measure(session, { action: "flow-runs", id });
  is("runs listed", runs.data.ok, true);
  covered("flow-runs", runs);
  const starters = await measure(session, { action: "starters" });
  is("starters made", [starters.data.ok, starters.data.error], [true, undefined]);
  covered("starters", starters);
  const removed = await measure(session, { action: "flow-remove", id });
  is("removed", removed.data.ok, true);
  covered("flow-remove", removed);

  part("the worst list the code allows: MAX_FLOWS workflows of MAX_STEPS steps, each saved under the route's 400,000-byte body");
  await setUp();
  const worstSession = await openSession(OWNER);
  // The longest body each step can have with MAX_STEPS of them inside the route's 400,000 bytes.
  const chars = Math.floor((400_000 - 4_000) / MAX_STEPS) - 100;
  let last = "";
  for (let n = 0; n < MAX_FLOWS; n += 1) {
    const made = await saveFlow(await current(), { name: `Worst ${n}`, trigger: "joined", steps: steps(MAX_STEPS, chars, n) });
    if (!made.ok) throw new Error(`worst ${n}: ${made.reason}`);
    last = made.flows.at(-1)!.id;
  }
  const kept = (await readFlows((await current()).listId)).find((f) => f.id === last)!;
  is("the edit fits the route's body", utf8(JSON.stringify({ action: "flow", flow: { ...kept, steps: steps(MAX_STEPS, chars, 99) } })) < 400_000, true);
  const worst = await measure(worstSession, { action: "flow", flow: { ...kept, steps: steps(MAX_STEPS, chars, 99) } });
  is("saved", worst.data.ok, true);
  covered("worst flow save", worst);

  part("refused before the list is read when the studio requests it needs are not left");
  const figure = STORE_ALLOWANCES.pro.studio;
  await forceAllowance(await current(), "studio", figure - (await allowanceUsed(await current(), "studio")) - 1);
  const before = JSON.stringify(await readFlows((await current()).listId));
  const refused = await measure(worstSession, { action: "flow", flow: { ...kept, steps: steps(MAX_STEPS, chars, 100) } });
  console.log("C5_FLOW_UNITS refused", JSON.stringify({ status: refused.status, error: refused.data.error, flowsRead: refused.flowsRead, flowsWritten: refused.flowsWritten }));
  is("answered as studio requests used", [refused.status, refused.data.error], [429, "studio_used"]);
  is("the list was not read", refused.flowsRead, 0);
  is("nothing was written", [refused.flowsWritten, JSON.stringify(await readFlows((await current()).listId)) === before], [0, true]);

  part("refused, with nothing read or written, when the list's size does not come back");
  await setUp();
  const unknownSession = await openSession(OWNER);
  const one = await saveFlow(await current(), { name: "Short", trigger: "joined", steps: steps(1, 100, 0) });
  if (!one.ok) throw new Error("no workflow");
  const base = redis.pipeline.bind(redis);
  redis.pipeline = async (batch) => (batch.some((c) => c[0] === "STRLEN") ? batch.map(() => "not a number") : base(batch));
  let unknown: Measured;
  try {
    unknown = await measure(unknownSession, { action: "flow", flow: { ...one.flows[0], steps: steps(1, 100, 1) } });
  } finally {
    redis.pipeline = base;
  }
  is("answered as not counted", [unknown.status, unknown.data.error], [429, "studio_used"]);
  is("nothing read or written", [unknown.flowsRead, unknown.flowsWritten], [0, 0]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
