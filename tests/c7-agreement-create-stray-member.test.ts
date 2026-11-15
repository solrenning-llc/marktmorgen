/**
 * Issue #4804, second review (Claude 7 from 51LL): a member of a person's agreement index that is not an agreement id
 * names no record (the index is only written with a record's own id), and the erasure and agreementsOfPerson pass over
 * it. createAgreement answered "unavailable" for such a member, so it stopped every new agreement for that person for
 * good. Now it is taken out of the index, with the records gone, and the agreement is made; it is not counted against
 * the person's own count either. A member that is not text at all still answers "unavailable" (rule 24).
 * Synthetic store and people, in-memory Redis.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { type AgreementDraft, readDraft } from "@/lib/agreement-rules";
import { createAgreement } from "@/lib/agreement-store";
import { personKey } from "@/lib/person-key";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function paidStore(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, "Synthetic Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1Str${handle.slice(0, 8).padEnd(8, "x")}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

const draftFor = (email: string): AgreementDraft => {
  const read = readDraft({ kind: "agreement", email, name: "Synthetic Signer", title: "Synthetic sessions", body: "Three synthetic sessions.", lines: [{ text: "Session", quantity: 3, amount: "10" }], consent: true }, "usd");
  if (!read.ok) throw new Error("synthetic draft refused");
  return read.draft;
};

async function main(): Promise<void> {
  redis.clear();
  const store = await paidStore("synthetic-stray@example.com", "straymember");
  const email = "signer-stray@example.com";
  const person = `nl:agree:p:${store.sid}:${personKey(store.sid, email)}`;

  part("a stray member in the person's index");
  redis.run(["SADD", person, "bad"]);
  const made = await createAgreement(store, draftFor(email));
  is("the agreement is made, never \"unavailable\"", made.ok, true);
  const members = (redis.run(["SMEMBERS", person]) as string[]).sort();
  is("the stray member is taken out; the new agreement is listed", members, made.ok ? [made.agreement.id] : []);

  part("a member that is not text at all: unknown, refused");
  const original: typeof redis.pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch) => (batch[0][0] === "SMEMBERS" ? [["bad", 7]] : original(batch))) as typeof redis.pipeline;
  let refused: unknown;
  try {
    refused = await createAgreement(store, draftFor("signer-other@example.com"));
  } finally {
    redis.pipeline = original;
  }
  is("answers unavailable", (refused as { ok: boolean; reason?: string }).reason, "unavailable");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
