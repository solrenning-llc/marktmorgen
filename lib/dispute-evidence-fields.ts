/**
 * DE1 (queue item 492), unit 1: shape already-read facts of one disputed
 * purchase into Stripe's dispute `evidence` text fields, for the creator to
 * review. Pure: no network, storage, AI, email or submission. Nothing here
 * sends anything; `submitted` is always false and `maySend` only says the
 * creator may be OFFERED the send button in a later unit, never that a send
 * happens on its own.
 *
 * Each fact arrives as it was read: `known` with its value, `none` (the read
 * succeeded and nothing exists) or `unknown` (the read failed, was not done,
 * or its answer was not in shape). Unknown is never success, zero or empty:
 * it is listed and closes the send. `none` is listed and never becomes text.
 *
 * Records are validated by `buildDisputeEvidencePacket`
 * (lib/dispute-evidence-rules.ts): same account, store, purchase and buyer,
 * inside retention, bounded, never truncated. This module adds only the field
 * mapping, the tri-state reads, Stripe's text caps and the send conditions.
 *
 * Field names and caps: Stripe API reference "Update a dispute"
 * (docs.stripe.com/api/disputes/update), as read on 10 Nov 2026 and recorded
 * in docs/gd1-stripe-evidence-sources-2026-11-10.md (150,000 characters
 * combined; 20,000 for access_activity_log, product_description and
 * refund_policy_disclosure). docs.stripe.com could not be reached from this
 * session on 15 Nov 2026; `customer_email_address` and the 20,000 cap on
 * uncategorized_text are not in that record and stay open in
 * docs/dispute-evidence.md until re-read before the send unit.
 */
import {
  buildDisputeEvidencePacket, DISPUTE_EVIDENCE_KINDS,
  type DisputeEvidenceKind, type PurchaseEvidenceScope, type RetainedPurchaseEvidence,
} from "@/lib/dispute-evidence-rules";

export type FactRead<T> = { state: "known"; value: T } | { state: "none" } | { state: "unknown" };

/** How the product is delivered; decides which records must have been read. */
export const DELIVERY_KINDS = ["download", "course", "call", "community", "membership"] as const;
export type DeliveryKind = typeof DELIVERY_KINDS[number];
/** Read for every purchase, whatever the product. */
export const UNIVERSAL_KINDS = ["receipt", "confirmation", "accepted_terms", "accepted_refund_policy", "message"] as const;

/** Stripe statuses at which evidence is still answered (lib/dispute-statuses.ts lists them all). */
export const ANSWERABLE_STATUSES: ReadonlySet<string> = new Set(["needs_response", "warning_needs_response"]);

export const DISPUTE_TEXT_FIELD_CHARACTERS = 20_000;
export const DISPUTE_EVIDENCE_TOTAL_CHARACTERS = 150_000;

export type StripeTextField =
  | "customer_email_address" | "product_description" | "access_activity_log"
  | "refund_policy_disclosure" | "uncategorized_text";
/** File fields need an upload (purpose dispute_evidence) in a later unit, with its own cost and reservation. */
export type StripeFileField = "receipt" | "refund_policy" | "customer_communication" | "service_documentation";

const TEXT_FIELD_OF: Record<DisputeEvidenceKind, "access_activity_log" | "refund_policy_disclosure" | "uncategorized_text"> = {
  receipt: "uncategorized_text", confirmation: "uncategorized_text", accepted_terms: "uncategorized_text", message: "uncategorized_text",
  accepted_refund_policy: "refund_policy_disclosure",
  download: "access_activity_log", course: "access_activity_log", call: "access_activity_log",
  community: "access_activity_log", membership: "access_activity_log",
};
const FILE_FIELD_OF: Partial<Record<DisputeEvidenceKind, StripeFileField>> = {
  receipt: "receipt", accepted_refund_policy: "refund_policy", message: "customer_communication", call: "service_documentation",
};
/** Fixed labels drawn by the code. They name the kind of record, never what it proves. */
const LABEL: Record<DisputeEvidenceKind, string> = {
  receipt: "Receipt record", confirmation: "Order confirmation email record",
  download: "File download record", course: "Course progress record", call: "Call attendance record",
  community: "Community access record", membership: "Membership access record",
  accepted_terms: "Accepted terms record", accepted_refund_policy: "Accepted refund policy record",
  message: "Store inbox message",
};

