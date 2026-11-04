/** A physical confirmation's origin is reserved before its payment URL.
 * Confirmation and shipment are separate intentions with separate sources.
 * This module shares the existing bounded pool/Lua, never a provider quota.
 */
import { singleDigitalAccessCovered, singleDigitalMessage, readSingleDigitalAccess, singleDigitalRenewalCovered, singleDigitalRenewalIdentity, verifySingleDigitalRenewal, singleDigitalRenewalDraft, activateSingleDigitalRenewal, type SingleDigitalRenewalDraft } from "@/lib/single-digital-access";
import { storeForEmail, storeRef } from "@/lib/store";
import { physicalOptionCovered } from "@/lib/physical-option-confirmation";
import { createHash, randomBytes } from "node:crypto";
import { openCourseOriginBinding, type OpenedCourseOriginBinding } from "@/lib/course-origin-binding";
import { performance } from "node:perf_hooks";
import { onAccount } from "@/lib/stripe-account";
import { bindOrderConfirmationPreintent, commitOrderConfirmationSettlement } from "@/lib/orders";
import { fromStore, originalPhysicalConfirmation, type SessionRecord } from "@/lib/purchase-email";
import { refundedInFull } from "@/lib/refunds";
import { DEMO_CONNECTED_ACCOUNT } from "@/lib/demo-account";
import type { Listing, Store } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { canSeal, seal, unseal } from "@/lib/secret-box";
import {
  CURRENT_SHIPMENT_MAIL_LIFECYCLE, CURRENT_SHIPMENT_MAIL_POLICY,
  SHIPMENT_MAIL_SCRIPT, SHIPMENT_MAIL_MAX_ROW_BYTES, SHIPMENT_MAIL_MAX_INDEX_ITEMS,
  shipmentMailPolicy, recoverPendingMail, type ShipmentMailDispatch,
  type ShipmentMailPipeline, type ShipmentMailPolicy, type ShipmentMailRuntime,
} from "@/lib/shipment-mail-outbox";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const STORE = /^[A-Za-z0-9_-]{1,128}$/;
const ACCOUNT = /^acct_[A-Za-z0-9]{6,128}$/;
const SESSION = /^cs_(?:test|live)_[A-Za-z0-9]{10,200}$/;
export const CONFIRMATION_ORIGIN_DUE = "nl:order-confirmation:due";
export const CONFIRMATION_CREATE_REPLAY_MS = 23 * 3_600_000;
export const CONFIRMATION_CREATE_LEASE_MS = 120_000;
export type ConfirmationPhase = "course_reserved" | "awaiting_creation" | "creating" | "creation_unknown" | "awaiting_payment" | "queued" | "dispatching" | "refused" | "accepted";
export type ConfirmationOriginPayload = {
  body: string; preintentToken: string; intentFingerprint: string;
  /** Only the explicitly selected original product/store fields, never a
   * current catalog read or the whole account's settings/other buyers. */
  snapshot: Record<string, unknown>;
  settlementToken?: string;
  message?: { from: string; to: string; subject: string; text: string; replyTo: string };
  paidCents?: number;
  accessUrl?: string;
  courseBindingToken?: string;
};
export type ConfirmationOrigin = {
  kind: "confirmation";
  /** Explicit extra origin; course binding stays course-only. Physical rows omit both fields. */
  originKind?: "course" | "single_digital"; courseBindingFingerprint?: string;
  id: string; statsId: string; nonce: string; accountId: string;
  bodyDigest: string; intentFingerprint: string; bindingFingerprint: string; session: string; person: string;
  sourceValue: string; sealed: string; fingerprint: string; bytes: number;
  created: number; authorizedAt: number; next: number; expiresAt: number;
  state: "queued" | "preparing" | "dispatching" | "refused";
  phase: ConfirmationPhase; owner: string; leaseUntil: number; checks: number;
  createAttempts: number; reviewId: string; recoveryCursor: string; recoveryUpper: number;
  /** At most64 hashes, charged inside the original fixed row envelope. */
  erasedPeople: string; erasureSaturated: boolean;
};
export const confirmationOriginId = (statsId: string, nonce: string) => hash(`confirmation\n${statsId}\n${nonce}`);
export function confirmationBodyDigest(body: string): string {
  const canonical = new URLSearchParams(body);
  canonical.delete("metadata[mm_order_hash]");
  return hash(canonical.toString());
}
export const confirmationOriginRowKey = (id: string) => `nl:order-confirmation:row:${id}`;
const sourceKey = (id: string) => `nl:order-confirmation:source:${id}`;
const context = (id: string) => `order-confirmation-origin|${id}`;
function data(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !d || !Object.hasOwn(d, "value")) return null;
      result[key] = d.value;
    }
    return result;
  } catch { return null; }
}
function array(value: unknown, max = 3): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > max || Reflect.ownKeys(value).length !== length + 1) return null;
    const result: unknown[] = [];
    for (let i = 0; i < length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d || !Object.hasOwn(d, "value")) return null;
      result.push(d.value);
    }
    return result;
  } catch { return null; }
}
function snapshotData(value: unknown, depth = 0, budget = { remaining: 2_000 }): unknown {
  if (--budget.remaining < 0 || depth > 8) throw Error("Confirmation snapshot is too large");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const list = array(value, 1_000);
    if (!list) throw Error("Confirmation list is unknown");
    return list.map(item => snapshotData(item, depth + 1, budget));
  }
  const own = data(value);
  if (!own || Object.keys(own).length > 128) throw Error("Confirmation snapshot is not plain data");
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(own)) result[key] = snapshotData(item, depth + 1, budget);
  return result;
}
async function serverNow(pipeline: ShipmentMailPipeline): Promise<number | null> {
  try {
    const reply = array(await pipeline([["TIME"]]));
    const clock = reply?.length === 1 ? array(reply[0], 2) : null;
    if (clock?.length !== 2 || !clock.every(value => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value))) return null;
    const seconds = Number(clock[0]), microseconds = Number(clock[1]);
    const now = seconds * 1_000 + Math.floor(microseconds / 1_000);
    return Number.isSafeInteger(now) && microseconds >= 0 && microseconds < 1_000_000 ? now : null;
  } catch { return null; }
}
function parse(raw: unknown): ConfirmationOrigin | null {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > SHIPMENT_MAIL_MAX_ROW_BYTES) return null;
    const row = data(JSON.parse(raw));
    const fields = ["kind", "id", "statsId", "nonce", "accountId", "bodyDigest", "intentFingerprint", "bindingFingerprint", "session", "person", "sourceValue", "sealed", "fingerprint", "bytes", "created", "authorizedAt", "next", "expiresAt", "state", "phase", "owner", "leaseUntil", "checks", "createAttempts", "reviewId", "recoveryCursor", "recoveryUpper", "erasedPeople", "erasureSaturated"];
    const course = row?.originKind === "course";
    const digital = row?.originKind === "single_digital";
    if (row?.originKind !== undefined && !course && !digital) return null;
    if (digital) fields.push("originKind");
    if (course) fields.push("originKind", "courseBindingFingerprint");
    if (!row || Object.keys(row).length !== fields.length || !fields.every(key => Object.hasOwn(row, key)) || row.kind !== "confirmation" || typeof row.id !== "string" || !HASH.test(row.id) ||
        typeof row.statsId !== "string" || !STORE.test(row.statsId) || typeof row.nonce !== "string" || !HASH.test(row.nonce) ||
        row.id !== confirmationOriginId(row.statsId, row.nonce) || typeof row.accountId !== "string" || !ACCOUNT.test(row.accountId) ||
        ![row.bodyDigest, row.intentFingerprint, row.person, row.fingerprint].every(v => typeof v === "string" && HASH.test(v)) ||
        typeof row.session !== "string" || row.session !== "" && !SESSION.test(row.session) ||
        typeof row.bindingFingerprint !== "string" || (row.session === "" ? row.bindingFingerprint !== "" : !HASH.test(row.bindingFingerprint)) ||
        typeof row.sourceValue !== "string" || Buffer.byteLength(row.sourceValue) > 8_192 || typeof row.sealed !== "string" || !row.sealed.startsWith("s1.") ||
        !["queued", "preparing", "dispatching", "refused"].includes(String(row.state)) ||
        !["course_reserved", "awaiting_creation", "creating", "creation_unknown", "awaiting_payment", "queued", "dispatching", "refused", "accepted"].includes(String(row.phase)) ||
        typeof row.recoveryCursor !== "string" || row.recoveryCursor !== "" && !SESSION.test(row.recoveryCursor) ||
        typeof row.owner !== "string" || !/^[a-f0-9]{0,48}$/.test(row.owner) || typeof row.reviewId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(row.reviewId) ||
        ![row.bytes, row.created, row.authorizedAt, row.next, row.expiresAt, row.leaseUntil, row.checks, row.createAttempts, row.recoveryUpper].every(v => typeof v === "number" && Number.isSafeInteger(v) && v >= 0) ||
        Number(row.bytes) < Buffer.byteLength(raw) || typeof row.erasedPeople !== "string" || !/^(?:[a-f0-9]{64}){0,64}$/.test(row.erasedPeople) ||
        typeof row.erasureSaturated !== "boolean") return null;
    if (course ? typeof row.courseBindingFingerprint !== "string" || !HASH.test(row.courseBindingFingerprint) ||
        row.phase !== "course_reserved" || row.next !== 0 || row.session !== "" || row.bindingFingerprint !== "" || row.state !== "queued" || row.owner !== "" || row.leaseUntil !== 0 || row.createAttempts !== 0 || row.checks !== 0
        : row.phase === "course_reserved") return null;
    const source = data(JSON.parse(row.sourceValue));
    if (!source || Object.keys(source).length !== (row.session ? 6 : 5) + (course ? 2 : digital ? 1 : 0) || source.kind !== "confirmation" || source.nonce !== row.nonce ||
        source.accountId !== row.accountId || source.bodyDigest !== row.bodyDigest || source.session !== row.session ||
        (row.session && source.bindingFingerprint !== row.bindingFingerprint)) return null;
    if (digital && source.originKind !== "single_digital") return null;
    if (course && (source.originKind !== "course" || source.courseBindingFingerprint !== row.courseBindingFingerprint)) return null;
    return row as unknown as ConfirmationOrigin;
  } catch { return null; }
}
function keys(row: Pick<ConfirmationOrigin, "id" | "statsId" | "person">): string[] {
  return [confirmationOriginRowKey(row.id), sourceKey(row.id), CONFIRMATION_ORIGIN_DUE,
    `nl:order-confirmation:store:${row.statsId}`, `nl:order-confirmation:person:${row.statsId}:${row.person}`,
    "nl:ship:mail:pool", `nl:ship:mail:pool:${row.statsId}`, "nl:ship:mail:all",
    `nl:order-confirmation:closed:${row.statsId}`, `nl:order-confirmation:erased:${row.statsId}:${row.person}`];
}
export function confirmationOutboxPolicy(runtime: ShipmentMailRuntime = {}, admission = true): ShipmentMailPolicy | null {
  const lifecycle = runtime.lifecycle ?? CURRENT_SHIPMENT_MAIL_LIFECYCLE;
  if (lifecycle !== "active") return null;
  return shipmentMailPolicy(runtime.policy === undefined ? CURRENT_SHIPMENT_MAIL_POLICY : runtime.policy, (runtime.now ?? Date.now)(), admission);
}
async function readOrigin(id: string, runtime: ShipmentMailRuntime = {}, renewal?: { found?: RenewalFound }): Promise<{ row: ConfirmationOrigin; raw: string; payload: ConfirmationOriginPayload } | null> {
  if ((runtime.lifecycle ?? CURRENT_SHIPMENT_MAIL_LIFECYCLE) === "never_activated" || !HASH.test(id)) return null;
  const pipeline = runtime.pipeline ?? redisPipeline;
  try {
    const reply = array(await pipeline([["TYPE", confirmationOriginRowKey(id)], ["GETRANGE", confirmationOriginRowKey(id), 0, SHIPMENT_MAIL_MAX_ROW_BYTES], ["GET", sourceKey(id)]]));
    if (reply?.length !== 3 || reply[0] !== "string") return null;
    const row = parse(reply[1]);
    if (!row && renewal) {
      const decoded = decodeRenewal(reply[1], reply[2]);
      if (decoded?.row.id === id) renewal.found = decoded;
    }
    if (!row || row.id !== id || reply[2] !== row.sourceValue) return null;
    const opened = unseal(row.sealed, context(id));
    if (!opened.ok || hash(opened.value) !== row.fingerprint) return null;
    const payload = data(JSON.parse(opened.value));
    if (row.originKind === "single_digital" && new URLSearchParams(String(payload?.body)).get("metadata[mm_order_origin]") !== "single-digital-v1") return null;
    if (!payload || typeof payload.body !== "string" || confirmationBodyDigest(payload.body) !== row.bodyDigest ||
        typeof payload.preintentToken !== "string" || hash(payload.preintentToken) !== row.intentFingerprint ||
        payload.intentFingerprint !== row.intentFingerprint || !data(payload.snapshot)) return null;
    return { row, raw: String(reply[1]), payload: payload as unknown as ConfirmationOriginPayload };
  } catch { return null; }
}

