/**
 * CX-123 rule 24, lot L10b: a new version of an agreement (lib/agreement-store.ts reviseAgreement) writes its exact text
 * once, with SET NX, before the record names it. A reply to that SET in any shape but "OK" or nil is read back: the key
 * holding this version's own text is ours and the record names it; another text is never named by the record (its
 * fingerprint would not be the text kept); nothing readable is "unavailable", and a text this run may have written is
 * let go only while it is still this run's own, so the creator's next try can write that version.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { type AgreementDraft, readDraft } from "@/lib/agreement-rules";
import { agreementOf, createAgreement, reviseAgreement } from "@/lib/agreement-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ODD, THROWS, UNREADABLE, answer, clearAnswers, getOf, setNx } from "./l10b-replies";

const OWNER = "l10b-agreements@example.com";
const BODY = "Twelve weekly coaching calls of 45 minutes.\n\nEither of us may end it with a week's notice.";

async function main(): Promise<void> {
  redis.clear();
  const now = Date.now();
  await claimHandle(OWNER, "lagree", "Mara's Coaching", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1AgrLagree001", true);
  await setSubscription(OWNER, { customerId: "cus_lagree", subscriptionId: "sub_lagree", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const first = readDraft({ kind: "agreement", email: "client@example.com", name: "Dana Reyes", title: "Coaching", body: BODY, lines: [], consent: true }, "usd");
  if (!first.ok) throw new Error("no draft");
  let made = 0;
  const fresh = async () => {
    const created = await createAgreement(store, { ...first.draft, email: `client${(made += 1)}@example.com` }, now);
    if (!created.ok) throw new Error(created.message);
    return created.agreement;
  };
  const edit = (a: { id: string }, title: string) => {
    const r = readDraft({ title, body: `${BODY}\n\n${title}.`, lines: [] }, "usd", a as never);
    if (!r.ok) throw new Error("no edit");
    return r.draft as AgreementDraft;
  };
  const V2 = (id: string) => `nl:agree:v:${id}:2`;
  const kept = (id: string) => {
    const raw = redis.run(["GET", V2(id)]);
    return typeof raw === "string" ? (JSON.parse(raw) as { sha256: string }).sha256 : null;
  };

  part("The plain case: version 2 written once and named by the record");
  const plain = await fresh();
  const revised = await reviseAgreement(store, plain.id, edit(plain, "Four months"), now + 1);
  is("version 2, its text the one named", revised.ok && [revised.version.n, kept(plain.id) === revised.version.sha256], [2, true]);

  part("Another text already under the version's key is never named by the record");
  for (const [shape, reply] of ODD) {
    clearAnswers();
    const a = await fresh();
    const other = JSON.stringify({ n: 2, sha256: "f".repeat(64), text: "Another text." });
    answer(setNx(V2(a.id)), reply, { before: () => void redis.run(["SET", V2(a.id), other, "EX", 3_600]) });
    const got = await reviseAgreement(store, a.id, edit(a, "Five months"), now + 1);
    const after = await agreementOf(store, a.id);
    is(`the text answered with ${shape} while another is there: unavailable, the record still at version 1, the other text untouched`, [got.ok, after?.versions.length, redis.run(["GET", V2(a.id)])], [false, 1, other]);
  }

  part("The text written and its answer lost: our own text read back, named once");
  for (const [shape, reply] of ODD) {
    clearAnswers();
    const a = await fresh();
    answer(setNx(V2(a.id)), reply);
    const got = await reviseAgreement(store, a.id, edit(a, "Six months"), now + 1);
    is(`answered with ${shape}, the write landed: version 2, its text the one named`, got.ok && [(await agreementOf(store, a.id))?.versions.length, kept(a.id) === got.version.sha256], [2, true]);
  }

  part("Nothing readable: unavailable, and a text of this run's let go so the next try writes it");
  for (const [shape, reply] of [...UNREADABLE, ["the write failing too", THROWS] as const]) {
    clearAnswers();
    const a = await fresh();
    answer(setNx(V2(a.id)), shape === "the write failing too" ? THROWS : () => ["QUEUED"]);
    answer(getOf(V2(a.id)), reply);
    const got = await reviseAgreement(store, a.id, edit(a, "Seven months"), now + 1);
    const after = await agreementOf(store, a.id);
    is(`the text unknown and its read-back ${shape}: unavailable, the record still at version 1, no text left behind`, [got.ok, after?.versions.length, redis.run(["EXISTS", V2(a.id)])], [false, 1, 0]);
    clearAnswers();
    const again = await reviseAgreement(store, a.id, edit(a, "Seven months"), now + 2);
    is(`and the next try writes version 2 (${shape})`, again.ok && [again.version.n, kept(a.id) === again.version.sha256], [2, true]);
  }

  part("Claude 3 on #2723: the record not saved after the text was written: unavailable, and the text let go so the next try writes it");
  for (const [shape, reply] of [["the save failing", THROWS], ["the save answered QUEUED", () => ["QUEUED"]]] as const) {
    clearAnswers();
    const a = await fresh();
    answer((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:agreement-save:v1") && String(c[4]) === `nl:agree:r:${a.id}`, reply, { run: false });
    const got = await reviseAgreement(store, a.id, edit(a, "Eight months"), now + 1);
    is(`${shape}: unavailable, the record at version 1, no text left behind`, [got.ok, (await agreementOf(store, a.id))?.versions.length, redis.run(["EXISTS", V2(a.id)])], [false, 1, 0]);
    clearAnswers();
    const again = await reviseAgreement(store, a.id, edit(a, "Eight months"), now + 2);
    is(`and the next try writes version 2 (${shape})`, again.ok && [again.version.n, kept(a.id) === again.version.sha256], [2, true]);
  }
  clearAnswers();
  done();
}

void main();
