/** Partial course-v1 construction, deliberately NOT an admitted mail source.
 * No producer/worker consumes this candidate; it creates no checkout, payment,
 * enrollment, token, access grant, email or Redis record. The existing course
 * ledger's first100/refund limitation still blocks durable course admission.
 */
import { createHash } from "node:crypto";
import { HANDLE_PATTERN } from "@/lib/store-handle-pattern";
import { SITE_URL } from "@/lib/site-url";
import { isLanguage } from "@/lib/store-language";
import { CONSENT_WORDS_FINGERPRINT, EU_WITHDRAWAL_CONSENT_VERSION, readConsentMeta } from "@/lib/digital-consent";
import { DIGITAL_CONSENT_WORDS } from "@/lib/buyer-words/digital-consent";
import { consentEmailLines } from "@/lib/digital-consent-email";

const ID = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const ACCOUNT = /^acct_[A-Za-z0-9]{8,64}$/;
const EMAIL = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
// This is a processing bound for an unadmitted pure candidate, not a funded
// allowance. Activation needs its complete body/row/copy/failure envelope.
const candidateBytes = 16_384;

type Identity = Readonly<{ sid: string; statsId: string; accountId: string; productId: string; courseId: string }>;
type Original = Readonly<{ handle: string; storeName: string; ownerEmail: string; title: string; currency: string; language: string; priceCents: number }>;
/** Captured historical template lines only: their wording is NOT proof that
 * access was supplied or that a withdrawal right ended. The missing exact
 * payment/refund/access contract must establish that before any future send. */
type Consent = Readonly<{ metadata: string; version: string; kind: "digital"; at: number; wordsFingerprint: string; checkedSentence: string; emailLines: readonly string[] }>;
export type CourseConfirmationCandidate = Readonly<{
  kind: "course-v1-candidate"; admitted: false;
  /** Input data only. A matching hash is not an authenticated checkout. */
  provenance: "unverified-producer-input";
  identity: Identity; original: Original; consent: Consent;
  metadata: Readonly<Record<string, string>>; publicPath: string; captureFingerprint: string;
}>;
export type CourseDoorCandidate = Readonly<{ kind: "public-course-door-candidate"; grantsAccess: false; location: string }>;

/** Every value is captured from its own data descriptor, once. No getter,
 * inherited field, JSON hook, exotic prototype or symbol supplies evidence. */
function own(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const result: Record<string, unknown> = Object.create(null);
    const keys = Reflect.ownKeys(value);
    if (keys.length > 128) return null;
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !d || !Object.hasOwn(d, "value")) return null;
      result[key] = d.value;
    }
    return result;
  } catch { return null; }
}
function empty(value: unknown): boolean {
  try { return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && Reflect.ownKeys(value).length === 1 && Object.getOwnPropertyDescriptor(value, "length")?.value === 0; }
  catch { return false; }
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}
function id(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
/** Product identifiers are persisted opaque strings (normally10hex; the
 * generator also has a base36 fallback). Never apply the catalog/store UUID
 * grammar to them, rewrite them, or let them become URL syntax. */
function productId(value: unknown): value is string {
  return text(value,128) && value!=="." && value!=="..";
}
function simpleCourse(product: Record<string, unknown>): Record<string, unknown> | null {
  const course = own(product.course);
  if (!course || !id(course.id) || !Number.isSafeInteger(course.lessons) || Number(course.lessons) < 0 ||
      !["call", "podcast", "recurring", "bundle", "keys", "file", "link", "plan", "pwyw", "callPackage", "shipping"].every(key => Object.hasOwn(product, key) && product[key] === null) ||
      product.note !== false || !empty(product.options) || !empty(product.fields)) return null;
  return course;
}
function publicPath(identity: Identity): string {
  return `/open/${identity.sid}/course/${encodeURIComponent(identity.productId)}?course=${identity.courseId}`;
}
/** Encode captured data without invoking own/inherited JSON hooks. Primitive
 * string escaping uses JSON itself; objects are walked through descriptors. */
function encoded(value: unknown, depth = 0, budget = { remaining: 256 }): string {
  if (--budget.remaining < 0 || depth > 8) throw Error("Course candidate is too complex");
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    const descriptors=Object.getOwnPropertyDescriptors(value) as unknown as Record<string,PropertyDescriptor>,length=descriptors.length.value;
    if(Object.getPrototypeOf(value)!==Array.prototype || !Number.isSafeInteger(length) || Number(length)>128 || Reflect.ownKeys(value).length!==Number(length)+1)throw Error("Course candidate list is unknown");
    const parts:string[]=[];
    for(let i=0;i<Number(length);i++){
      const d=descriptors[i];if(!d || !Object.hasOwn(d,"value"))throw Error("Course candidate list getter");
      parts.push(encoded(d.value,depth+1,budget));
    }
    return `[${parts.join(",")}]`;
  }
  const record=own(value);if(!record)throw Error("Course candidate is not plain data");
  return `{${Object.keys(record).map(key=>`${JSON.stringify(key)}:${encoded(record[key],depth+1,budget)}`).join(",")}}`;
}
function fingerprint(value: unknown): string { return createHash("sha256").update(encoded(value)).digest("hex"); }