export type DisputeEvidenceFacts = {
  scope: PurchaseEvidenceScope;
  /** Unix seconds, the same clock as records and the deadline. */
  now: number;
  dispute: string;
  status: FactRead<string>;
  reason: FactRead<string>;
  /** evidence_details.due_by, Unix seconds. */
  dueBy: FactRead<number>;
  pastDue: FactRead<boolean>;
  buyerEmail: FactRead<string>;
  productDescription: FactRead<string>;
  delivery: FactRead<readonly DeliveryKind[]>;
  /** A kind that applies and is absent here was never read: unknown. */
  records: Partial<Record<DisputeEvidenceKind, FactRead<readonly RetainedPurchaseEvidence[]>>>;
};

export type DisputeEvidenceBlocker =
  | `unknown:${string}` | `too_long:${StripeTextField}`
  | "status_not_answerable" | "reason_missing" | "deadline_missing" | "deadline_passed"
  | "past_due" | "nothing_to_send" | "too_long:total";

export type DisputeEvidenceDraft = {
  dispute: string;
  /** Only text fields with an existing fact; never a placeholder. */
  evidence: Partial<Record<StripeTextField, string>>;
  /** Fields that need a file upload; the text above already carries the same records. */
  fileCandidates: { field: StripeFileField; kinds: DisputeEvidenceKind[] }[];
  /** Read and found absent: said on the screen, never filled. */
  none: string[];
  /** Not read or not readable: said on the screen and closes the send. */
  unknown: string[];
  blockers: DisputeEvidenceBlocker[];
  maySend: boolean;
  submitted: false;
};