/** Physical and retention-only digital stages never consume a course source. */
export async function readConfirmationOrigin(id: string, runtime: ShipmentMailRuntime = {}) {
  const found = await readOrigin(id, runtime);
  return found && found.row.originKind !== "course" ? found : null;
}

type PersistedCourseBinding = OpenedCourseOriginBinding & { token: string; fingerprint: string };
/** Read the original selected snapshot at its recorded reservation time. A
 * later expired preintent cannot delete pending evidence or renew its rights.
 * This is not a current payment, checkout, access or provider capability. */
export async function readCourseConfirmationOrigin(id: string, runtime: ShipmentMailRuntime = {}): Promise<{
  row: ConfirmationOrigin; raw: string; payload: ConfirmationOriginPayload; binding: PersistedCourseBinding;
} | null> {
  const found = await readOrigin(id, runtime);
  if (!found || found.row.originKind !== "course" || typeof found.payload.courseBindingToken !== "string") return null;
  const token = found.payload.courseBindingToken, binding = openCourseOriginBinding(token, found.row.nonce, found.row.created);
  if (!binding || hash(token) !== found.row.courseBindingFingerprint || binding.body !== found.payload.body ||
      binding.preintent.token !== found.payload.preintentToken || binding.preintent.intentFingerprint !== found.row.intentFingerprint ||
      binding.candidate.identity.statsId !== found.row.statsId || binding.candidate.identity.accountId !== found.row.accountId ||
      binding.expiresAtMs !== found.row.expiresAt) return null;
  const snapshot = data(found.payload.snapshot);
  if (!snapshot || Object.keys(snapshot).length !== 1 || !Object.hasOwn(snapshot, "selected") ||
      JSON.stringify(snapshot.selected) !== JSON.stringify(binding.candidate)) return null;
  return { ...found, binding: Object.freeze({ ...binding, token, fingerprint: hash(token) }) };
}

/** No caller is connected to this construction. The future trusted producer
 * must first obtain Store/product from actual server reads; a signed selected
 * snapshot is not proof of database ownership, buyer, funding or payment. */
export async function reserveCourseConfirmationOrigin(input: unknown, runtime: ShipmentMailRuntime = {}): Promise<{ ok: true; id: string; admitted: false; permitsCheckout: false; grantsAccess: false } | { ok: false }> {
  const policy = confirmationOutboxPolicy(runtime);
  if (!policy?.coveredOrigins?.includes("course-confirmation")) return { ok: false };
  try {
    const value = data(input);
    if (!value || Object.keys(value).length !== 2 || !["bindingToken", "nonce"].every(k => Object.hasOwn(value, k))) return { ok: false };
    const binding = openCourseOriginBinding(value.bindingToken, value.nonce, (runtime.now ?? Date.now)());
    if (!binding || typeof value.bindingToken !== "string") return { ok: false };
    // Only these authenticated selected fields are durable payload data.
    // The complete original preintent token is the accounting evidence; no
    // caller tier/cycle/period/Store clone is certified by this construction.
    const snapshot = { selected: binding.candidate };
    const result = await reserveOrigin({ statsId: binding.candidate.identity.statsId, nonce: binding.nonce, accountId: binding.candidate.identity.accountId,
      body: binding.body, preintent: binding.preintent, snapshot }, runtime,
      { token: value.bindingToken, fingerprint: hash(value.bindingToken), selected: binding.candidate });
    if (!result.ok) return result;
    // The persisted winner, not an enqueue-looking reply, is the evidence.
    const saved = await readCourseConfirmationOrigin(result.id, runtime);
    if (!saved || saved.binding.token !== value.bindingToken || saved.binding.body !== binding.body ||
        saved.binding.preintent.token !== binding.preintent.token) return { ok: false };
    return { ...result, admitted: false, permitsCheckout: false, grantsAccess: false };
  } catch { return { ok: false }; }
}

/** The full future row envelope is charged before reserving a new payment
 * origin. The reviewed cap must fund its complete uncertain/pending lifetime.
 */
async function reserveOrigin(input: {
  statsId: string | null; nonce: string; accountId: string; body: string;
  preintent: { token: string; expiresAtMs: number; intentFingerprint: string };
  snapshot: Record<string, unknown>;
}, runtime: ShipmentMailRuntime = {}, course?: { token: string; fingerprint: string; selected: OpenedCourseOriginBinding["candidate"] }, digital = false): Promise<{ ok: true; id: string } | { ok: false }> {
  const p = confirmationOutboxPolicy(runtime);
  if (!p || !canSeal() || digital && !p.coveredOrigins?.includes("single-digital-confirmation")) return { ok: false };
  try {
    const own = data(input), preintent = data(own?.preintent);
    if (!own || !preintent || typeof own.statsId !== "string" || !STORE.test(own.statsId) || typeof own.nonce !== "string" || !HASH.test(own.nonce) ||
        typeof own.accountId !== "string" || !ACCOUNT.test(own.accountId) || own.accountId === DEMO_CONNECTED_ACCOUNT || typeof own.body !== "string" ||
        typeof preintent.token !== "string" || !preintent.token.startsWith("s1.") || typeof preintent.expiresAtMs !== "number" || !Number.isSafeInteger(preintent.expiresAtMs) ||
        hash(preintent.token) !== preintent.intentFingerprint || !data(own.snapshot)) return { ok: false };
    const statsId = own.statsId;
    input = { ...own, preintent } as typeof input;
    const form = new URLSearchParams(input.body), bodyDigest = confirmationBodyDigest(input.body);
    if (form.get("metadata[mm_order_intent]") !== input.nonce || form.get("metadata[mm_order_hash]") !== bodyDigest) return { ok: false };
    // Authentic admission proof must precede even creation of a hosted page.
    // A matching caller-supplied hash of an arbitrary token is not evidence.
    const opened = unseal(input.preintent.token, `order-confirmation-preintent|${input.nonce}`);
    if (!opened.ok || opened.value.length > 2_500) return { ok: false };
    const proof = data(JSON.parse(opened.value)), original = data(proof?.original);
    const snapshot = snapshotData(input.snapshot) as Record<string, unknown>, snapshotStore = data(snapshot.store);
    const owner = snapshotStore?.extra === true ? `#${snapshotStore.sid}` : snapshotStore?.email;
    const ownerMatches = course
      ? original && (original.owner === course.selected.original.ownerEmail.toLowerCase() || original.owner === `#${course.selected.identity.sid}`)
      : original?.owner === owner && snapshotStore?.statsId === statsId && snapshotStore?.stripeAccountId === input.accountId;
    if (!proof || !original || proof.version !== 1 || proof.nonce !== input.nonce || proof.accountId !== input.accountId || proof.bodyDigest !== bodyDigest ||
        original.until !== input.preintent.expiresAtMs || !ownerMatches) return { ok: false };
    const pipeline = runtime.pipeline ?? redisPipeline;
    const now = await serverNow(pipeline), id = confirmationOriginId(statsId, input.nonce);
    if (now === null || Math.abs(now - (runtime.now ?? Date.now)()) > 60_000 || input.preintent.expiresAtMs <= now) return { ok: false };
    if (course && !openCourseOriginBinding(course.token, input.nonce, now)) return { ok: false };
    const payload: ConfirmationOriginPayload = { body: input.body, preintentToken: input.preintent.token, intentFingerprint: input.preintent.intentFingerprint, snapshot,
      ...(course ? { courseBindingToken: course.token } : {}) };
    const plain = JSON.stringify(payload);
    if (Buffer.byteLength(plain) > p.maxPayloadBytes) return { ok: false };
    const row: ConfirmationOrigin = { kind: "confirmation", ...(course ? { originKind: "course" as const, courseBindingFingerprint: course.fingerprint } : digital ? { originKind: "single_digital" as const } : {}), id, statsId, nonce: input.nonce,
      accountId: input.accountId, bodyDigest, intentFingerprint: input.preintent.intentFingerprint, bindingFingerprint: "",
      session: "", person: hash(`unbound:${input.nonce}`),
      sourceValue: JSON.stringify({ kind: "confirmation", nonce: input.nonce, accountId: input.accountId, bodyDigest, session: "", ...(course ? { originKind: "course", courseBindingFingerprint: course.fingerprint } : digital ? { originKind: "single_digital" } : {}) }),
      sealed: seal(plain, context(id)), fingerprint: hash(plain), bytes: 0,
      created: now, authorizedAt: now, next: course ? 0 : now, expiresAt: input.preintent.expiresAtMs,
      state: "queued", phase: course ? "course_reserved" : "awaiting_creation", owner: "", leaseUntil: 0, checks: 0, createAttempts: 0, reviewId: p.reviewId, recoveryCursor: "", recoveryUpper: 0, erasedPeople: "", erasureSaturated: false };
    row.bytes = SHIPMENT_MAIL_MAX_ROW_BYTES + keys(row).reduce((n, key) => n + Buffer.byteLength(key), 0) * 2 + 16_384;
    const raw = JSON.stringify(row);
    if (!parse(raw)) return { ok: false };
    const reply = array(await pipeline([["EVAL", SHIPMENT_MAIL_SCRIPT, 10, ...keys(row), "enqueue", "", raw, now, SHIPMENT_MAIL_MAX_ROW_BYTES, JSON.stringify(p), ""]]));
    const receipt = reply?.length === 1 ? array(reply[0]) : null;
    const saved = receipt && (receipt[0] === "queued" && receipt.length === 2 || receipt[0] === "existing" && receipt.length === 3) ? parse(receipt[1]) : null;
    if (receipt?.[0] === "existing" && receipt[2] !== saved?.sourceValue) return { ok: false };
    if (!saved || saved.id !== id || saved.intentFingerprint !== row.intentFingerprint || saved.bodyDigest !== row.bodyDigest ||
        saved.originKind !== row.originKind || saved.courseBindingFingerprint !== row.courseBindingFingerprint) return { ok: false };
    return { ok: true, id };
  } catch { return { ok: false }; }
}

