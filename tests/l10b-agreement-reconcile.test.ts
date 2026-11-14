// Codex CX1's proof on #2723 (645c15b1, review 5795753027), kept as a permanent test with credit; assertions unchanged.
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { MAX_VERSIONS, readDraft } from "@/lib/agreement-rules";
import { agreementOf, createAgreement, readVersion, reviseAgreement } from "@/lib/agreement-store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { is, done } from "./check";

globalThis.fetch = (async () => { throw new Error("Unexpected external request"); }) as typeof fetch;
const pipeline = redis.pipeline.bind(redis);
type Row = Record<string, unknown>;

async function main() {
  redis.clear();
  const owner = "cx1-reconcile@example.test", now = Date.now();
  await claimHandle(owner, "cx1reread", "Synthetic agreements", "");
  await ensureStatsId(owner); await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1AgrLagree001", true);
  await setSubscription(owner, { customerId: "cus_lagree", subscriptionId: "sub_lagree", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const first = readDraft({ kind: "agreement", email: "client@example.test", name: "Synthetic client", title: "Coaching", body: "Twelve weekly coaching calls of forty-five minutes.", lines: [], consent: true }, "usd");
  if (!first.ok) throw new Error("Fixture draft missing");
  const cases: [string, ((record: Row) => Row) | null][] = [
    ["partial version", r => ({ ...r, versions: [(r.versions as Row[])[0], { n: 2 }] })],
    ["textual version number", r => ({ ...r, versions: [(r.versions as Row[])[0], { ...(r.versions as Row[])[1], n: "2" }] })],
    ["unreadable fingerprint", r => ({ ...r, versions: [(r.versions as Row[])[0], { ...(r.versions as Row[])[1], sha256: "bad" }] })],
    ["null version", r => ({ ...r, versions: [(r.versions as Row[])[0], null] })],
    ["oversized duplicate list", r => ({ ...r, versions: [...Array(MAX_VERSIONS).fill((r.versions as Row[])[0]), (r.versions as Row[])[1]] })],
    ["exact applied control", null],
    ["known unapplied control", null],
  ];
  for (const [name, corrupt] of cases) {
    const made = await createAgreement(store, first.draft, now);
    if (!made.ok) throw new Error(made.message);
    const a = made.agreement, key = `nl:agree:r:${a.id}`, versionKey = `nl:agree:v:${a.id}:2`;
    const edit = readDraft({ title: "Updated coaching", body: "Fourteen weekly coaching calls of forty-five minutes.", lines: [] }, "usd", a);
    if (!edit.ok) throw new Error("Fixture edit missing");
    let saved = false, hit = 0;
    redis.pipeline = async commands => {
      const command = commands[0];
      if (!saved && commands.length === 1 && command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:agreement-save:v1") && command[4] === key) {
        if (name !== "known unapplied control") await pipeline(commands);
        saved = true;
        return []; // The record may have been saved; the receipt was lost.
      }
      if (saved && !hit && commands.length === 1 && command[0] === "GET" && command[1] === key) {
        hit++;
        const reply = await pipeline(commands);
        return corrupt ? [JSON.stringify(corrupt(JSON.parse(String(reply[0]))))] : reply;
      }
      return pipeline(commands);
    };
    await reviseAgreement(store, a.id, edit.draft, now + 1);
    redis.pipeline = pipeline;
    const record = (await agreementOf(store, a.id))!;
    const text = await readVersion(record, 2);
    const exists = (await pipeline([["EXISTS", versionKey]]))[0] === 1;
    const expected = name === "known unapplied control" ? [1, 1, false, false] : [1, 2, true, true];
    is(`${name}: an unknown reread cannot remove a named version`, [hit, record.versions.length, exists, text !== null], expected);
  }
  done();
}
main().catch(error => { redis.pipeline = pipeline; console.error(error); process.exitCode = 1; });