function fail(): never { throw new Error("Evidence packet unavailable"); }
function isRead(value: unknown): value is FactRead<unknown> {
  if (!value || typeof value !== "object") return false;
  const state = (value as { state?: unknown }).state;
  return state === "none" || state === "unknown" || (state === "known" && "value" in value);
}
function iso(seconds: number): string { return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"); }
function whole(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

/** Throws "Evidence packet unavailable" on malformed input, without echoing any of it. */
export function buildDisputeEvidenceDraft(facts: DisputeEvidenceFacts): DisputeEvidenceDraft {
  if (!facts || !whole(facts.now) || typeof facts.dispute !== "string" || !/^du_[A-Za-z0-9]{1,128}$/.test(facts.dispute)) fail();
  const none: string[] = [];
  const unknown: string[] = [];
  const blockers: DisputeEvidenceBlocker[] = [];
  const evidence: DisputeEvidenceDraft["evidence"] = {};

  // Scalar facts: validate the shape of every known value before using any.
  const scalars = { status: facts.status, reason: facts.reason, dueBy: facts.dueBy, pastDue: facts.pastDue,
    buyerEmail: facts.buyerEmail, productDescription: facts.productDescription, delivery: facts.delivery };
  for (const [name, read] of Object.entries(scalars)) {
    if (!isRead(read)) fail();
    if (read.state === "none") none.push(name);
    if (read.state === "unknown") { unknown.push(name); blockers.push(`unknown:${name}`); }
  }
  const { status, reason, dueBy, pastDue, buyerEmail, productDescription, delivery } = facts;
  if (status.state === "known" && (typeof status.value !== "string" || !/^[a-z_]{1,64}$/.test(status.value))) fail();
  if (reason.state === "known" && (typeof reason.value !== "string" || !/^[a-z_]{1,64}$/.test(reason.value))) fail();
  if (dueBy.state === "known" && !whole(dueBy.value)) fail();
  if (pastDue.state === "known" && typeof pastDue.value !== "boolean") fail();
  if (buyerEmail.state === "known") {
    const email = buyerEmail.value;
    if (typeof email !== "string" || email.length > 254 || email !== email.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail();
  }
  if (productDescription.state === "known" && (typeof productDescription.value !== "string" || !productDescription.value.trim())) fail();
  if (delivery.state === "known" && (!Array.isArray(delivery.value) ||
      delivery.value.some(kind => !(DELIVERY_KINDS as readonly string[]).includes(kind)) ||
      new Set(delivery.value).size !== delivery.value.length)) fail();

  // Dispute conditions: only a known, open, answerable dispute inside its own deadline.
  if (status.state !== "unknown" && !(status.state === "known" && ANSWERABLE_STATUSES.has(status.value))) blockers.push("status_not_answerable");
  if (reason.state === "none") blockers.push("reason_missing");
  if (dueBy.state === "none") blockers.push("deadline_missing");
  if (dueBy.state === "known" && dueBy.value <= facts.now) blockers.push("deadline_passed");
  if (pastDue.state === "none" || (pastDue.state === "known" && pastDue.value)) blockers.push("past_due");

  // Which record kinds had to be read: the universal ones, plus the product's
  // delivery kinds. With delivery unknown, the extra kinds cannot be known,
  // and `unknown:delivery` already closes the send.
  const applicable = new Set<DisputeEvidenceKind>([...UNIVERSAL_KINDS, ...(delivery.state === "known" ? delivery.value : [])]);
  if (!facts.records || typeof facts.records !== "object") fail();
  const knownRecords: RetainedPurchaseEvidence[] = [];
  const knownKinds = new Set<DisputeEvidenceKind>();
  for (const key of Object.keys(facts.records)) if (!(DISPUTE_EVIDENCE_KINDS as readonly string[]).includes(key)) fail();
  for (const kind of DISPUTE_EVIDENCE_KINDS) {
    const read = facts.records[kind];
    if (read === undefined) {
      if (applicable.has(kind)) { unknown.push(kind); blockers.push(`unknown:${kind}`); }
      continue;
    }
    if (!isRead(read)) fail();
    if (read.state === "unknown") { unknown.push(kind); blockers.push(`unknown:${kind}`); continue; }
    if (read.state === "none") { if (applicable.has(kind)) none.push(kind); continue; }
    // A known read with no record, or holding another kind's record, contradicts itself.
    if (!Array.isArray(read.value) || !read.value.length || read.value.some(row => row?.kind !== kind)) fail();
    knownRecords.push(...read.value);
    knownKinds.add(kind);
  }
  const packet = buildDisputeEvidencePacket(facts.scope, knownRecords, facts.now);
  // A kind whose every record is past retention is no longer evidence: read as none.
  for (const kind of knownKinds) {
    if (!packet.records.some(row => row.kind === kind) && applicable.has(kind)) none.push(kind);
  }

  const lines: Partial<Record<StripeTextField, string[]>> = {};
  const fileKinds = new Map<StripeFileField, DisputeEvidenceKind[]>();
  for (const row of packet.records) {
    const field = TEXT_FIELD_OF[row.kind];
    (lines[field] ??= []).push(`${LABEL[row.kind]}, ${iso(row.recordedAt)}: ${row.text}`);
    const file = FILE_FIELD_OF[row.kind];
    if (file) {
      const kinds = fileKinds.get(file) ?? [];
      if (!kinds.includes(row.kind)) kinds.push(row.kind);
      fileKinds.set(file, kinds);
    }
  }
  const candidates: Partial<Record<StripeTextField, string>> = {};
  if (buyerEmail.state === "known") candidates.customer_email_address = buyerEmail.value;
  if (productDescription.state === "known") candidates.product_description = productDescription.value;
  for (const [field, rows] of Object.entries(lines) as [StripeTextField, string[]][]) candidates[field] = rows.join("\n\n");
  // Over a cap, the field is held back whole and named, never cut.
  let total = 0;
  for (const [field, text] of Object.entries(candidates) as [StripeTextField, string][]) {
    if (text.length > DISPUTE_TEXT_FIELD_CHARACTERS) { blockers.push(`too_long:${field}`); continue; }
    evidence[field] = text;
    total += text.length;
  }
  if (total > DISPUTE_EVIDENCE_TOTAL_CHARACTERS) blockers.push("too_long:total");
  // The email alone defends nothing: a send needs at least one fact about the purchase.
  if (!Object.keys(evidence).some(field => field !== "customer_email_address")) blockers.push("nothing_to_send");

  return {
    dispute: facts.dispute,
    evidence,
    fileCandidates: [...fileKinds].map(([field, kinds]) => ({ field, kinds })),
    none, unknown, blockers,
    maySend: blockers.length === 0,
    submitted: false,
  };
}