/** Retention/reconciliation construction only, not payment or access permission.
 * The source captures original rights inside the same funded envelope. There is
 * deliberately no digital creation, payment URL, receipt or settlement stage.
 */
export async function reserveSingleDigitalConfirmationOrigin(input: Parameters<typeof reserveOrigin>[0], runtime: ShipmentMailRuntime = {}): Promise<{ ok: true; id: string } | { ok: false }> {
  try {
    const value = data(input), snapshot = data(value?.snapshot), store = data(snapshot?.store), product = data(snapshot?.product), rights = data(snapshot?.rights);
    if (!value || typeof value.body !== "string" || !store || !product || !rights) return { ok: false };
    const form = new URLSearchParams(value.body), file = data(product.file);
    if (form.get("metadata[mm_order_origin]") !== "single-digital-v1" || form.get("mode") !== "payment" ||
      !file || typeof file.pathname !== "string" || !file.pathname || typeof file.name !== "string" || !file.name ||
      !Number.isSafeInteger(file.bytes) || Number(file.bytes) <= 0 || typeof file.contentType !== "string" || typeof file.addedAt !== "string" ||
      typeof product.id !== "string" || form.get("metadata[product]") !== product.id ||
      form.get("line_items[0][quantity]") !== "1" || !Number.isSafeInteger(product.priceCents) || Number(product.priceCents) <= 0 ||
      form.get("line_items[0][price_data][unit_amount]") !== String(product.priceCents) ||
      rights.priceCents !== product.priceCents || rights.currency !== store.currency ||
      form.get("line_items[0][price_data][currency]") !== rights.currency ||
      typeof rights.consent !== "string" || !/^yes:[^:]+:d:[0-9]+$/.test(rights.consent) || form.get("metadata[dc]") !== rights.consent ||
      [product.link, product.shipping, product.call, product.course, product.podcast, product.bundle, product.recurring, product.keys, product.note, product.plan, product.pwyw, product.callPackage].some(Boolean) ||
      !Array.isArray(product.options) || product.options.length !== 0 || !Array.isArray(product.fields) || product.fields.length !== 0) return { ok: false };
    return reserveOrigin(input, runtime, undefined, true);
  } catch { return { ok: false }; }
}

/** Preserve the existing physical producer contract. Course bodies cannot
 * downgrade to a physical source and bypass explicit course funding/isolation. */
function hasPhysicalOption(value: unknown): boolean {
  const own = data(value), snapshot = data(own?.snapshot), product = data(snapshot?.product);
  return typeof own?.body === "string" && (new URLSearchParams(own.body).has("metadata[option]") ||
    product?.options !== undefined && array(product.options, 1)?.length !== 0);
}
function physicalOriginCovered(found: { row: ConfirmationOrigin; payload: ConfirmationOriginPayload }, policy: ShipmentMailPolicy | null, now: number): boolean {
  return Boolean(policy && (found.row.originKind !== undefined || !hasPhysicalOption(found.payload) || physicalOptionCovered(found.payload, policy, now, false)));
}
export async function reserveConfirmationOrigin(input: Parameters<typeof reserveOrigin>[0], runtime: ShipmentMailRuntime = {}): Promise<{ ok: true; id: string } | { ok: false }> {
  const value = data(input);
  if (!value || typeof value.body !== "string" || new URLSearchParams(value.body).get("metadata[mm_order_origin]") !== "physical-v1") return { ok: false };
  if (hasPhysicalOption(value) && !physicalOptionCovered(value, confirmationOutboxPolicy(runtime), (runtime.now ?? Date.now)())) return { ok: false };
  return reserveOrigin(value as Parameters<typeof reserveOrigin>[0], runtime);
}

/** A preparation lease may authorize replay of the SAME Stripe creation
 * inside its retention window. It never authorizes replay of email sends.
 * After that conservative 23h window, only verified provider reads can bind.
 */
export const CONFIRMATION_ORIGIN_SCRIPT = `-- marktmorgen:confirmation-origin:v1
local op,expected,supplied=ARGV[1],ARGV[2],ARGV[3]
local now=tonumber(ARGV[4])
if not now or now<0 then return {'unknown'} end
local clock=redis.call('TIME')
local serverNow=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
if math.abs(now-serverNow)>60000 then return {'unknown'} end
now=serverNow
local types={'string','string','zset','set','set','hash','hash','set','string','string'}
for i=1,10 do local t=redis.call('TYPE',KEYS[i]).ok; if t~='none' and t~=types[i] then return {'unknown'} end end
local raw=redis.call('GETRANGE',KEYS[1],0,131072)
if raw~=expected or #raw>131072 then return {'changed'} end
local ok,r=pcall(cjson.decode,raw)
if not ok or type(r)~='table' or r.kind~='confirmation' or redis.call('GET',KEYS[2])~=r.sourceValue or type(r.expiresAt)~='number' or now>=r.expiresAt then return {'unknown'} end
-- Reserve-only courses cannot acquire creation, cursor, bind or URL permission.
if r.originKind~=nil and r.originKind~='single_digital' then return {'unknown'} end
-- No verified original-file access recipe: digital creation and URL stay closed.
if r.originKind=='single_digital' and op~='cursor' and op~='bind' then
 local ok,a=pcall(cjson.decode,ARGV[6])
 if not ok or type(a)~='table' or type(a.singleDigitalAccessEvidence)~='string' or #a.singleDigitalAccessEvidence==0 then return {'unknown'} end
end
if redis.call('EXISTS',KEYS[9],KEYS[10])~=0 then return {'held'} end
local good,p=pcall(cjson.decode,ARGV[6])
if not good or type(p)~='table' then return {'unknown'} end
if r.originKind=='single_digital' then
 local covered=false
 if type(p.coveredOrigins)=='table' then for _,purpose in ipairs(p.coveredOrigins) do if purpose=='single-digital-confirmation' then covered=true end end end
 if not covered then return {'unknown'} end
end
local supported=r.reviewId==p.reviewId
if type(p.continuedReviewIds)=='table' then for _,id in ipairs(p.continuedReviewIds) do if id==r.reviewId then supported=true end end end
if not supported then return {'unknown'} end
if op=='url' then
 local good,n=pcall(cjson.decode,supplied)
 if not good or type(n)~='table' or (r.state~='queued' and r.state~='preparing') or r.phase~='awaiting_payment' or r.session=='' or
    n.session~=r.session or n.bindingFingerprint~=r.bindingFingerprint then return {'held'} end
 -- Read-only final exposure permission: no renewed source, lease or capacity.
 return {'url',r.id,r.session,r.bindingFingerprint,tostring(serverNow),tostring(math.min(r.expiresAt,serverNow+1000))}
elseif op=='cursor' then
 local good,n=pcall(cjson.decode,supplied)
 if not good or type(n)~='table' or r.session~='' or type(n.recoveryCursor)~='string' or type(n.recoveryUpper)~='number' then return {'unknown'} end
 r.recoveryCursor=n.recoveryCursor; r.recoveryUpper=n.recoveryUpper; r.next=now+p.retryMilliseconds; r.phase='creation_unknown'
elseif op=='create' then
 if r.session~='' or (r.phase~='awaiting_creation' and r.phase~='creating') or r.leaseUntil>now then return {'held'} end
 if now>=r.created+82800000 or r.createAttempts>=p.maximumChecks then return {'creation_unknown'} end
 r.phase='creating'; r.owner=ARGV[5]; r.leaseUntil=now+120000; r.next=r.leaseUntil; r.createAttempts=r.createAttempts+1
elseif op=='bind' then
 local good,n=pcall(cjson.decode,supplied)
 if not good or type(n)~='table' or n.kind~='confirmation' then return {'unknown'} end
 for _,field in ipairs({'originKind','courseBindingFingerprint','id','statsId','nonce','accountId','bodyDigest','intentFingerprint','created','expiresAt','bytes','person','reviewId','erasedPeople','erasureSaturated'}) do if n[field]~=r[field] then return {'unknown'} end end
 if r.session~='' then return {'bound',raw} end
 if n.session=='' or n.phase~='awaiting_payment' or #supplied>131072 or #supplied>r.bytes then return {'unknown'} end
 redis.call('SET',KEYS[1],supplied); redis.call('SET',KEYS[2],n.sourceValue)
 redis.call('ZADD',KEYS[3],n.next,n.id)
 return {'bound',supplied}
else return {'unknown'} end
local encoded=cjson.encode(r)
if #encoded>131072 or #encoded>r.bytes then return {'unknown'} end
redis.call('SET',KEYS[1],encoded); redis.call('ZADD',KEYS[3],r.next,r.id)
if op=='cursor' then return {'cursor',encoded} end
return {'creating',encoded,tostring(serverNow),tostring(r.created+82800000)}`;

export async function claimConfirmationCreation(id: string, runtime: ShipmentMailRuntime = {}): Promise<{ row: ConfirmationOrigin; payload: ConfirmationOriginPayload; sendBeforeMs: number; sendBeforeMonotonicMs: number } | null> {
  if (!confirmationOutboxPolicy(runtime, false)) return null;
  const found = await readConfirmationOrigin(id, runtime);
  if (!found) return null;
  try {
    const pipeline = runtime.pipeline ?? redisPipeline, policy = confirmationOutboxPolicy(runtime, false), owner = randomBytes(24).toString("hex");
    if (!physicalOriginCovered(found, policy, (runtime.now ?? Date.now)())) return null;
    const started = performance.now();
    const reply = array(await pipeline([["EVAL", CONFIRMATION_ORIGIN_SCRIPT, 10, ...keys(found.row), "create", found.raw, "", (runtime.now ?? Date.now)(), owner, JSON.stringify(policy)]]));
    const receipt = reply?.length === 1 ? array(reply[0], 4) : null;
    const row = receipt?.length === 4 && receipt[0] === "creating" ? parse(receipt[1]) : null;
    if (!row || row.owner !== owner || typeof receipt?.[2] !== "string" || typeof receipt[3] !== "string" ||
        !/^[1-9][0-9]*$/.test(receipt[2]) || !/^[1-9][0-9]*$/.test(receipt[3])) return null;
    const server = Number(receipt[2]), sendBeforeMs = Number(receipt[3]);
    const sendBeforeMonotonicMs = started + sendBeforeMs - server;
    if (!Number.isSafeInteger(server) || !Number.isSafeInteger(sendBeforeMs) || sendBeforeMs <= server || performance.now() >= sendBeforeMonotonicMs || (runtime.now ?? Date.now)() >= sendBeforeMs) return null;
    return { row, payload: found.payload, sendBeforeMs, sendBeforeMonotonicMs };
  } catch { return null; }
}

