/**
 * The workflows' meter (lib/flows.ts, FlowMeter) at its edges (pre-review of
 * claude5/flow-save-units, 7 November 2026):
 *
 * 1. A list grown between its measure (STRLEN) and its read (another tab
 *    saving): the read moved bytes no studio request had paid for before it,
 *    and when the difference was refused they stayed unpaid. A read now moves
 *    the list only while it is no larger than what was paid for.
 * 2. The starter sequences: written one by one, so a refusal of the meter
 *    between the first and the second left the first written while the route
 *    answered 429 with NOT_COUNTED ("nothing was read or changed").
 * 3. "Resolve a held run" read the list through the meter, then once more,
 *    unmetered, inside resolveHeldRun, even for a run that does not exist.
 * 4. A save refused because the store's data room is full had already taken
 *    the studio requests for writing the list it never wrote.
 *
 * Measured with the in-memory Redis and the real route; nothing is forged.
 */
import { NextRequest } from "next/server";
import { DataRoomError, dataKey, dataUsed } from "@/lib/store-data";
import { contentRoomFor } from "@/lib/store-data-rules";
import { FlowMeter, FlowNotCounted, flowListUnits, readFlows, saveFlow } from "@/lib/flows";
import { MAX_FLOWS, MAX_STEPS } from "@/lib/flow-limits";
import { setUpStarters } from "@/lib/mail-starters";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { allowanceUsed } from "@/lib/store-allowance";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Store } from "@/lib/store";
import { POST as mailRoute } from "@/app/api/store/mail/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "races@example.com";
const utf8 = (text: string) => Buffer.byteLength(text, "utf8");
const steps = (count: number, chars: number, v: number) =>
  Array.from({ length: count }, (_, i) => ({ delayHours: i * 24, subject: `Step ${i} v${v}`, body: `${"x".repeat(chars - 8)} v${v}`.slice(0, chars) }));

async function setUp() {
  redis.clear();
  await claimHandle(OWNER, "races", "Races Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRace00001", true);
  await setSubscription(OWNER, { customerId: "cus_Race0001", subscriptionId: "sub_Race0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Races Kitchen", address: "1 Main St, Portland, OR 97201" });
}
const current = async () => (await storeForEmail(OWNER))!;

/** Whether a batch reads the list's value: a GET of it, or a script given its key. */
const readsList = (batch: (string | number)[][], key: string) => batch.some((c) => (c[0] === "GET" && c[1] === key) || (c[0] === "EVAL" && c.slice(3).includes(key)));
/** The list's bytes a reply carried: the longest string in it. */
function carried(reply: unknown): number {
  if (typeof reply === "string") return utf8(reply);
  if (Array.isArray(reply)) return reply.reduce((most: number, one) => Math.max(most, carried(one)), 0);
  return 0;
}

