import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDisputeEvidenceDraft, DISPUTE_TEXT_FIELD_CHARACTERS, DISPUTE_EVIDENCE_TOTAL_CHARACTERS,
  type DisputeEvidenceFacts,
} from "@/lib/dispute-evidence-fields";
import type { DisputeEvidenceKind, RetainedPurchaseEvidence } from "@/lib/dispute-evidence-rules";

// Synthetic facts only: no real buyer, account, dispute or Stripe call.
const scope = { account: "acct_fixture", store: "synthetic-store", purchase: "cs_fixture", buyer: "buyer-fixture" };
const now = 1_800_000_000;
function rec(kind: DisputeEvidenceKind, patch: Partial<RetainedPurchaseEvidence> = {}): RetainedPurchaseEvidence {
  return { ...scope, kind, source: kind + ":fixture", recordedAt: now - 86_400, retainedUntil: now + 86_400, text: "Synthetic " + kind + " text", ...patch };
}
const known = <T,>(value: T) => ({ state: "known" as const, value });
const none = { state: "none" as const };
const unknown = { state: "unknown" as const };
function facts(patch: Partial<DisputeEvidenceFacts> = {}): DisputeEvidenceFacts {
  return {
    scope, now, dispute: "du_fixture",
    status: known("needs_response"), reason: known("product_not_received"),
    dueBy: known(now + 3_600), pastDue: known(false),
    buyerEmail: known("buyer@example.test"), productDescription: known("Synthetic guide (PDF)"),
    delivery: known(["download"] as const),
    records: {
      receipt: known([rec("receipt")]), confirmation: none, accepted_terms: known([rec("accepted_terms")]),
      accepted_refund_policy: known([rec("accepted_refund_policy")]), message: none,
      download: known([rec("download")]),
    },
    ...patch,
  };
}

test("known facts fill only Stripe's text fields, from the original record text, and may be offered", () => {
  const draft = buildDisputeEvidenceDraft(facts());
  assert.equal(draft.maySend, true);
  assert.equal(draft.submitted, false);
  assert.deepEqual(draft.blockers, []);
  assert.equal(draft.evidence.customer_email_address, "buyer@example.test");
  assert.equal(draft.evidence.product_description, "Synthetic guide (PDF)");
  assert.match(draft.evidence.access_activity_log!, /Synthetic download text/);
  assert.match(draft.evidence.refund_policy_disclosure!, /Synthetic accepted_refund_policy text/);
  assert.match(draft.evidence.uncategorized_text!, /Synthetic receipt text[\s\S]*Synthetic accepted_terms text|Synthetic accepted_terms text[\s\S]*Synthetic receipt text/);
  // File fields need an upload in a later unit; this rule never names a file it does not have.
  for (const field of ["receipt", "refund_policy", "customer_communication", "service_documentation"]) {
    assert.equal(field in draft.evidence, false);
  }
  assert.deepEqual(draft.fileCandidates.map(c => c.field).sort(), ["receipt", "refund_policy"]);
  assert.deepEqual(draft.none.sort(), ["confirmation", "message"]);
  assert.deepEqual(draft.unknown, []);
});

test("no invented text: every evidence line is a fixed label, a timestamp and the record's own words", () => {
  const draft = buildDisputeEvidenceDraft(facts());
  const allowed = /^(Receipt record|Order confirmation email record|File download record|Course progress record|Call attendance record|Community access record|Membership access record|Accepted terms record|Accepted refund policy record|Store inbox message), \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z: Synthetic [a-z_]+ text$/;
  for (const field of ["access_activity_log", "refund_policy_disclosure", "uncategorized_text"] as const) {
    for (const line of draft.evidence[field]!.split("\n\n")) assert.match(line, allowed);
  }
  // Nothing about the buyer beyond the email, no internal identifiers.
  const all = Object.values(draft.evidence).join("\n");
  for (const secret of ["buyer-fixture", "acct_fixture", "synthetic-store", "cs_fixture", ":fixture"]) assert.equal(all.includes(secret), false, secret);
});