type BoundConfirmationOrigin = { sessionId: string; settlementToken: string; bindingFingerprint: string; intentFingerprint: string; expiresAtMs: number };
function winner(found: Awaited<ReturnType<typeof readConfirmationOrigin>>): BoundConfirmationOrigin | null {
  return found && SESSION.test(found.row.session) && HASH.test(found.row.bindingFingerprint) && typeof found.payload.settlementToken === "string" && found.payload.settlementToken.startsWith("s1.")
    ? { sessionId: found.row.session, settlementToken: found.payload.settlementToken, bindingFingerprint: found.row.bindingFingerprint, intentFingerprint: found.row.intentFingerprint, expiresAtMs: found.row.expiresAt }
    : null;
}
/** The caller supplies a candidate derived from an independently read Stripe
 * session on the original account. Only this source CAS decides ownership;
 * a fresh candidate's AES nonce never replaces the stored winning token.
 */
export async function bindConfirmationOrigin(id: string, value: BoundConfirmationOrigin, runtime: ShipmentMailRuntime = {}): Promise<BoundConfirmationOrigin | null> {
  const policy = confirmationOutboxPolicy(runtime, false);
  if (!policy) return null;
  const found = await readConfirmationOrigin(id, runtime), candidate = data(value);
  if (!found || !candidate || typeof candidate.sessionId !== "string" || !SESSION.test(candidate.sessionId) ||
      typeof candidate.settlementToken !== "string" || !candidate.settlementToken.startsWith("s1.") ||
      typeof candidate.bindingFingerprint !== "string" || !HASH.test(candidate.bindingFingerprint) ||
      candidate.intentFingerprint !== found.row.intentFingerprint || candidate.expiresAtMs !== found.row.expiresAt) return null;
  if (found.row.session) return winner(found);
  try {
    const plain = JSON.stringify({ ...found.payload, settlementToken: candidate.settlementToken });
    const row = { ...found.row, session: candidate.sessionId, bindingFingerprint: candidate.bindingFingerprint, phase: "awaiting_payment" as const, owner: "", leaseUntil: 0,
      next: (runtime.now ?? Date.now)() + 60_000, sealed: seal(plain, context(id)), fingerprint: hash(plain),
      sourceValue: JSON.stringify({ kind: "confirmation", nonce: found.row.nonce, accountId: found.row.accountId, bodyDigest: found.row.bodyDigest, session: candidate.sessionId, bindingFingerprint: candidate.bindingFingerprint, ...(found.row.originKind === "single_digital" ? { originKind: "single_digital" } : {}) }) };
    const raw = JSON.stringify(row);
    if (!parse(raw)) return null;
    const pipeline = runtime.pipeline ?? redisPipeline;
    const reply = array(await pipeline([["EVAL", CONFIRMATION_ORIGIN_SCRIPT, 10, ...keys(found.row), "bind", found.raw, raw, (runtime.now ?? Date.now)(), "", JSON.stringify(policy)]]));
    const receipt = reply?.length === 1 ? array(reply[0]) : null;
    // A competing bind or lost ACK is resolved by reading the definitive
    // source, including its winning token and fingerprint, never this input.
    if (!receipt || !["bound", "changed"].includes(String(receipt[0]))) return null;
    return winner(await readConfirmationOrigin(id, runtime));
  } catch { return null; }
}

export const confirmationOriginIndexLimit = SHIPMENT_MAIL_MAX_INDEX_ITEMS;
export type ConfirmationOriginPipeline = ShipmentMailPipeline;

export type ConfirmationOriginRuntime = ShipmentMailRuntime & { provider?: typeof onAccount };
type ProviderSession = Record<string, unknown> & { id: string; metadata: Record<string, unknown> };
function verifiedSession(found: NonNullable<Awaited<ReturnType<typeof readConfirmationOrigin>>>, value: unknown): ProviderSession | null {
  try {
    const session = snapshotData(value) as Record<string, unknown>, metadata = data(session.metadata);
    if (!data(session) || typeof session.id !== "string" || !SESSION.test(session.id) || !metadata ||
        metadata.mm_order_intent !== found.row.nonce || metadata.mm_order_hash !== found.row.bodyDigest ||
        session.object !== "checkout.session" || session.mode !== "payment" ||
        typeof session.created !== "number" || !Number.isSafeInteger(session.created) || session.created < Math.floor(found.row.created / 1000) - 60) return null;
    const form = new URLSearchParams(found.payload.body);
    // Compare the full metadata of the original request, not only a request
    // parameter echo. The identity and original order contents travel together.
    const originalMetadata: string[] = [];
    for (const [key, value] of form) {
      const match = /^metadata\[([^\]]+)\]$/.exec(key);
      if (match) {
        originalMetadata.push(match[1]);
        if (metadata[match[1]] !== value) return null;
      }
    }
    // Extra mutable fields can manufacture digital-consent or marketing
    // statements despite a matching product/nonce. Only the exact original
    // request may describe this physical purchase or its rights.
    if (Object.keys(metadata).length !== originalMetadata.length) return null;
    const lineItems = data(session.line_items), lines = array(lineItems?.data, 1);
    if (!lineItems || lineItems.has_more !== false || !lines || lines.length !== 1) return null;
    const line = data(lines[0]), price = data(line?.price);
    const quantity = form.get("line_items[0][quantity]"), cents = form.get("line_items[0][price_data][unit_amount]"), currency = form.get("line_items[0][price_data][currency]");
    if (!line || !price || !quantity || !/^[1-9][0-9]*$/.test(quantity) || !cents || !/^(0|[1-9][0-9]*)$/.test(cents) ||
        !currency || line.quantity !== Number(quantity) || price.unit_amount !== Number(cents) || price.currency !== currency || session.currency !== currency) return null;
    return { ...session, id: session.id, metadata };
  } catch { return null; }
}
async function readProviderSession(found: NonNullable<Awaited<ReturnType<typeof readConfirmationOrigin>>>, id: string, runtime: ConfirmationOriginRuntime, payment = false): Promise<ProviderSession | null> {
  if (!SESSION.test(id)) return null;
  try {
    return verifiedSession(found, await (runtime.provider ?? onAccount)("GET", found.row.accountId, `/checkout/sessions/${encodeURIComponent(id)}?expand[]=line_items${payment ? "&expand[]=payment_intent.latest_charge" : ""}`));
  } catch { return null; }
}
async function bindVerifiedSession(found: NonNullable<Awaited<ReturnType<typeof readConfirmationOrigin>>>, session: ProviderSession, runtime: ConfirmationOriginRuntime): Promise<BoundConfirmationOrigin | null> {
  const originalStore = data(found.payload.snapshot.store);
  if (!originalStore) return null;
  const candidate = await bindOrderConfirmationPreintent(originalStore as unknown as Store, found.payload.preintentToken,
    { sessionId: session.id, nonce: String(session.metadata.mm_order_intent), accountId: found.row.accountId, bodyDigest: String(session.metadata.mm_order_hash) }, { now: runtime.now });
  return candidate ? bindConfirmationOrigin(found.row.id, candidate, runtime) : null;
}

/** Read one page from the original account. No absence of results is proof
 * that an uncertain creation failed. Pagination and the bounded time snapshot
 * are persisted; a complete empty walk starts another read cycle, never POST.
 */
async function recoverCreation(found: NonNullable<Awaited<ReturnType<typeof readConfirmationOrigin>>>, runtime: ConfirmationOriginRuntime): Promise<BoundConfirmationOrigin | null> {
  const policy = confirmationOutboxPolicy(runtime, false);
  if (!policy) return null;
  try {
    const pipeline = runtime.pipeline ?? redisPipeline;
    const clock = await serverNow(pipeline);
    if (clock === null) return null;
    const upper = found.row.recoveryUpper || Math.floor(clock / 1000);
    const search = new URLSearchParams({ limit: "100", "created[gte]": String(Math.max(0, Math.floor(found.row.created / 1000) - 60)), "created[lte]": String(upper) });
    if (found.row.recoveryCursor) search.set("starting_after", found.row.recoveryCursor);
    const page = data(await (runtime.provider ?? onAccount)("GET", found.row.accountId, `/checkout/sessions?${search}`));
    const list = array(page?.data, 100);
    if (!page || page.object !== "list" || !list || typeof page.has_more !== "boolean" || page.has_more && list.length === 0) return null;
    let last = "";
    for (const item of list) {
      const row = data(item), meta = data(row?.metadata);
      if (!row || typeof row.id !== "string" || !SESSION.test(row.id) || typeof row.created !== "number" || !Number.isSafeInteger(row.created) || row.created > upper || row.created < Math.floor(found.row.created / 1000) - 60) return null;
      last = row.id;
      if (meta?.mm_order_intent !== found.row.nonce) continue;
      const session = await readProviderSession(found, row.id, runtime);
      if (!session) return null;
      const bound = await bindVerifiedSession(found, session, runtime);
      if (bound) return bound;
      return null;
    }
    // Save progress only after every row in this page was processed. A crash
    // before this acknowledgement repeats read-only work, not a payment POST.
    await pipeline([["EVAL", CONFIRMATION_ORIGIN_SCRIPT, 10, ...keys(found.row), "cursor", found.raw,
      JSON.stringify({ recoveryCursor: page.has_more ? last : "", recoveryUpper: page.has_more ? upper : 0 }), clock, "", JSON.stringify(policy)]]);
    return null;
  } catch { return null; }
}

/** Only an exact, timely read-only acknowledgement may expose a URL after
 * provider verification. A closure/erasure that precedes this CAS denies it.
 * It cannot revoke a URL already returned, reserve public read costs, create a
 * Stripe attempt or renew the original source/creation deadline.
 */
