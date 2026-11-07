/**
 * Codex G's review of #2560, MEDIUM 2 (race), kept with credit from its proof
 * (codex/g-review-2560-exact-claims, tests/g2560-write-race.proof.ts): the walk read once a run that no
 * living store holds a closed store's key, and deleted what that key alone names later. A store its
 * owner opens again under the same key between that read and the delete keeps everything its key names:
 * the delete itself checks, in one step, that the key's record is still absent. Controls: with no store
 * opened again, the closed store's pause and counter go.
 */
import { createHash } from "node:crypto";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { finishClosed } from "@/lib/plan-closing";
import { eraseClosed, markDue } from "@/lib/closed-store-data";

type Command = (string | number)[];
const real = redis.pipeline;
let intercept: ((commands: Command[]) => Promise<unknown[] | null>) | null = null;
redis.pipeline = async (commands: Command[]) => (await intercept?.(commands)) ?? real(commands);
const now = Date.UTC(2026, 10, 6);
const run = () => eraseClosed(Date.now() + 20_000, finishClosed, now);
const ownerKey = (ref: string) => `nl:store:owner:${createHash("sha256").update(`nimbus-store:${ref}`).digest("hex").slice(0, 40)}`;
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
async function main(): Promise<void> {
const errorLog = console.error;
console.error = () => {};
try {
  part("Control: no store opened again, what the key named goes");
  {
    const { email } = await fresh("g2560racectl");
    const pauseKey = `nl:pause:${email}`;
    const orderCountKey = `nl:orders:n:${await storeFolder(email)}:2026-11`;
    await real([["SET", pauseKey, "old"], ["SET", orderCountKey, "0"]]);
    const report = await run();
    is("finished, and the closed store's pause and counter deleted", [report.finished, (await real([["GET", pauseKey]]))[0], (await real([["GET", orderCountKey]]))[0]], [1, null, null]);
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
