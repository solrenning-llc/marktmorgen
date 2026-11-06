import { createHash } from "node:crypto";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { finishClosed } from "@/lib/plan-closing";
import { BATCH_KEY, DUE_KEY, WALK_GAP_MS, eraseClosed, markDue } from "@/lib/closed-store-data";

type Command = (string | number)[];
const real = redis.pipeline;
let intercept: ((commands: Command[]) => Promise<unknown[] | null>) | null = null;
redis.pipeline = async (commands: Command[]) => (await intercept?.(commands)) ?? real(commands);
let now = Date.UTC(2026, 10, 6);
const run = () => eraseClosed(Date.now() + 20_000, finishClosed, now);
const ownerKey = (ref: string) => `nl:store:owner:${createHash("sha256").update(`nimbus-store:${ref}`).digest("hex").slice(0, 40)}`;
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
  }
  part("Control: exact ordinary replies delete and finish");
  {
    const { email, leads } = await fresh("g2560control");
    const report = await run();
    is("normal closure removes contact and original record, then confirms erasure", [report.finished, (await state(email)).erased !== undefined, (await real([["HLEN", leads]]))[0], await storeForEmail(email)], [1, true, 0, null]);
  }
  part("Reopened store between guard read and key deletion");
  {
    const { email } = await fresh("g2560raceold");
    const pauseKey = `nl:pause:${email}`;
    const orderCountKey = `nl:orders:n:${await storeFolder(email)}:2026-11`;
    await real([["SET", pauseKey, "old"], ["SET", orderCountKey, "0"]]);
    let captured = 0;
    let newSid = "";
    intercept = async (commands) => {
      if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === ownerKey(email)) {
        const reply = await real(commands);
        if (reply[0] === null && !captured) {
          captured += 1;
          // This absent read is either pre-walk recordGone or the guard itself.
          // Open only at the guard: recordGone runs before phase becomes walk.
          const phase = (await real([["HGET", "nl:closed:walk", "phase"]]))[0];
          if (phase !== "walk") { captured = 0; return reply; }
          const old = intercept;
          intercept = null;
          await claimHandle(email, "g2560racenew", "New store", "");
          newSid = (await storeForEmail(email))!.sid;
          await real([["SET", pauseKey, "new-store-pause"], ["SET", orderCountKey, "5"]]);
          intercept = old;
        }
        return reply;
      }
      return null;
    };
    const report = await run();
    intercept = null;
    const current = (await storeForEmail(email))!;
    is("guard barrier reached, actual newly opened store still owns this key", [captured, current.handle, current.sid === newSid, storeRef(current)], [1, "g2560racenew", true, email]);
    is("old walk preserves the newly opened store's key after its stale absent read", (await real([["GET", pauseKey]]))[0], "new-store-pause");
    is("old walk also preserves the new store's valid monthly order counter under the same folder", (await real([["GET", orderCountKey]]))[0], "5");
    console.log(JSON.stringify({ vector: "race", report, captured, current: current.sid, pause: (await real([["GET", pauseKey]]))[0] }));
  }
} finally {
  intercept = null;
  console.error = errorLog;
}
done();

}
main().catch((error) => { console.error(error); process.exit(1); });
