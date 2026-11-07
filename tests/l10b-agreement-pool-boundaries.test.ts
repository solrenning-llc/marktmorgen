/** Codex CX1 on #2723 (commit 23272e62): a version text is never let go under a record that names it, and a free-pool reread must be one exact reply. Kept as a permanent test of lot L10b. */
import { createHash } from "node:crypto";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readDraft } from "@/lib/agreement-rules";
import { agreementOf, createAgreement, readVersion, reviseAgreement } from "@/lib/agreement-store";
import { poolPlace, admitNonPaying } from "@/lib/free-pool";
import { FREE_POOL_BASE_STORES } from "@/lib/free-pool-rules";
import { calendarWindow } from "@/lib/allowance-window";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { is, done } from "./check";

globalThis.fetch = (async () => { throw new Error("Unexpected external request"); }) as typeof fetch;
const pipeline = redis.pipeline.bind(redis);

async function main() {
  redis.clear();
  const now = Date.now();
  const owner = "cx1-agreements@example.test";
  await claimHandle(owner, "cx1agree", "Synthetic agreements", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1AgrLagree001", true);
  await setSubscription(owner, { customerId: "cus_lagree", subscriptionId: "sub_lagree", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const first = readDraft({ kind: "agreement", email: "client@example.test", name: "Synthetic client", title: "Coaching", body: "Twelve weekly coaching calls of forty-five minutes.", lines: [], consent: true }, "usd");
  if (!first.ok) throw new Error("Fixture draft missing");
  for (const mode of ["applied-throw", "applied-empty", "applied-queued", "not-applied-control", "success-control"]) {
    const created = await createAgreement(store, first.draft, now);
    if (!created.ok) throw new Error(created.message);
    const a = created.agreement;
    const edit = readDraft({ title: "Updated coaching", body: "Fourteen weekly coaching calls of forty-five minutes.", lines: [] }, "usd", a);
    if (!edit.ok) throw new Error("Fixture revision missing");
    let hit = 0;
    redis.pipeline = async commands => {
      if (mode !== "success-control" && !hit && commands.length === 1 && commands[0][0] === "SET" && commands[0][1] === `nl:agree:r:${a.id}` && !commands[0].includes("NX")) {
        hit++;
        if (mode !== "not-applied-control") await pipeline(commands);
        if (mode.endsWith("throw") || mode === "not-applied-control") throw new Error("Synthetic uncertain agreement save");
        return mode === "applied-empty" ? [] : ["QUEUED"];
      }
      return pipeline(commands);
    };
    const changed = await reviseAgreement(store, a.id, edit.draft, now + 1);
    redis.pipeline = pipeline;
    const record = (await agreementOf(store, a.id))!;
    const text = await readVersion(record, 2);
    if (mode === "not-applied-control") is("agreement unapplied failure control keeps record at v1", [changed.ok, record.versions.length, text], [false, 1, null]);
    else if (mode === "success-control") is("agreement successful save control keeps named text", [changed.ok, record.versions.length, text !== null], [true, 2, true]);
    else is(`agreement ${mode}: every version the persisted record names keeps its text`, [hit, record.versions.length, text !== null], [1, 2, true]);
  }

  const free = { sid: "cx1free".padEnd(32, "f"), handle: "cx1free", statsId: null, tier: "creator" as const, subscriptionActive: false, subscriptionId: null, trialEnds: 0, planEndedAt: "" };
  const month = calendarWindow(now).id;
  const hash = createHash("sha256").update(`free-pool:${free.sid}`).digest("hex").slice(0, 32);
  const key = `nl:free:in:${month}:${hash}`;
  const count = `nl:free:n:${month}`;
  for (const [name, reply] of [["extra positive slot", ["1", null]], ["contradictory extra slot", ["1", "0"]], ["extra refusal slot", ["0", null]], ["exact refusal control", ["0"]]] as const) {
    for (const caller of ["poolPlace", "admitNonPaying"]) {
      redis.clear();
      await pipeline([["SET", count, FREE_POOL_BASE_STORES]]);
      let taken = false;
      redis.pipeline = async commands => {
        const command = commands[0];
        if (commands.length === 1 && command[0] === "SET" && command[1] === key && command.includes("NX")) {
          await pipeline([["SET", key, "0", "EX", 3600]]); // A concurrent request refused the store.
          taken = true;
          return [null];
        }
        if (taken && commands.length === 1 && command[0] === "GET" && command[1] === key) return [...reply];
        return pipeline(commands);
      };
      const value = caller === "poolPlace" ? await poolPlace(free, now) : await admitNonPaying(free, now);
      redis.pipeline = pipeline;
      const expected = caller === "poolPlace" ? name === "exact refusal control" ? "full" : "unknown" : false;
      is(`${caller} ${name}: full pool never authorizes from an unknown reread`, [value, (await pipeline([["GET", key]]))[0], Number((await pipeline([["GET", count]]))[0])], [expected, "0", FREE_POOL_BASE_STORES]);
    }
  }
  redis.clear();
  await pipeline([["SET", count, FREE_POOL_BASE_STORES - 1]]);
  is("known funded last place control remains available", [await poolPlace(free, now), (await pipeline([["GET", key]]))[0]], ["in", "1"]);
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