test("'none' is said, not filled: an absent fact never becomes text", () => {
  const draft = buildDisputeEvidenceDraft(facts({ buyerEmail: none, productDescription: none }));
  assert.equal("customer_email_address" in draft.evidence, false);
  assert.equal("product_description" in draft.evidence, false);
  assert.ok(draft.none.includes("buyerEmail"));
  assert.ok(draft.none.includes("productDescription"));
  assert.equal(draft.maySend, true);
});

test("every unknown fact is listed and closes the send", () => {
  const cases: [Partial<DisputeEvidenceFacts>, string][] = [
    [{ status: unknown }, "status"], [{ reason: unknown }, "reason"], [{ dueBy: unknown }, "dueBy"],
    [{ pastDue: unknown }, "pastDue"], [{ buyerEmail: unknown }, "buyerEmail"],
    [{ productDescription: unknown }, "productDescription"], [{ delivery: unknown }, "delivery"],
  ];
  for (const [patch, name] of cases) {
    const draft = buildDisputeEvidenceDraft(facts(patch));
    assert.equal(draft.maySend, false, name);
    assert.ok(draft.unknown.includes(name), name);
    assert.ok(draft.blockers.includes(`unknown:${name}`), name);
  }
  for (const kind of ["receipt", "confirmation", "accepted_terms", "accepted_refund_policy", "message", "download"] as const) {
    const base = facts();
    const draft = buildDisputeEvidenceDraft({ ...base, records: { ...base.records, [kind]: unknown } });
    assert.equal(draft.maySend, false, kind);
    assert.ok(draft.unknown.includes(kind), kind);
  }
});

test("an applicable record kind that was never read is unknown, never 'none'", () => {
  const base = facts({ delivery: known(["download", "course"] as const) });
  const draft = buildDisputeEvidenceDraft(base);
  assert.ok(draft.unknown.includes("course"));
  assert.equal(draft.none.includes("course"), false);
  assert.equal(draft.maySend, false);
  const rest = { ...facts().records };
  delete rest.message;
  const missingUniversal = buildDisputeEvidenceDraft(facts({ records: rest }));
  assert.ok(missingUniversal.unknown.includes("message"));
  assert.equal(missingUniversal.maySend, false);
});

test("a kind that does not apply to the product is not required", () => {
  const draft = buildDisputeEvidenceDraft(facts());
  for (const kind of ["course", "call", "community", "membership"]) {
    assert.equal(draft.unknown.includes(kind), false, kind);
    assert.equal(draft.none.includes(kind), false, kind);
  }
});

test("the dispute must be open, answerable and inside its real deadline", () => {
  for (const status of ["under_review", "won", "lost", "appeal_needs_response", "made_up"]) {
    const draft = buildDisputeEvidenceDraft(facts({ status: known(status) }));
    assert.equal(draft.maySend, false, status);
    assert.ok(draft.blockers.includes("status_not_answerable"), status);
  }
  assert.equal(buildDisputeEvidenceDraft(facts({ status: known("warning_needs_response") })).maySend, true);
  const late = buildDisputeEvidenceDraft(facts({ dueBy: known(now) }));
  assert.equal(late.maySend, false);
  assert.ok(late.blockers.includes("deadline_passed"));
  assert.equal(buildDisputeEvidenceDraft(facts({ dueBy: known(now + 1) })).maySend, true);
  assert.ok(buildDisputeEvidenceDraft(facts({ pastDue: known(true) })).blockers.includes("past_due"));
  for (const missing of [{ status: none }, { reason: none }, { dueBy: none }, { pastDue: none }]) {
    assert.equal(buildDisputeEvidenceDraft(facts(missing)).maySend, false, JSON.stringify(missing));
  }
});