async function confirmationUrlPermission(found: NonNullable<Awaited<ReturnType<typeof readConfirmationOrigin>>>, runtime: ConfirmationOriginRuntime): Promise<boolean> {
  const policy = confirmationOutboxPolicy(runtime, false);
  if (!physicalOriginCovered(found, policy, (runtime.now ?? Date.now)())) return false;
  try {
    const started = performance.now(), pipeline = runtime.pipeline ?? redisPipeline;
    const requestedAt = (runtime.now ?? Date.now)();
    if (!Number.isSafeInteger(requestedAt) || requestedAt < 0) return false;
    const reply = array(await pipeline([["EVAL", CONFIRMATION_ORIGIN_SCRIPT, 10, ...keys(found.row), "url", found.raw,
      JSON.stringify({ session: found.row.session, bindingFingerprint: found.row.bindingFingerprint }),
      requestedAt, "", JSON.stringify(policy)]]), 1);
    const ack = reply?.length === 1 ? array(reply[0], 6) : null;
    if (!ack || ack.length !== 6 || ack[0] !== "url" || ack[1] !== found.row.id || ack[2] !== found.row.session || ack[3] !== found.row.bindingFingerprint ||
        typeof ack[4] !== "string" || typeof ack[5] !== "string" || !/^[1-9][0-9]*$/.test(ack[4]) || !/^[1-9][0-9]*$/.test(ack[5])) return false;
    const server = Number(ack[4]), until = Number(ack[5]), receivedAt = (runtime.now ?? Date.now)();
    // Mirror the existing Lua's clock tolerance; a fabricated future ACK must
    // not look fresh merely because its duration is the expected1000ms.
    return Number.isSafeInteger(server) && Number.isSafeInteger(until) && Number.isSafeInteger(receivedAt) && receivedAt >= 0 &&
      Math.abs(server - requestedAt) <= 60_000 && Math.abs(server - receivedAt) <= 60_000 &&
      until === Math.min(found.row.expiresAt, server + 1000) && until > server &&
      performance.now() < started + until - server && receivedAt < until;
  } catch { return false; }
}

/** A real checkout caller uses this only after the complete origin is durably
 * reserved. Creation is replayable solely with its original body/key and an
 * acknowledged Redis-relative deadline. There is no POST after23h; verified
 * original-account reads remain possible after24h and process restarts.
 */
export async function openConfirmationOrigin(id: string, runtime: ConfirmationOriginRuntime = {}): Promise<{ url: string; id: string } | null> {
  // This origin has a retention adapter, not a verified original-file access recipe.
  if (!confirmationOutboxPolicy(runtime, false)) return null;
  let found = await readConfirmationOrigin(id, runtime);
  if (!found || found.row.originKind === "single_digital" && !singleDigitalAccessCovered(confirmationOutboxPolicy(runtime, false))) return null;
  if (!physicalOriginCovered(found, confirmationOutboxPolicy(runtime, false), (runtime.now ?? Date.now)())) return null;
  let bound = winner(found);
  if (!bound) {
    const claim = await claimConfirmationCreation(id, runtime);
    if (claim) {
      let created: Record<string, unknown> | null = null;
      try {
        if ((runtime.now ?? Date.now)() >= claim.sendBeforeMs || performance.now() >= claim.sendBeforeMonotonicMs ||
            !physicalOriginCovered(claim, confirmationOutboxPolicy(runtime, false), (runtime.now ?? Date.now)())) return null;
        created = await (runtime.provider ?? onAccount)("POST", claim.row.accountId, "/checkout/sessions", new URLSearchParams(claim.payload.body), undefined, `confirmation-origin:${claim.row.id}`);
      } catch { /* Unknown stays charged; the next attempt reads/replays only the original source. */ }
      if (typeof created?.id === "string") {
        const session = await readProviderSession(found, created.id, runtime);
        if (session) bound = await bindVerifiedSession(found, session, runtime);
      }
    }
    if (!bound) {
      found = await readConfirmationOrigin(id, runtime);
      if (!found) return null;
      bound = winner(found) ?? await recoverCreation(found, runtime);
    }
  }
  if (!bound) return null;
  found = await readConfirmationOrigin(id, runtime);
  if (!found || found.row.session !== bound.sessionId || found.row.bindingFingerprint !== bound.bindingFingerprint) return null;
  const session = await readProviderSession(found, bound.sessionId, runtime);
  if (!session || session.status !== "open" || typeof session.url !== "string") return null;
  try {
    const url = new URL(session.url);
    if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com" || url.username || url.password) return null;
    if (!(await confirmationUrlPermission(found, runtime))) return null;
    return { url: url.href, id: bound.sessionId };
  } catch { return null; }
}

/** Recipient binding and an accepted-but-unsettled receipt remain inside the
 * envelope reserved before payment. No new slot is manufactured after paying.
 * The new person index and its erasure fence are checked in the same CAS.
 */
export const CONFIRMATION_PAID_SCRIPT = `-- marktmorgen:confirmation-paid:v1
local op,expected,supplied=ARGV[1],ARGV[2],ARGV[3]
local clientNow=tonumber(ARGV[4])
local clock=redis.call('TIME')
local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
if not clientNow or clientNow<0 or math.abs(clientNow-now)>60000 then return {'unknown'} end
local types={'string','string','zset','set','set','hash','hash','set','string','string','set','string'}
for i=1,12 do local t=redis.call('TYPE',KEYS[i]).ok; if t~='none' and t~=types[i] then return {'unknown'} end end
local raw=redis.call('GETRANGE',KEYS[1],0,131072)
if raw~=expected or #raw>131072 then return {'changed'} end
local ok,r=pcall(cjson.decode,raw)
local good,p=pcall(cjson.decode,ARGV[6])
if not ok or not good or type(r)~='table' or type(p)~='table' or r.kind~='confirmation' or redis.call('GET',KEYS[2])~=r.sourceValue then return {'unknown'} end
if r.originKind~=nil then
 if r.originKind~='single_digital' or type(p.singleDigitalAccessEvidence)~='string' or #p.singleDigitalAccessEvidence==0 then return {'unknown'} end
 local covered=false
 if type(p.coveredOrigins)=='table' then for _,purpose in ipairs(p.coveredOrigins) do if purpose=='single-digital-confirmation' then covered=true end end end
 if not covered then return {'unknown'} end
end
local supported=r.reviewId==p.reviewId
if type(p.continuedReviewIds)=='table' then for _,id in ipairs(p.continuedReviewIds) do if id==r.reviewId then supported=true end end end
if not supported or redis.call('EXISTS',KEYS[9],KEYS[10],KEYS[12])~=0 then return {'held'} end
if op=='paid' then
 local good,n=pcall(cjson.decode,supplied)
 if not good or type(n)~='table' or r.session=='' or (r.phase~='awaiting_payment' and not (r.originKind=='single_digital' and r.phase=='queued')) or r.state~='preparing' or r.owner~=ARGV[5] or r.leaseUntil<now then return {'held'} end
 for _,field in ipairs({'originKind','courseBindingFingerprint','kind','id','statsId','nonce','accountId','bodyDigest','intentFingerprint','bindingFingerprint','session','sourceValue','bytes','created','authorizedAt','expiresAt','owner','leaseUntil','checks','createAttempts','reviewId','recoveryCursor','recoveryUpper','erasedPeople','erasureSaturated'}) do if n[field]~=r[field] then return {'unknown'} end end
 if type(r.erasedPeople)~='string' or #r.erasedPeople>4096 or #r.erasedPeople%64~=0 or type(r.erasureSaturated)~='boolean' then return {'held'} end
 for i=1,#r.erasedPeople,64 do if string.sub(r.erasedPeople,i,i+63)==n.person then return {'erased'} end end
 if r.erasureSaturated then return {'held'} end
 if n.state~='preparing' or n.phase~='queued' or type(n.person)~='string' or #n.person~=64 or type(n.sealed)~='string' or type(n.fingerprint)~='string' or #supplied>131072 or #supplied>r.bytes then return {'unknown'} end
 redis.call('SET',KEYS[1],supplied)
 redis.call('SREM',KEYS[5],r.id); redis.call('SADD',KEYS[11],r.id)
 return {'paid',supplied}
elseif op=='accepted' then
 if r.state~='dispatching' or r.owner~=ARGV[5] then return {'held'} end
 r.phase='accepted'; r.state='refused'; r.next=now+p.retryMilliseconds
 local encoded=cjson.encode(r)
 if #encoded>131072 or #encoded>r.bytes then return {'unknown'} end
 redis.call('SET',KEYS[1],encoded)
 if r.checks<p.maximumChecks then redis.call('ZADD',KEYS[3],r.next,r.id) else redis.call('ZREM',KEYS[3],r.id) end
 return {'accepted',encoded}
elseif op=='settlement' then
 if r.phase~='accepted' or r.state~='refused' or r.next>now then return {'held'} end
 if r.checks>=p.maximumChecks then redis.call('ZREM',KEYS[3],r.id); return {'held'} end
 r.checks=r.checks+1; r.next=now+p.retryMilliseconds
 local encoded=cjson.encode(r)
 if #encoded>131072 or #encoded>r.bytes then return {'unknown'} end
 redis.call('SET',KEYS[1],encoded)
 if r.checks<p.maximumChecks then redis.call('ZADD',KEYS[3],r.next,r.id) else redis.call('ZREM',KEYS[3],r.id) end
 return {'settlement',encoded}
else return {'unknown'} end`;