async function main(): Promise<void> {
  part("1. The list grows between its measure and its read");
  for (const allowMore of [false, true]) {
    await setUp();
    const one = await saveFlow(await current(), { name: "Small", trigger: "joined", steps: steps(2, 30_000, 0) });
    if (!one.ok) throw new Error("no flow");
    const listId = (await current()).listId as string;
    const key = `nl:mail:flows:${listId}`;
    // A larger list, as another tab would write it between the STRLEN and the read: 8 workflows of about 380 KB.
    const big = [...one.flows];
    for (let n = 0; n < 8; n += 1) big.push({ ...one.flows[0], id: `bigflow${String(n).padStart(9, "0")}`.slice(0, 16), name: `Big ${n}`, steps: steps(MAX_STEPS, 19_000, n).map((s, i) => ({ ...s, id: `st${n}x${String(i).padStart(10, "0")}`.slice(0, 16) })) } as never);
    const bigBytes = utf8(JSON.stringify(big));
    const base = redis.pipeline.bind(redis);
    let taken = 0;
    let grown = false;
    const reads: { before: number; moved: number }[] = [];
    redis.pipeline = async (batch) => {
      const before = taken;
      const reply = await base(batch);
      if (readsList(batch, key)) reads.push({ before, moved: carried(reply) });
      if (!grown && batch.some((c) => c[0] === "STRLEN" && c[1] === key)) {
        grown = true;
        await base([["SET", key, JSON.stringify(big)]]);
      }
      return reply;
    };
    // The small list fits in what one studio request moves, so any charge is for the grown one.
    const meter = new FlowMeter(async (units) => {
      if (!allowMore) return { ok: false, message: "" };
      taken += units;
      return { ok: true };
    });
    let outcome = "";
    try {
      const flows = await meter.list(listId);
      outcome = `read ${flows.length}`;
    } catch (error) {
      outcome = error instanceof FlowNotCounted ? "refused" : String(error);
    } finally {
      redis.pipeline = base;
    }
    console.log("C5_FLOW_RACE", JSON.stringify({ allowMore, bigBytes, reads, taken, outcome }));
    const paidBefore = reads.every((r) => r.before >= flowListUnits(r.moved, 0));
    if (allowMore) {
      is("with the difference taken, the grown list is read whole", outcome, `read ${big.length}`);
      is("and every read that moved it was paid for before it moved it", paidBefore, true);
      is("and what was taken pays for reading it and sending it back", taken >= flowListUnits(bigBytes, bigBytes), true);
    } else {
      is("the small list needs no studio request beyond the action's own", flowListUnits(utf8(JSON.stringify(one.flows)), utf8(JSON.stringify(one.flows))), 0);
      is("with the difference refused, it is refused as not counted", outcome, "refused");
      is("and the grown list was never moved by a read", reads.every((r) => r.moved < bigBytes), true);
      is("and every read that moved anything was paid for before it", paidBefore, true);
    }
  }

  part("2. The starter sequences: a refusal of the meter never leaves one written");
  let partial = "";
  for (let allow = 0; allow <= 6; allow += 1) {
    await setUp();
    for (let n = 0; n < 3; n += 1) {
      const made = await saveFlow(await current(), { name: `Big ${n}`, trigger: "tagged", tag: `t${n}`, steps: steps(MAX_STEPS, 19_000, n) });
      if (!made.ok) throw new Error(`big ${n}: ${made.reason}`);
    }
    const s = await current();
    const store = { ...s, catalog: { ...s.catalog, items: [...s.catalog.items, { id: "prod00000001", kind: 1, options: [] }] } } as unknown as Store;
    const before = await readFlows(s.listId);
    let n = 0;
    const m = new FlowMeter(async () => (++n <= allow ? { ok: true } : { ok: false, message: "" }));
    let threw = false;
    try {
      await setUpStarters(store, m);
    } catch (error) {
      threw = error instanceof FlowNotCounted;
    }
    const after = await readFlows(s.listId);
    if (threw && JSON.stringify(after) !== JSON.stringify(before)) partial += `${allow} `;
  }
  is("refused at any of its charges, the list is left as it was", partial, "");
  {
    await setUp();
    await saveFlow(await current(), { name: "Big", trigger: "tagged", tag: "t", steps: steps(MAX_STEPS, 19_000, 0) });
    const s = await current();
    const store = { ...s, catalog: { ...s.catalog, items: [...s.catalog.items, { id: "prod00000001", kind: 1, options: [] }] } } as unknown as Store;
    const key = `nl:mail:flows:${s.listId}`;
    const base = redis.pipeline.bind(redis);
    let writes = 0;
    redis.pipeline = async (batch) => {
      writes += batch.filter((c) => c[0] === "SET" && c[1] === key).length;
      return base(batch);
    };
    let made: Awaited<ReturnType<typeof setUpStarters>>;
    try {
      made = await setUpStarters(store, new FlowMeter(async () => ({ ok: true })));
    } finally {
      redis.pipeline = base;
    }
    is("taken in full, the starters are made", made.ok ? made.made.length : made.reason, 2);
    is("in one write of the list", writes, 1);
    is("and what is kept is what the answer says", JSON.stringify(await readFlows(s.listId)), JSON.stringify(made.ok ? made.flows : null));
  }

  part("3. Resolving a held run reads the list once, through the meter");
  await setUp();
  const session = await openSession(OWNER);
  const chars = Math.floor((400_000 - 4_000) / MAX_STEPS) - 100;
  let id = "";
  for (let n = 0; n < MAX_FLOWS; n += 1) {
    const made = await saveFlow(await current(), { name: `W ${n}`, trigger: "joined", steps: steps(MAX_STEPS, chars, n) });
    if (!made.ok) throw new Error(`w ${n}: ${made.reason}`);
    id = made.flows[0].id;
  }
  {
    const key = `nl:mail:flows:${(await current()).listId}`;
    const usedBefore = await allowanceUsed(await current(), "studio");
    const base = redis.pipeline.bind(redis);
    let read = 0;
    let dbBytes = 0;
    redis.pipeline = async (batch) => {
      if (readsList(batch, key)) read += 1;
      dbBytes += utf8(JSON.stringify(batch));
      const reply = await base(batch);
      dbBytes += utf8(JSON.stringify(reply));
      return reply;
    };
    let status = 0;
    try {
      const response = await mailRoute(new NextRequest("https://marktmorgen.com/api/store/mail", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ action: "flow-resolve", id, run: "0".repeat(32), choice: "end" }) }));
      status = response.status;
    } finally {
      redis.pipeline = base;
    }
    const units = (await allowanceUsed(await current(), "studio")) - usedBefore;
    console.log("C5_FLOW_RESOLVE", JSON.stringify({ status, read, dbBytes, units }));
    is("a run that does not exist is not found", status, 404);
    is("and the list was read once", read, 1);
    is("and everything it moved through the database was taken for", units >= 1 + flowListUnits(dbBytes, 0), true);
  }

  part("4. A save refused for a full data room takes no studio request for the write");
  await setUp();
  {
    const s = await current();
    const used = await dataUsed(s);
    // Room left for less than the workflow about to be saved.
    const fill = contentRoomFor(s, Date.now() / 1000) - used!.used - 100_000;
    redis.run(["HINCRBY", dataKey(s)!, "ct", fill]);
    redis.run(["HINCRBY", dataKey(s)!, "#", fill]);
    let taken = 0;
    let threw = "";
    try {
      await saveFlow(s, { name: "Too big", trigger: "joined", steps: steps(MAX_STEPS, 19_000, 0) }, { meter: new FlowMeter(async (units) => ((taken += units), { ok: true })) });
    } catch (error) {
      threw = error instanceof DataRoomError ? "full" : String(error);
    }
    is("it is refused as full", threw, "full");
    is("and took no studio request for a write that never happened", taken, 0);
    is("and nothing was written", (await readFlows(s.listId)).length, 0);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