test("nothing to send closes the send instead of sending an empty package", () => {
  const draft = buildDisputeEvidenceDraft(facts({
    buyerEmail: none, productDescription: none, delivery: none,
    records: { receipt: none, confirmation: none, accepted_terms: none, accepted_refund_policy: none, message: none },
  }));
  assert.deepEqual(draft.evidence, {});
  assert.equal(draft.maySend, false);
  assert.ok(draft.blockers.includes("nothing_to_send"));
});

test("a field over Stripe's per-field cap is reported whole, never truncated", () => {
  assert.equal(DISPUTE_TEXT_FIELD_CHARACTERS, 20_000);
  assert.equal(DISPUTE_EVIDENCE_TOTAL_CHARACTERS, 150_000);
  const big = (i: number) => rec("download", { source: "download:" + i, text: "x".repeat(9_000) });
  const draft = buildDisputeEvidenceDraft(facts({ records: { ...facts().records, download: known([big(1), big(2), big(3)]) } }));
  assert.equal(draft.maySend, false);
  assert.ok(draft.blockers.includes("too_long:access_activity_log"));
  assert.equal("access_activity_log" in draft.evidence, false);
  const fits = buildDisputeEvidenceDraft(facts({ records: { ...facts().records, download: known([big(1), big(2)]) } }));
  assert.equal(fits.maySend, true);
  assert.ok(fits.evidence.access_activity_log!.length <= DISPUTE_TEXT_FIELD_CHARACTERS);
  const longDescription = buildDisputeEvidenceDraft(facts({ productDescription: known("y".repeat(20_001)) }));
  assert.ok(longDescription.blockers.includes("too_long:product_description"));
  assert.equal(buildDisputeEvidenceDraft(facts({ productDescription: known("y".repeat(20_000)) })).maySend, true);
});

test("another buyer's record, malformed reads and contradictory reads are refused whole", () => {
  const other = { ...facts().records, download: known([rec("download", { buyer: "other-buyer" })]) };
  assert.throws(() => buildDisputeEvidenceDraft(facts({ records: other })), /^Error: Evidence packet unavailable$/);
  const wrongKind = { ...facts().records, download: known([rec("course")]) };
  assert.throws(() => buildDisputeEvidenceDraft(facts({ records: wrongKind })), /^Error: Evidence packet unavailable$/);
  assert.throws(() => buildDisputeEvidenceDraft(facts({ records: { ...facts().records, download: known([]) } })), /^Error: Evidence packet unavailable$/);
  for (const patch of [
    { dispute: "ch_fixture" }, { buyerEmail: known("not an email") }, { productDescription: known("  ") },
    { delivery: known(["shipping"] as never) }, { dueBy: known(1.5) }, { now: NaN },
    { status: { state: "maybe" } as never }, { reason: known("Has Spaces") },
  ] as Partial<DisputeEvidenceFacts>[]) {
    assert.throws(() => buildDisputeEvidenceDraft(facts(patch)), /^Error: Evidence packet unavailable$/, JSON.stringify(patch));
  }
});

test("an expired record is not evidence: its kind reads as none, retention is not extended", () => {
  const expired = { ...facts().records, download: known([rec("download", { retainedUntil: now })]) };
  const draft = buildDisputeEvidenceDraft(facts({ records: expired }));
  assert.ok(draft.none.includes("download"));
  assert.equal("access_activity_log" in draft.evidence, false);
});

test("inbox messages and call records go to text and are marked as file candidates", () => {
  const draft = buildDisputeEvidenceDraft(facts({
    delivery: known(["call"] as const),
    records: { ...facts().records, download: none, call: known([rec("call")]), message: known([rec("message")]) },
  }));
  assert.match(draft.evidence.uncategorized_text!, /^Store inbox message, |\n\nStore inbox message, /);
  assert.match(draft.evidence.access_activity_log!, /Call attendance record/);
  const fields = draft.fileCandidates.map(c => c.field);
  assert.ok(fields.includes("customer_communication"));
  assert.ok(fields.includes("service_documentation"));
});