type FoundOrigin = NonNullable<Awaited<ReturnType<typeof readConfirmationOrigin>>>;
function knownPhysicalPayment(session: ProviderSession): boolean {
  if (session.status !== "complete" || !Number.isSafeInteger(session.amount_total) || Number(session.amount_total) < 0) return false;
  if (session.amount_total === 0) return session.payment_status === "no_payment_required";
  const payment = data(session.payment_intent), charge = data(payment?.latest_charge);
  // Missing or unexpanded refund evidence does not prove an unrefunded order.
  return session.payment_status === "paid" && payment?.object === "payment_intent" && payment.status === "succeeded" &&
    payment.amount_received === session.amount_total && payment.currency === session.currency && charge?.object === "charge" &&
    charge.paid === true && charge.amount === session.amount_total && charge.currency === session.currency && charge.refunded === false &&
    Number.isSafeInteger(charge.amount_refunded) && Number(charge.amount_refunded) >= 0 && Number(charge.amount_refunded) < Number(charge.amount) &&
    !refundedInFull(payment);
}
function preparedMessage(found: FoundOrigin): ConfirmationOriginPayload["message"] | null {
  const message = data(found.payload.message);
  if (!message || Object.keys(message).length !== 5 || !["from", "to", "subject", "text", "replyTo"].every(key => typeof message[key] === "string") ||
      hash(String(message.to).trim().toLowerCase()) !== found.row.person || !Number.isSafeInteger(found.payload.paidCents) || Number(found.payload.paidCents) < 0 ||
      !found.row.session || !found.payload.settlementToken) return null;
  return message as ConfirmationOriginPayload["message"];
}
async function confirmationMutation(op: string, found: { row: Pick<ConfirmationOrigin, "id" | "statsId" | "person">; raw: string }, p: ShipmentMailPolicy | null, runtime: ShipmentMailRuntime, owner = ""): Promise<unknown[] | null> {
  try {
    const reply = array(await (runtime.pipeline ?? redisPipeline)([["EVAL", SHIPMENT_MAIL_SCRIPT, 10, ...keys(found.row), op, found.raw, "",
      (runtime.now ?? Date.now)(), SHIPMENT_MAIL_MAX_ROW_BYTES, JSON.stringify(p), owner]]));
    return reply?.length === 1 ? array(reply[0]) : null;
  } catch { return null; }
}
async function preparePaid(found: FoundOrigin, p: ShipmentMailPolicy, runtime: ConfirmationOriginRuntime, owner: string): Promise<FoundOrigin | null> {
  const session = await readProviderSession(found, found.row.session, runtime, true);
  if (!session || session.id !== found.row.session || !knownPhysicalPayment(session)) return null;
  const store = data(found.payload.snapshot.store), product = data(found.payload.snapshot.product);
  if (!store || !product || store.statsId !== found.row.statsId || store.stripeAccountId !== found.row.accountId) return null;
  const letter = found.row.originKind === "single_digital"
    ? await singleDigitalMessage(store as unknown as Store, product as unknown as Listing, session, p)
    : originalPhysicalConfirmation(store as unknown as Store, session as SessionRecord, product as unknown as Listing);
  if (!letter || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(letter.to) || letter.to.length > 320 || typeof store.email !== "string") return null;
  const payload = { ...found.payload, paidCents: Number(session.amount_total),
    ...("accessUrl" in letter ? { accessUrl: letter.accessUrl } : {}),
    message: { to: letter.to, subject: letter.subject, text: letter.text, from: fromStore(store as unknown as Store), replyTo: store.email } };
  const plain = JSON.stringify(payload);
  if (Buffer.byteLength(plain) > p.maxPayloadBytes) return null;
  const row = { ...found.row, phase: "queued" as const, person: hash(letter.to.trim().toLowerCase()), sealed: seal(plain, context(found.row.id)), fingerprint: hash(plain) };
  const raw = JSON.stringify(row);
  if (!parse(raw)) return null;
  try {
    const reply = array(await (runtime.pipeline ?? redisPipeline)([["EVAL", CONFIRMATION_PAID_SCRIPT, 12, ...keys(found.row),
      `nl:order-confirmation:person:${row.statsId}:${row.person}`, `nl:order-confirmation:erased:${row.statsId}:${row.person}`,
      "paid", found.raw, raw, (runtime.now ?? Date.now)(), owner, JSON.stringify(p)]]));
    const receipt = reply?.length === 1 ? array(reply[0]) : null;
    if (receipt?.[0] === "erased") {
      // The exact original source has now identified this previously erased
      // person. Remove its protected payload instead of retaining identified
      // personal data just because no confirmation may be sent. Lost/changed
      // cancellation ACK stays unknown and cannot authorize dispatch.
      await confirmationMutation("cancel", found, null, runtime);
      return null;
    }
    if (receipt?.[0] !== "paid") return null;
    const saved = await readConfirmationOrigin(row.id, runtime);
    return saved && saved.row.owner === owner && preparedMessage(saved) ? saved : null;
  } catch { return null; }
}

/** This slice handles only original simple physical checkouts. It never
 * creates a checkout in a cron pass, reads a current catalog, or treats a
 * provider's missing answer as failure. All other producers remain legacy.
 */
export async function runOrderConfirmationMail(deadline: number, dispatch: ShipmentMailDispatch, runtime: ConfirmationOriginRuntime = {}, onlyId?: string): Promise<{ accepted: number; waiting: number; unknown: number }> {
  const counts = { accepted: 0, waiting: 0, unknown: 0 }, now = runtime.now ?? Date.now;
  const started = performance.now(), currentTime = now();
  if (!Number.isSafeInteger(deadline) || !Number.isSafeInteger(currentTime) || deadline <= currentTime) return counts;
  const monotonicDeadline = started + deadline - currentTime;
  const expired = () => now() >= deadline || performance.now() >= monotonicDeadline;
  const p = confirmationOutboxPolicy(runtime, false);
  if (!p) return { ...counts, unknown: 1 };
  const pipeline = runtime.pipeline ?? redisPipeline;
  if (onlyId === undefined && p.recovery) await recoverPendingMail("confirmation", deadline, runtime, async id => {
    try {
      const reply = array(await pipeline([["TYPE", confirmationOriginRowKey(id)], ["GETRANGE", confirmationOriginRowKey(id), 0, SHIPMENT_MAIL_MAX_ROW_BYTES], ["GETRANGE", sourceKey(id), 0, 8192]]));
      if (!reply || reply.length !== 3 || typeof reply[1] !== "string") return null;
      if (reply[0] === "none" && reply[1] === "") return { raw: "" };
      if (reply[0] !== "string" || Buffer.byteLength(reply[1]) > SHIPMENT_MAIL_MAX_ROW_BYTES) return null;
      const row = parse(reply[1]);
      if (!row) { const renewal = decodeRenewal(reply[1], reply[2]); return renewal?.row.id === id ? { raw: reply[1], keys: keys(renewal.row) } : { raw: reply[1] }; }
      if (row.id !== id || row.originKind === "course") return { raw: reply[1] };
      if (reply[2] !== row.sourceValue) return { raw: reply[1] };
      const opened = unseal(row.sealed, context(id));
      if (!opened.ok || hash(opened.value) !== row.fingerprint) return { raw: reply[1] };
      const payload = data(JSON.parse(opened.value));
      if (!payload || typeof payload.body !== "string" || confirmationBodyDigest(payload.body) !== row.bodyDigest ||
          typeof payload.preintentToken !== "string" || hash(payload.preintentToken) !== row.intentFingerprint ||
          payload.intentFingerprint !== row.intentFingerprint || !data(payload.snapshot)) return { raw: reply[1] };
      if (!physicalOriginCovered({ row, payload: payload as unknown as ConfirmationOriginPayload }, p, now())) return { raw: reply[1] };
      return { raw: reply[1], keys: keys(row) };
    } catch { return null; }
  });
  let ids: unknown[] | null;
  try {
    if (onlyId !== undefined) { if (!HASH.test(onlyId)) throw Error("Unknown confirmation"); ids = [onlyId]; }
    else {
      const got = array(await pipeline([["TYPE", CONFIRMATION_ORIGIN_DUE], ["ZRANGEBYSCORE", CONFIRMATION_ORIGIN_DUE, 0, now(), "LIMIT", 0, 25]]));
      ids = got?.length === 2 && ["none", "zset"].includes(String(got[0])) ? array(got[1], 25) : null;
    }
    if (!ids || ids.some(id => typeof id !== "string" || !HASH.test(id)) || new Set(ids).size !== ids.length) throw Error("Unknown confirmation index");
  } catch { return { ...counts, unknown: 1 }; }
  for (const id of ids) {
    if (expired()) break;
    const renewal: { found?: RenewalFound } = {};
    let found = await readOrigin(String(id), runtime, renewal);
    if (renewal.found) {
      try { await processRenewal(renewal.found, p, runtime, dispatch, expired, counts); }
      catch { counts.unknown++; } // retain source/lease and allow other paid work to proceed
      continue;
    }
    if (found?.row.originKind === "course") { counts.unknown++; continue; }
    if (!found || found.row.accountId === DEMO_CONNECTED_ACCOUNT) { counts.unknown++; continue; }
    if (!physicalOriginCovered(found, p, now())) { counts.unknown++; continue; }
    if (found.row.originKind === "single_digital" && (!p.coveredOrigins?.includes("single-digital-confirmation") || now() >= found.row.expiresAt)) { counts.unknown++; continue; }
    // A previous accepted outcome is never dispatched again. Its complete
    // protected source survives until original accounting is acknowledged.
    if (found.row.originKind === "single_digital" && found.row.phase === "accepted" && !singleDigitalAccessCovered(p)) { counts.unknown++; continue; }
    if (found.row.phase === "accepted") {
      let receipt: unknown[] | null = null;
      try {
        const reply = array(await pipeline([["EVAL", CONFIRMATION_PAID_SCRIPT, 12, ...keys(found.row), keys(found.row)[4], keys(found.row)[9],
          "settlement", found.raw, "", now(), "", JSON.stringify(p)]]));
        receipt = reply?.length === 1 ? array(reply[0]) : null;
      } catch { /* No acknowledged retry, no financial mutation. */ }
      if (receipt?.[0] !== "settlement") { counts.unknown++; continue; }
      found = await readConfirmationOrigin(String(id), runtime);
      if (!found || found.row.phase !== "accepted") { counts.unknown++; continue; }
      const settled = preparedMessage(found) && await commitOrderConfirmationSettlement(found.payload.snapshot.store as Store,
        `checkout:${found.row.session}`, found.payload.settlementToken!, found.payload.paidCents!, { now, pipeline });
      if (settled === "committed" || settled === "already") await confirmationMutation("cancel", found, null, runtime);
      counts.unknown++; continue;
    }
    const owner = randomBytes(24).toString("hex");
    const claimed = await confirmationMutation("claim", found, p, runtime, owner);
    if (claimed?.[0] !== "preparing") { counts.unknown++; continue; }
    found = await readConfirmationOrigin(String(id), runtime);
    if (expired() || !found || found.row.owner !== owner || found.row.state !== "preparing") { counts.unknown++; continue; }
    if (!found.row.session) {
      await recoverCreation(found, runtime); // Read-only even after a lost creation ACK.
      const current = await readConfirmationOrigin(String(id), runtime);
      if (current?.row.owner === owner) await confirmationMutation("defer", current, p, runtime, owner);
      counts.waiting++; continue;
    }
    // Finding the source is not proof that its original file can still be
    // delivered. Keep the exact rights and reservation; no stale thanks URL,
    // 40-entry purchase list, paid settlement or receipt can substitute for it.
    if (found.row.originKind === "single_digital" && !singleDigitalAccessCovered(p)) {
      await confirmationMutation("defer", found, p, runtime, owner); counts.waiting++; continue;
    }
    if (found.row.phase === "awaiting_payment" || found.row.originKind === "single_digital" && found.row.phase === "queued") found = await preparePaid(found, p, runtime, owner);
    if (!found || !preparedMessage(found)) {
      const current = await readConfirmationOrigin(String(id), runtime);
      if (current?.row.owner === owner) await confirmationMutation("defer", current, p, runtime, owner);
      counts.waiting++; continue;
    }
    const message = preparedMessage(found)!;
    const settled = await commitOrderConfirmationSettlement(found.payload.snapshot.store as Store,
      `checkout:${found.row.session}`, found.payload.settlementToken!, found.payload.paidCents!, { now, pipeline });
    let barrier = false;
    const beforePost = async () => {
      if (barrier || expired() || !physicalOriginCovered(found!, confirmationOutboxPolicy(runtime, false), now())) return false;
      // A queued email may have waited through a refund. Recheck the original
      // account immediately before its permanent dispatch barrier; never use
      // the old paid checkout status alone as present refund evidence.
      const current = await readProviderSession(found!, found!.row.session, runtime, true);
      if (!current || current.id !== found!.row.session || !knownPhysicalPayment(current) || current.amount_total !== found!.payload.paidCents || expired()) return false;
      if (!physicalOriginCovered(found!, confirmationOutboxPolicy(runtime, false), now())) return false;
      if (found!.row.originKind === "single_digital") {
        if (typeof found!.payload.accessUrl !== "string") return false;
        const url = new URL(found!.payload.accessUrl);
        const originalStore = found!.payload.snapshot.store as Store;
        const currentStore = await storeForEmail(storeRef(originalStore));
        if (!currentStore || !(await readSingleDigitalAccess(currentStore, url.searchParams.get("token") ?? "", url.searchParams.get("origin") ?? ""))) return false;
      }
      const changed = await confirmationMutation("dispatch", found!, p, runtime, owner);
      if (changed?.[0] !== "dispatching") return false;
      const row = parse(changed[1]);
      if (!row || row.owner !== owner) return false;
      found = { ...found!, row, raw: String(changed[1]) }; barrier = true; return true;
    };
    let outcome: Awaited<ReturnType<ShipmentMailDispatch>> = "unknown";
    try { outcome = await dispatch(message, beforePost, { id: found.row.id }); } catch { /* Keep the permanent barrier. */ }
    if (!barrier) {
      await confirmationMutation("defer", found, p, runtime, owner);
      counts.waiting++; continue;
    }
    if (outcome === "accepted" && settled !== "committed" && settled !== "already") {
      try {
        await pipeline([["EVAL", CONFIRMATION_PAID_SCRIPT, 12, ...keys(found.row), keys(found.row)[4], keys(found.row)[9],
          "accepted", found.raw, "", now(), owner, JSON.stringify(p)]]);
      } catch { /* Dispatch barrier and accounting evidence are still retained. */ }
      counts.unknown++; continue;
    }
    if (outcome === "unknown" || outcome === "waiting") { counts.unknown++; continue; }
    const changed = await confirmationMutation(outcome === "accepted" ? "accepted" : outcome === "not_accepted" ? "not-accepted" : "refused", found, p, runtime, owner);
    if (outcome === "accepted" && changed?.[0] === "accepted") counts.accepted++;
    else if (outcome === "not_accepted" && changed?.[0] === "queued") counts.waiting++;
    else counts.unknown++;
  }
  return counts;
}