/** Capture the exact original title and known consent version/words now.
 * The caller's input is NOT proof of an admitted order or authentic consent.
 * Future integration must bind it to the original preintent/body/account and
 * prove paid access beyond Stripe's first100 without a recorded-ledger bypass.
 */
/** Product input is the complete readProduct result: readListing omits fields
 * and cannot prove this strict no-variants/no-custom-fields category. */
export function captureCourseConfirmationCandidate(storeValue: unknown, productValue: unknown, metadataValue: unknown): CourseConfirmationCandidate | null {
  try {
    const store = own(storeValue), product = own(productValue), meta = own(metadataValue);
    if (!store || !product || !meta) return null;
    const course = simpleCourse(product);
    if (!course || !id(store.sid) || !id(store.statsId) || typeof store.stripeAccountId !== "string" || !ACCOUNT.test(store.stripeAccountId) ||
        typeof store.handle !== "string" || !HANDLE_PATTERN.test(store.handle) || !text(store.name, 300) || !text(store.email, 320) || !EMAIL.test(store.email) ||
        !isLanguage(store.language) || typeof store.currency !== "string" || !/^[a-z]{3}$/.test(store.currency) ||
        !productId(product.id) || !text(product.title, 1_000) || !Number.isSafeInteger(product.priceCents) || Number(product.priceCents) <= 0) return null;
    const names = Object.keys(meta), allowed = new Set(["store", "product", "dc", "mm_admit"]);
    if (names.length < 3 || names.some(key => !allowed.has(key) || typeof meta[key] !== "string" || Buffer.byteLength(String(meta[key])) > 500) ||
        meta.store !== store.handle || meta.product !== product.id) return null;
    const metadata = Object.freeze(Object.fromEntries(names.sort().map(key => [key, String(meta[key])])));
    const kept = readConsentMeta(metadata);
    if (!kept || kept.kind !== "digital" || kept.version !== EU_WITHDRAWAL_CONSENT_VERSION || !Number.isSafeInteger(kept.at) || kept.at <= 0) return null;
    const lines = consentEmailLines({ language: store.language, currency: store.currency }, metadata);
    if (lines.length !== 2 || !lines[1]) return null;
    const identity: Identity = Object.freeze({ sid: store.sid, statsId: store.statsId, accountId: store.stripeAccountId,
      productId: product.id, courseId: String(course.id) });
    const original: Original = Object.freeze({ handle: store.handle, storeName: store.name, ownerEmail: store.email,
      title: product.title, currency: store.currency, language: store.language, priceCents: Number(product.priceCents) });
    const consent: Consent = Object.freeze({ metadata: String(meta.dc), version: kept.version, kind: "digital", at: kept.at,
      wordsFingerprint: CONSENT_WORDS_FINGERPRINT, checkedSentence: DIGITAL_CONSENT_WORDS[store.language].box.digital,
      emailLines: Object.freeze([...lines]) });
    const captured = { kind: "course-v1-candidate" as const, admitted: false as const, provenance: "unverified-producer-input" as const,
      identity, original, consent, metadata, publicPath: publicPath(identity) };
    const result = Object.freeze({ ...captured, captureFingerprint: fingerprint(captured) });
    return Buffer.byteLength(encoded(result)) <= candidateBytes ? result : null;
  } catch { return null; }
}

/** Only a pure candidate for the public front door. It cannot prove payment
 * or open lessons. Current store/listing MUST be read by stable SID in any
 * future funded caller, with the complete readProduct shape rather than its
 * reduced readListing projection, never by an old/released handle in a URL.
 * This slice intentionally has no such IO caller or accepted review.
 */
