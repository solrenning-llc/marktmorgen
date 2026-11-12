/**
 * Revisor 1's LEVE on #2723: signAgreement saved the signature and the reply was lost, so the signer saw "error",
 * no copies went out, and the next try said "changed". Now the record is read back exactly after a save that did
 * not answer OK: only this very signature on this version counts as signed; a save that did not land, or a
 * read-back that does not read, stays "error".
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readDraft } from "@/lib/agreement-rules";
import { agreementOf, createAgreement, signAgreement } from "@/lib/agreement-store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { is, done } from "./check";

globalThis.fetch = (async () => { throw new Error("Unexpected external request"); }) as typeof fetch;
const pipeline = redis.pipeline.bind(redis);

async function main() {
  redis.clear();
  const owner = "l10b-sign@example.test", now = Date.now();
  await claimHandle(owner, "l10bsign", "Synthetic agreements", "");
  await ensureStatsId(owner); await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1AgrLagree001", true);
  await setSubscription(owner, { customerId: "cus_lagree", subscriptionId: "sub_lagree", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const draft = readDraft({ kind: "agreement", email: "client@example.test", name: "Synthetic client", title: "Coaching", body: "Twelve weekly coaching calls of forty-five minutes.", lines: [], consent: true }, "usd");
  if (!draft.ok) throw new Error("Fixture draft missing");

  const cases: [string, "applied" | "not applied" | "applied, read-back unreadable" | "applied, another signature read back", boolean][] = [
    ["the save landed and its reply was lost", "applied", true],
    ["the save did not land and its reply was lost", "not applied", false],
    ["the save landed and the read-back is in another shape", "applied, read-back unreadable", false],
    ["the save landed and the read-back carries another signature", "applied, another signature read back", false],
  ];
  for (const [name, mode, signed] of cases) {
    const made = await createAgreement(store, draft.draft, now);
    if (!made.ok) throw new Error(made.message);
    const a = made.agreement, key = `nl:agree:r:${a.id}`;
    let saved = false;
    redis.pipeline = async (commands) => {
      const command = commands[0];
      if (!saved && commands.length === 1 && command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:agreement-save:v1") && command[4] === key) {
        if (mode !== "not applied") await pipeline(commands);
        saved = true;
        return [];
      }
      if (saved && commands.length === 1 && command[0] === "GET" && command[1] === key) {
        const reply = await pipeline(commands);
        if (mode === "applied, read-back unreadable") return [{ not: "a string" }];
        if (mode === "applied, another signature read back") {
          const record = JSON.parse(String(reply[0]));
          record.versions[0].signature.name = "Someone else";
          return [JSON.stringify(record)];
        }
        return reply;
      }
      return pipeline(commands);
    };
    const result = await signAgreement(store, a.id, { n: 1, sha256: a.versions[0].sha256, name: "Dana Reyes", email: "client@example.test", consent: true, ip: "198.51.100.4" }, "Dana Reyes", now + 1);
    redis.pipeline = pipeline;
    is(`${name}: ${signed ? "signed, so the copies go out" : "error, never signed"}`, result.ok ? "signed" : result.reason, signed ? "signed" : "error");
    const after = (await agreementOf(store, a.id))!;
    is(`${name}: the stored record matches`, Boolean(after.versions[0].signature), mode !== "not applied");
  }
  done();
}
main().catch((error) => { redis.pipeline = pipeline; console.error(error); process.exitCode = 1; });