/** A per-request snapshot owns only already-existing origins. Each unresolved
 * origin carries at most64 recipient hashes inside its already-reserved fixed
 * row envelope; no global indefinite recipient registry or extra unpaid slot.
 * On saturation the source stays held, never discarded or dispatched.
 */
export const CONFIRMATION_ERASURE_SCRIPT = `-- marktmorgen:confirmation-erasure:v1
local op,token,person,store=ARGV[1],ARGV[2],ARGV[3],ARGV[4]
if type(token)~='string' or #token~=48 or string.find(token,'[^a-f0-9]') then return {'unknown'} end
if op=='begin' then
 local a,b=redis.call('TYPE',KEYS[1]).ok,redis.call('TYPE',KEYS[2]).ok
 if b~='none' and b~='string' then return {'unknown'} end
 -- Install protection before touching a possibly corrupt/incomplete index.
 -- Unknown cleanup retains this dedicated fence without a fixed expiry.
 redis.call('SET',KEYS[2],token)
 if a~='none' and a~='set' then return {'unknown'} end
 local count=redis.call('SCARD',KEYS[1])
 if count>10000 then return {'unknown'} end
 local ids=redis.call('SMEMBERS',KEYS[1])
 if #ids~=count then return {'unknown'} end
 for _,id in ipairs(ids) do if #id~=64 or string.find(id,'[^a-f0-9]') then return {'unknown'} end end
 return {'begun',ids}
elseif op=='finish' then
 if redis.call('TYPE',KEYS[1]).ok~='string' or redis.call('GET',KEYS[1])~=token then return {'changed'} end
 redis.call('PEXPIRE',KEYS[1],600000)
 return {'finished'}
elseif op~='mark' or #person~=64 or string.find(person,'[^a-f0-9]') then return {'unknown'} end
if redis.call('TYPE',KEYS[3]).ok~='string' or redis.call('GET',KEYS[3])~=token then return {'changed'} end
local rowType=redis.call('TYPE',KEYS[1]).ok
if rowType=='none' then return {'absent'} end
if rowType~='string' or redis.call('TYPE',KEYS[2]).ok~='string' then return {'unknown'} end
local raw=redis.call('GETRANGE',KEYS[1],0,131072)
local ok,r=pcall(cjson.decode,raw)
if #raw>131072 or not ok or type(r)~='table' or r.kind~='confirmation' or r.statsId~=store or redis.call('GET',KEYS[2])~=r.sourceValue then return {'unknown'} end
if r.person==person then return {'matched'} end
-- A resolved different buyer needs no retained hash for this request.
if r.phase~='course_reserved' and r.phase~='awaiting_creation' and r.phase~='creating' and r.phase~='creation_unknown' and r.phase~='awaiting_payment' then return {'other'} end
if type(r.erasedPeople)~='string' or #r.erasedPeople>4096 or #r.erasedPeople%64~=0 or string.find(r.erasedPeople,'[^a-f0-9]') or type(r.erasureSaturated)~='boolean' then return {'unknown'} end
for i=1,#r.erasedPeople,64 do if string.sub(r.erasedPeople,i,i+63)==person then return {'marked'} end end
if #r.erasedPeople==4096 then r.erasureSaturated=true else r.erasedPeople=r.erasedPeople..person end
local encoded=cjson.encode(r)
if #encoded>131072 or type(r.bytes)~='number' or #encoded>r.bytes then return {'unknown'} end
redis.call('SET',KEYS[1],encoded)
return {'marked'}`;

/** A recipient fence defeats a concurrent bind/dispatch while every unresolved
 * older origin is marked durably. Completing cleanup shortens only THIS
 * request's fence; it cannot expire another concurrent request's protection.
 * Never-activated deployments perform no new IO, including during erasure.
 */
export async function forgetOrderConfirmationMail(statsId: string | null | undefined, email?: string, runtime: ShipmentMailRuntime = {}): Promise<number> {
  const lifecycle = runtime.lifecycle ?? CURRENT_SHIPMENT_MAIL_LIFECYCLE;
  if (lifecycle === "never_activated") return 0;
  if (!["active", "retired"].includes(lifecycle)) throw Error("Confirmation cleanup lifecycle is unknown");
  if (!statsId) return 0;
  if (!STORE.test(statsId)) throw Error("Confirmation cleanup owner is unknown");
  const person = email === undefined ? null : hash(email.trim().toLowerCase());
  const index = `nl:order-confirmation:store:${statsId}`;
  const fence = person === null ? `nl:order-confirmation:closed:${statsId}` : `nl:order-confirmation:erased:${statsId}:${person}`;
  const pipeline = runtime.pipeline ?? redisPipeline, token = randomBytes(24).toString("hex");
  const begun = array(await pipeline([["EVAL", CONFIRMATION_ERASURE_SCRIPT, 2, index, fence, "begin", token, person ?? "", statsId]]));
  const snapshot = begun?.length === 1 ? array(begun[0], 2) : null;
  const members = snapshot?.length === 2 && snapshot[0] === "begun" ? array(snapshot[1], confirmationOriginIndexLimit) : null;
  if (!members || members.some(id => typeof id !== "string" || !HASH.test(id)) || new Set(members).size !== members.length) throw Error("Confirmation erasure snapshot is unknown");
  let deleted = 0;
  for (const id of members) {
    if (person !== null) {
      const got = array(await pipeline([["EVAL", CONFIRMATION_ERASURE_SCRIPT, 3, confirmationOriginRowKey(String(id)), sourceKey(String(id)), fence, "mark", token, person, statsId]]));
      const marked = got?.length === 1 ? array(got[0]) : null;
      if (["marked", "other", "absent"].includes(String(marked?.[0]))) continue;
      if (marked?.[0] !== "matched") throw Error("Confirmation unresolved-recipient erasure is unknown");
    }
    // Re-read after the atomic mark: a competing bind cannot substitute the
    // recipient, and a concurrent removal needs no second release of capacity.
    const renewal: { found?: RenewalFound } = {};
    const found = await readOrigin(String(id), runtime, renewal) ?? renewal.found;
    if (!found || found.row.statsId !== statsId || person !== null && found.row.person !== person ||
        (await confirmationMutation("cancel", found, null, runtime))?.[0] !== "canceled") throw Error("Confirmation erasure is unknown");
    deleted++;
  }
  const finished = array(await pipeline([["EVAL", CONFIRMATION_ERASURE_SCRIPT, 1, fence, "finish", token, person ?? "", statsId]]));
  const receipt = finished?.length === 1 ? array(finished[0]) : null;
  if (receipt?.length !== 1 || receipt[0] !== "finished") throw Error("Confirmation erasure completion is unknown");
  return deleted;
}


/** A renewal is an inbox-proof request, not another sale. It shares the
 * existing bounded custody pool and source/index/erasure families, without
 * creating a checkout, original admission, order count or settlement token. */
