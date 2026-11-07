/**
 * Codex G's review of #2560, MEDIUM 1 (privacy, completion), kept with credit from its proof
 * (codex/g-review-2560-exact-claims, tests/g2560-write-race.proof.ts): the walk's batch entry is the
 * only way a store whose record is gone is still walked, so its HSET's receipt is read exactly
 * before the record goes; and a DEL whose receipt is unknown never lets a store be finished or said
 * erased (CX-123 rule 24). Controls: exact ordinary replies delete and finish.
 */
import { createHash } from "node:crypto";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { finishClosed } from "@/lib/plan-closing";
import { BATCH_KEY, DUE_KEY, WALK_GAP_MS, eraseClosed, markDue } from "@/lib/closed-store-data";

type Command = (string | number)[];
const real = redis.pipeline;
let intercept: ((commands: Command[]) => Promise<unknown[] | null>) | null = null;
redis.pipeline = async (commands: Command[]) => (await intercept?.(commands)) ?? real(commands);
let now = Date.UTC(2026, 10, 6);
// A run that throws (an unknown receipt it cannot pass over) is a run that finished nothing: the cron tries again.
const run = () => eraseClosed(Date.now() + 20_000, finishClosed, now).catch(() => ({ finished: 0, threw: true }));
const closingKey = (ref: string) => `nl:plan:closing:${createHash("sha256").update(ref).digest("hex").slice(0, 40)}`;
async function fresh(handle: string) {
  intercept = null;
  redis.clear();
  const email = `${handle}@example.com`;
  await claimHandle(email, handle, handle, "");
  const store = (await storeForEmail(email))!;
  const added = await upsertContact(store.listId!, "person@example.com", { agreed: true, explicit: true, source: "free", sid: store.sid }, store);
  is(`${handle}: real contact writer joined`, added.joined, true);
  await markDue(email, now);
  return { email, store, leads: `nl:store:leads:${store.listId}` };
}
async function state(ref: string) {
  const [raw] = await real([["GET", closingKey(ref)]]);
  return typeof raw === "string" ? JSON.parse(raw) as { erased?: number } : {};
}
async function main(): Promise<void> {
const errorLog = console.error;
console.error = () => {};
try {
  for (const bad of [null, "extra"] as const) {
    part(`Batch write not applied, unknown receipt ${bad}`);
    const { email, leads } = await fresh(`g2560batch${bad ?? "nil"}`);
    let hit = 0;
    intercept = async (commands) => {
      if (commands.some((c) => c[0] === "HSET" && c[1] === BATCH_KEY && c[2] === email) && hit++ === 0) return bad === null ? [null] : [1, 0];
      return null;
    };
    const report = await run();
    intercept = null;
    const [batch, due, kept] = await real([["HEXISTS", BATCH_KEY, email], ["ZSCORE", DUE_KEY, email], ["HLEN", leads]]);
    is("fault reached exactly once; personal data genuinely persisted", [hit, kept], [1, 1]);
    is("unknown batch receipt must retain the original store or its exact durable walk entry and retry", (await storeForEmail(email)) !== null || (batch === 1 && due !== null), true);
    console.log(JSON.stringify({ vector: "batch", bad, report, batch, due, kept, record: (await storeForEmail(email))?.sid ?? null }));
    now += WALK_GAP_MS + 86_400_000;
    await run();
    is("later healthy run never leaves personal data with no store, no batch and no retry", !((await storeForEmail(email)) === null && (await real([["HEXISTS", BATCH_KEY, email]]))[0] === 0 && (await real([["ZSCORE", DUE_KEY, email]]))[0] === null && (await real([["HLEN", leads]]))[0] === 1), true);
  }
  part("Deletion not applied, unknown receipt");
  {
    const { email, leads } = await fresh("g2560delnil");
    let hit = 0;
    intercept = async (commands) => {
      if (commands.some((c) => c[0] === "DEL" && c.includes(leads))) { hit += 1; return [null]; }
      return null;
    };
    const report = await run();
    intercept = null;
    const kept = (await real([["HLEN", leads]]))[0];
    is("delete fault reached and original personal data retained", [hit, kept], [1, 1]);
    is("unknown unapplied delete never finishes the store or says erased", [report.finished, (await state(email)).erased !== undefined], [0, false]);
    console.log(JSON.stringify({ vector: "delete", report, kept, state: await state(email) }));
    // Healthy again: later runs delete what was left and only then say it erased.
    for (let i = 0; i < 6 && (await state(email)).erased === undefined; i += 1) {
      now += WALK_GAP_MS + 86_400_000;
      await run();
    }
    is("later healthy runs delete it and only then say erased", [(await real([["HLEN", leads]]))[0], (await state(email)).erased !== undefined], [0, true]);
  }
  part("Control: exact ordinary replies delete and finish");
  {
    const { email, leads } = await fresh("g2560control");
    const report = await run();
    is("normal closure removes contact and original record, then confirms erasure", [report.finished, (await state(email)).erased !== undefined, (await real([["HLEN", leads]]))[0], await storeForEmail(email)], [1, true, 0, null]);
  }
} finally {
  intercept = null;
  console.error = errorLog;
}
done();

}
main().catch((error) => { console.error(error); process.exit(1); });