export function resolveCourseDoorCandidate(candidateValue: unknown, storeValue: unknown, productValue: unknown): CourseDoorCandidate | null {
  try {
    const candidate = own(candidateValue), store = own(storeValue), product = own(productValue);
    if (!candidate || !store || !product || candidate.kind !== "course-v1-candidate" || candidate.admitted !== false ||
        candidate.provenance !== "unverified-producer-input" || typeof candidate.publicPath !== "string" || typeof candidate.captureFingerprint !== "string" || !HASH.test(candidate.captureFingerprint)) return null;
    const identity = own(candidate.identity), original = own(candidate.original), consent = own(candidate.consent), metadata = own(candidate.metadata);
    if (!identity || !original || !consent || !metadata || !id(identity.sid) || !id(identity.statsId) || !productId(identity.productId) || !id(identity.courseId) ||
        typeof identity.accountId !== "string" || !ACCOUNT.test(identity.accountId) || typeof store.handle !== "string" || !HANDLE_PATTERN.test(store.handle)) return null;
    const exact = (value: Record<string, unknown>, names: string[]) => Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value,key));
    if (!exact(identity,["sid","statsId","accountId","productId","courseId"]) ||
        !exact(original,["handle","storeName","ownerEmail","title","currency","language","priceCents"]) ||
        typeof original.handle!=="string" || !HANDLE_PATTERN.test(original.handle) || !text(original.storeName,300) || !text(original.ownerEmail,320) || !EMAIL.test(original.ownerEmail) ||
        !text(original.title,1000) || typeof original.currency!=="string" || !/^[a-z]{3}$/.test(original.currency) || !isLanguage(original.language) ||
        !Number.isSafeInteger(original.priceCents) || Number(original.priceCents)<=0 ||
        !exact(consent,["metadata","version","kind","at","wordsFingerprint","checkedSentence","emailLines"]) ||
        !text(consent.metadata,500) || !text(consent.version,40) || consent.kind!=="digital" || !Number.isSafeInteger(consent.at) || Number(consent.at)<=0 ||
        typeof consent.wordsFingerprint!=="string" || !HASH.test(consent.wordsFingerprint) || !text(consent.checkedSentence,4000)) return null;
    const metadataNames=Object.keys(metadata),allowed=new Set(["store","product","dc","mm_admit"]);
    if(metadataNames.length<3 || metadataNames.some(key=>!allowed.has(key) || typeof metadata[key]!=="string" || Buffer.byteLength(String(metadata[key]))>500) ||
       metadata.store!==original.handle || metadata.product!==identity.productId || metadata.dc!==consent.metadata) return null;
    const kept=readConsentMeta(metadata as Record<string,string>);
    if(!kept || kept.kind!=="digital" || kept.version!==consent.version || kept.at!==consent.at) return null;
    // Compare the immutable capture without calling its JSON hooks or reading
    // the caller's object again. Unknown shape is never a current identity.
    const fields = ["kind", "admitted", "provenance", "identity", "original", "consent", "metadata", "publicPath", "captureFingerprint"];
    if (Object.keys(candidate).length !== fields.length || !fields.every(key => Object.hasOwn(candidate, key))) return null;
    const lines = consent.emailLines;
    if (!Array.isArray(lines) || Object.getPrototypeOf(lines) !== Array.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(lines) as unknown as Record<string,PropertyDescriptor>;
    if (descriptors.length.value !== 2 || Reflect.ownKeys(lines).length !== 3 || !Object.hasOwn(descriptors[0], "value") || !Object.hasOwn(descriptors[1], "value") ||
        descriptors[0].value !== "" || !text(descriptors[1].value,8000)) return null;
    const capturedConsent = { ...consent, emailLines: [descriptors[0].value, descriptors[1].value] };
    const captured = { kind: candidate.kind, admitted: candidate.admitted, provenance: candidate.provenance,
      identity, original, consent: capturedConsent, metadata, publicPath: candidate.publicPath };
    if (Buffer.byteLength(encoded(captured)) > candidateBytes || fingerprint(captured) !== candidate.captureFingerprint || candidate.publicPath !== publicPath(identity as Identity)) return null;
    const course = simpleCourse(product);
    if (!course || store.sid !== identity.sid || store.statsId !== identity.statsId || store.stripeAccountId !== identity.accountId ||
        product.id !== identity.productId || course.id !== identity.courseId) return null;
    return Object.freeze({ kind: "public-course-door-candidate", grantsAccess: false,
      location: `${SITE_URL}/@${store.handle}/course/${encodeURIComponent(String(identity.productId))}` });
  } catch { return null; }
}

/** No accepted access/funding review exists. Never a request/env switch. */
export function courseConfirmationConstructionState(): Readonly<{ admitted: false; accessReview: null; fundingReview: null }> {
  return Object.freeze({ admitted: false, accessReview: null, fundingReview: null });
}