type RenewalRow = {
  kind: "confirmation"; originKind: "single_digital_renewal"; purpose: "single-digital-access-renewal";
  id: string; statsId: string; nonce: string; person: string; accountId: string; capsuleDigest: string;
  sourceValue: string; sealed: string; fingerprint: string; bytes: number;
  created: number; authorizedAt: number; next: number; state: "queued" | "preparing" | "dispatching" | "refused";
  phase: "renewal_queued"; owner: string; leaseUntil: number; checks: number; reviewId: string;
};
type RenewalPayload = { capsule: string; storeRef: string; draft?: SingleDigitalRenewalDraft };
type RenewalFound = { row: RenewalRow; raw: string; payload: RenewalPayload };
function decodeRenewal(raw: unknown, source: unknown): RenewalFound | null {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > SHIPMENT_MAIL_MAX_ROW_BYTES) return null;
    const r = data(JSON.parse(raw));
    const names = ["kind","originKind","purpose","id","statsId","nonce","person","accountId","capsuleDigest","sourceValue","sealed","fingerprint","bytes","created","authorizedAt","next","state","phase","owner","leaseUntil","checks","reviewId"];
    if (!r || Object.keys(r).length !== names.length || names.some(k => !Object.hasOwn(r,k)) || r.kind !== "confirmation" || r.originKind !== "single_digital_renewal" || r.purpose !== "single-digital-access-renewal" ||
      ![r.id,r.nonce,r.person,r.capsuleDigest,r.fingerprint].every(v => typeof v === "string" && HASH.test(v)) || typeof r.statsId !== "string" || !STORE.test(r.statsId) ||
      typeof r.accountId !== "string" || !ACCOUNT.test(r.accountId) || typeof r.sourceValue !== "string" || source !== r.sourceValue || typeof r.sealed !== "string" ||
      typeof r.reviewId !== "string" || !r.reviewId || r.phase !== "renewal_queued" || !["queued","preparing","dispatching","refused"].includes(String(r.state)) ||
      typeof r.owner !== "string" || !/^[a-f0-9]{0,48}$/.test(r.owner) ||
      ![r.bytes,r.created,r.authorizedAt,r.next,r.leaseUntil,r.checks].every(v => typeof v === "number" && Number.isSafeInteger(v) && v >= 0) || Number(r.bytes) < Buffer.byteLength(raw)) return null;
    if (r.id !== hash(`single-digital-renewal\n${r.statsId}\n${r.nonce}`) || r.sourceValue !== JSON.stringify({ kind:"confirmation", originKind:"single_digital_renewal", purpose:r.purpose, nonce:r.nonce, accountId:r.accountId, capsuleDigest:r.capsuleDigest })) return null;
    const opened = unseal(r.sealed, context(String(r.id)));
    if (!opened.ok || hash(opened.value) !== r.fingerprint) return null;
    const payload = data(JSON.parse(opened.value));
    if (!payload || typeof payload.capsule !== "string" || hash(payload.capsule) !== r.capsuleDigest || typeof payload.storeRef !== "string" || !payload.storeRef || payload.storeRef.length > 320 ||
      Object.keys(payload).some(k => !["capsule","storeRef","draft"].includes(k))) return null;
    return { row: r as unknown as RenewalRow, raw, payload: payload as unknown as RenewalPayload };
  } catch { return null; }
}
export async function readSingleDigitalRenewalOrigin(id: string, runtime: ShipmentMailRuntime = {}): Promise<RenewalFound | null> {
  const capture: { found?: RenewalFound } = {};
  await readOrigin(id, runtime, capture); return capture.found ?? null;
}
export async function enqueueSingleDigitalRenewal(store: Store, capsule: string, requestNonce: string, runtime: ConfirmationOriginRuntime = {}): Promise<{ ok:true; id:string } | { ok:false }> {
  const p = confirmationOutboxPolicy(runtime);
  if (!p || !singleDigitalRenewalCovered(p) || !canSeal() || !HASH.test(requestNonce)) return { ok:false };
  const identity = singleDigitalRenewalIdentity(store, capsule);
  if (!identity || !store.statsId) return { ok:false };
  try { if (!(await verifySingleDigitalRenewal(store, capsule))) return { ok:false }; } catch { return {ok:false}; }
  const pipeline = runtime.pipeline ?? redisPipeline, now = await serverNow(pipeline);
  if (now === null || Math.abs(now-(runtime.now??Date.now)()) > 60_000) return { ok:false };
  const id = hash(`single-digital-renewal\n${store.statsId}\n${requestNonce}`), person = hash(identity.email), capsuleDigest = hash(capsule);
  const payload: RenewalPayload = { capsule, storeRef:storeRef(store) }, plain = JSON.stringify(payload);
  if (Buffer.byteLength(plain) > p.maxPayloadBytes) return { ok:false };
  const row: RenewalRow = { kind:"confirmation", originKind:"single_digital_renewal", purpose:"single-digital-access-renewal", id, statsId:store.statsId, nonce:requestNonce,
    person, accountId:identity.accountId, capsuleDigest, sourceValue:JSON.stringify({kind:"confirmation",originKind:"single_digital_renewal",purpose:"single-digital-access-renewal",nonce:requestNonce,accountId:identity.accountId,capsuleDigest}),
    sealed:seal(plain,context(id)), fingerprint:hash(plain), bytes:0, created:now, authorizedAt:now, next:now, state:"queued",phase:"renewal_queued",owner:"",leaseUntil:0,checks:0,reviewId:p.reviewId };
  row.bytes = SHIPMENT_MAIL_MAX_ROW_BYTES + keys(row).reduce((n,k)=>n+Buffer.byteLength(k),0)*2+16_384;
  const raw = JSON.stringify(row);
  try {
    const response = array(await pipeline([["EVAL", SHIPMENT_MAIL_SCRIPT,10,...keys(row),"enqueue","",raw,now,SHIPMENT_MAIL_MAX_ROW_BYTES,JSON.stringify(p),""]]));
    const receipt = response?.length === 1 ? array(response[0]) : null;
    if (!receipt || !["queued","existing"].includes(String(receipt[0]))) return { ok:false };
    const found = await readSingleDigitalRenewalOrigin(id,runtime);
    return found && found.row.capsuleDigest === capsuleDigest && found.row.person === person && found.row.sourceValue === row.sourceValue ? {ok:true,id} : {ok:false};
  } catch { return {ok:false}; }
}
async function processRenewal(initial: RenewalFound, p: ShipmentMailPolicy, runtime: ConfirmationOriginRuntime, dispatch: ShipmentMailDispatch,
 expired: ()=>boolean, counts: {accepted:number;waiting:number;unknown:number}): Promise<void> {
  if (!singleDigitalRenewalCovered(p)) { counts.unknown++; return; }
  const owner = randomBytes(24).toString("hex");
  if ((await confirmationMutation("claim",initial,p,runtime,owner))?.[0] !== "preparing") {counts.unknown++;return;}
  let found = await readSingleDigitalRenewalOrigin(initial.row.id,runtime);
  if (!found || expired() || found.row.owner !== owner || found.row.state !== "preparing") {counts.unknown++;return;}
  const current = await storeForEmail(found.payload.storeRef);
  const verified = current ? await verifySingleDigitalRenewal(current,found.payload.capsule) : null;
  if (!verified || verified.claim.accountId !== found.row.accountId || hash(verified.claim.email) !== found.row.person) {
    await confirmationMutation("defer",found,p,runtime,owner);counts.waiting++;return;
  }
  const draft = singleDigitalRenewalDraft(verified.store,found.payload.capsule,verified.claim);
  const plain = JSON.stringify({...found.payload,draft});
  if (Buffer.byteLength(plain)>p.maxPayloadBytes) {await confirmationMutation("defer",found,p,runtime,owner);counts.waiting++;return;}
  const next = {...found.row,sealed:seal(plain,context(found.row.id)),fingerprint:hash(plain)}, raw=JSON.stringify(next);
  const reply = array(await (runtime.pipeline??redisPipeline)([["EVAL",SHIPMENT_MAIL_SCRIPT,10,...keys(next),"renewal-prepare",found.raw,raw,(runtime.now??Date.now)(),SHIPMENT_MAIL_MAX_ROW_BYTES,JSON.stringify(p),owner]]));
  if (reply?.length!==1 || array(reply[0])?.[0]!=="prepared") {counts.unknown++;return;}
  found=await readSingleDigitalRenewalOrigin(next.id,runtime);
  if (!found || found.raw!==raw || expired()) {counts.unknown++;return;}
  let barrier=false;
  const beforePost=async()=>{
    if(barrier || expired() || !singleDigitalRenewalCovered(confirmationOutboxPolicy(runtime,false)))return false;
    const store=await storeForEmail(found!.payload.storeRef);
    const proof=store?await verifySingleDigitalRenewal(store,found!.payload.capsule):null;
    if(!proof || hash(proof.claim.email)!==found!.row.person || proof.claim.accountId!==found!.row.accountId || expired())return false;
    if(!(await activateSingleDigitalRenewal(proof.store,found!.payload.capsule,draft)) || expired())return false;
    const changed=await confirmationMutation("dispatch",found!,p,runtime,owner);
    if(changed?.[0]!=="dispatching")return false;
    const saved=await readSingleDigitalRenewalOrigin(found!.row.id,runtime);
    if(!saved || saved.row.state!=="dispatching" || saved.row.owner!==owner || expired())return false;
    found=saved;barrier=true;return true;
  };
  let outcome:Awaited<ReturnType<ShipmentMailDispatch>>="unknown";
  try{outcome=await dispatch(draft.message,beforePost,{id:found.row.id});}catch{/* Retain original request and any permanent barrier. */}
  if(!barrier){await confirmationMutation("defer",found,p,runtime,owner);counts.waiting++;return;}
  if(outcome==="unknown" || outcome==="waiting"){counts.unknown++;return;}
  const changed=await confirmationMutation(outcome==="accepted"?"accepted":outcome==="not_accepted"?"not-accepted":"refused",found,p,runtime,owner);
  if(outcome==="accepted" && changed?.[0]==="accepted")counts.accepted++;else if(outcome==="not_accepted" && changed?.[0]==="queued")counts.waiting++;else counts.unknown++;
}

/** One person's linked originals only. No provider call, lease or mutation.
 * Unbound sources contain no identified recipient and cannot be disclosed to
 * an arbitrary address. Kept erasure/accounting marks are described separately. */
export async function orderConfirmationMailOf(statsId: string, email: string, runtime: ShipmentMailRuntime = {}): Promise<unknown[]> {
  const lifecycle = runtime.lifecycle ?? CURRENT_SHIPMENT_MAIL_LIFECYCLE;
  if (lifecycle === "never_activated") return [];
  if (!["active", "retired"].includes(lifecycle) || !STORE.test(statsId) || !email.trim()) throw Error("Confirmation copy ownership is unknown");
  const person = hash(email.trim().toLowerCase()), index = `nl:order-confirmation:person:${statsId}:${person}`, pipeline = runtime.pipeline ?? redisPipeline;
  const counts = array(await pipeline([["TYPE", index], ["SCARD", index]]));
  if (!counts || counts.length !== 2 || !["none", "set"].includes(String(counts[0])) || typeof counts[1] !== "number" || !Number.isSafeInteger(counts[1]) || counts[1] < 0 || counts[1] > confirmationOriginIndexLimit) throw Error("Confirmation copy index is unknown");
  if (counts[0] === "none" && counts[1] === 0) return [];
  const reply = array(await pipeline([["SMEMBERS", index]])), ids = reply?.length === 1 ? array(reply[0], confirmationOriginIndexLimit) : null;
  if (!ids || ids.length !== counts[1] || ids.some(id => typeof id !== "string" || !HASH.test(id)) || new Set(ids).size !== ids.length) throw Error("Confirmation copy index is incomplete");
  const out: unknown[] = [];
  for (const id of ids) {
    const found = await readOrigin(String(id), runtime);
    if (!found) {
      const renewal = await readSingleDigitalRenewalOrigin(String(id), runtime);
      if (!renewal || renewal.row.statsId !== statsId || renewal.row.person !== person) throw Error("Confirmation copy source is unknown");
      const message = renewal.payload.draft?.message;
      if (message && hash(message.to.trim().toLowerCase()) !== person) throw Error("Confirmation copy recipient is unknown");
      out.push({ purpose: renewal.row.purpose, phase: renewal.row.phase, created: renewal.row.created,
        ...(message ? { subject: message.subject, text: message.text } : {}) });
      continue;
    }
    if (found.row.statsId !== statsId || found.row.person !== person) throw Error("Confirmation copy source is unknown");
    const message = found.payload.message;
    if (message && hash(message.to.trim().toLowerCase()) !== person) throw Error("Confirmation copy recipient is unknown");
    out.push({ checkout: found.row.session, phase: found.row.phase, created: found.row.created,
      ...(found.payload.paidCents === undefined ? {} : { paidCents: found.payload.paidCents }),
      ...(message ? { subject: message.subject, text: message.text } : {}) });
  }
  return out;
}
