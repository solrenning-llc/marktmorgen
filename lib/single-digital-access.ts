/** Exact paid-reference access through an EXISTING live inbox grant. No new
 * token family or bearer-only permanent download is introduced. The sealed
 * purchase identity survives deletion of an accepted confirmation source;
 * current product updates and fresh payment/refund evidence still govern it.
 */
import { createHash, randomBytes } from "node:crypto";
import { canRecover, ordersGrant, ordersLinkFor } from "@/lib/buyer-orders";
import { readListing } from "@/lib/catalog";
import { seal, unseal } from "@/lib/secret-box";
import { suppressedCommand } from "@/lib/suppression";
import { ORDERS_LINK_SECONDS } from "@/lib/buyer-orders";
import { fromStore } from "@/lib/purchase-email";
import { redisPipeline } from "@/lib/redis";
import { onAccount } from "@/lib/stripe-account";
import { storeForEmail, storeRef, type Listing, type Store } from "@/lib/store";
import { normaliseEmail } from "@/lib/auth";
import type { ShipmentMailPolicy } from "@/lib/shipment-mail-outbox";
import { ordersWords } from "@/lib/buyer-words/orders";
import { formatMoney } from "@/lib/money";
import { LANGUAGES } from "@/lib/store-language";
import { consentEmailLines } from "@/lib/digital-consent-email";
import { CLOSING_ACCESS_SENTENCE, CLOSING_TERMS_PATH, CLOSING_TERMS_WORDS } from "@/lib/closing-buyers-rules";
import { SITE_URL } from "@/lib/site-url";

const CONTEXT = "single-digital-access|v1";
const MAX_CAPSULE_BYTES = 4096; // processing/URL bound, not a customer quota
const SESSION = /^cs_(?:test|live)_[A-Za-z0-9]{10,200}$/;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const metadataHash = (value: Record<string, unknown>) => hash(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
const record = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Reflect.ownKeys(v).every(k => typeof k === "string" && Object.hasOwn(Object.getOwnPropertyDescriptor(v, k) ?? {}, "value")) ? v as Record<string, unknown> : null;
async function erased(store: Store, email: string): Promise<boolean> {
  if (!store.listId) return false; // erasure creates a list before installing its durable suppression
  const result = await redisPipeline([suppressedCommand(store.listId, email)]);
  return !Array.isArray(result) || result.length !== 1 || result[0] !== 0;
}
export type SingleDigitalCapsule = {
  version: 1; sid: string; statsId: string; accountId: string; sessionId: string; productId: string; email: string;
  currency: string; unitCents: number; paidCents: number; created: number; metadataHash: string;
};
export function singleDigitalAccessCovered(p: ShipmentMailPolicy | null): boolean {
  // This same review must cover token issuance/readback, its complete24h
  // storage (including after acceptance), renewal and existing paid-delivery
  // resource grants. Pending-row storage alone is not that evidence.
  return Boolean(p?.coveredOrigins?.includes("single-digital-confirmation") && p.singleDigitalAccessEvidence?.trim());
}
function capsule(value: unknown): SingleDigitalCapsule | null {
  const c = record(value);
  const keys = ["version", "sid", "statsId", "accountId", "sessionId", "productId", "email", "currency", "unitCents", "paidCents", "created", "metadataHash"];
  if (!c || Object.keys(c).length !== keys.length || keys.some(k => !Object.hasOwn(c, k)) || c.version !== 1 ||
    ![c.sid, c.statsId, c.productId, c.email].every(v => typeof v === "string" && v.length > 0 && v.length <= 320) ||
    typeof c.accountId !== "string" || !/^acct_[A-Za-z0-9]{6,128}$/.test(c.accountId) || typeof c.sessionId !== "string" || !SESSION.test(c.sessionId) ||
    typeof c.currency !== "string" || !/^[a-z]{3}$/.test(c.currency) || typeof c.metadataHash !== "string" || !/^[a-f0-9]{64}$/.test(c.metadataHash) ||
    ![c.unitCents, c.paidCents, c.created].every(v => typeof v === "number" && Number.isSafeInteger(v) && v > 0)) return null;
  return c as SingleDigitalCapsule;
}
/** One expanded exact-session GET supplies current payment/charge and the
 * original line. Missing evidence is unknown, never a paid entitlement. */
export function singleDigitalPaid(session: unknown, c: SingleDigitalCapsule): boolean {
  const s = record(session), meta = record(s?.metadata), pi = record(s?.payment_intent), charge = record(pi?.latest_charge);
  const lines = record(s?.line_items), list = lines?.data;
  const line = Array.isArray(list) && list.length === 1 ? record(list[0]) : null, price = record(line?.price);
  const customer = record(s?.customer_details);
  return Boolean(s && s.object === "checkout.session" && s.id === c.sessionId && s.status === "complete" && s.mode === "payment" && s.payment_status === "paid" &&
    s.created === c.created && s.currency === c.currency && s.amount_total === c.paidCents && meta && meta.product === c.productId &&
    meta.mm_order_origin === "single-digital-v1" && metadataHash(meta) === c.metadataHash && customer && typeof customer.email === "string" && normaliseEmail(customer.email) === c.email &&
    lines?.has_more === false && line?.quantity === 1 && price?.unit_amount === c.unitCents && price.currency === c.currency &&
    pi?.object === "payment_intent" && typeof pi.id === "string" && pi.status === "succeeded" && pi.amount_received === c.paidCents && pi.currency === c.currency &&
    charge?.object === "charge" && charge.payment_intent === pi.id && charge.paid === true && charge.disputed === false && charge.amount === c.paidCents &&
    charge.currency === c.currency && charge.refunded === false && typeof charge.amount_refunded === "number" && Number.isSafeInteger(charge.amount_refunded) && charge.amount_refunded >= 0 && charge.amount_refunded < c.paidCents);
}
export async function readSingleDigitalAccess(store: Store, token: string, sealed: string): Promise<{ product: Listing; email: string; reference: string; paidAt: number } | null> {
  if (!canRecover(store) || sealed.length > MAX_CAPSULE_BYTES) return null;
  const opened = unseal(sealed, CONTEXT);
  let c: SingleDigitalCapsule | null = null;
  try { c = opened.ok ? capsule(JSON.parse(opened.value)) : null; } catch { return null; }
  if (!c || store.sid !== c.sid || store.statsId !== c.statsId || store.stripeAccountId !== c.accountId) return null;
  const email = await ordersGrant(store, token);
  if (!email || normaliseEmail(email) !== c.email || await erased(store, c.email)) return null;
  const session = await onAccount("GET", c.accountId, `/checkout/sessions/${encodeURIComponent(c.sessionId)}?expand[]=line_items&expand[]=payment_intent.latest_charge`);
  if (!singleDigitalPaid(session, c)) return null;
  const current = await storeForEmail(storeRef(store));
  if (!current || current.sid !== c.sid || current.statsId !== c.statsId || current.stripeAccountId !== c.accountId) return null;
  const product = await readListing(current, c.productId);
  // Existing entitlement is the current product, not an abandoned original blob.
  if (!product || product.options.length || product.recurring || product.course || product.podcast || product.shipping || product.bundle || product.call || product.keys || !product.file) return null;
  // Revalidate revocation after provider/catalog reads, immediately before
  // handing the result to the existing paid delivery branch.
  if (normaliseEmail(await ordersGrant(current, token) ?? "") !== c.email || await erased(current, c.email)) return null;
  return { product, email: c.email, reference: c.sessionId, paidAt: c.created };
}
/** Capture only independently verified original identity; no source ID is a
 * public capability, and no capsule works without a live account/email grant. */
export function singleDigitalCapsule(store: Store, product: Listing, session: Record<string, unknown>): SingleDigitalCapsule | null {
  const details = record(session.customer_details), meta = record(session.metadata), lineItems = record(session.line_items);
  const list = lineItems?.data, line = Array.isArray(list) && list.length === 1 ? record(list[0]) : null, price = record(line?.price);
  const c = capsule({ version: 1, sid: store.sid, statsId: store.statsId, accountId: store.stripeAccountId, sessionId: session.id, productId: product.id,
    email: typeof details?.email === "string" ? normaliseEmail(details.email) : "", currency: session.currency, unitCents: price?.unit_amount,
    paidCents: session.amount_total, created: session.created, metadataHash: meta ? metadataHash(meta) : "" });
  return c && c.unitCents === product.priceCents && singleDigitalPaid(session, c) ? c : null;
}
export async function singleDigitalMessage(original: Store, product: Listing, session: Record<string, unknown>, policy: ShipmentMailPolicy): Promise<{ to: string; subject: string; text: string; accessUrl: string } | null> {
  if (!singleDigitalAccessCovered(policy)) return null;
  const c = singleDigitalCapsule(original, product, session);
  const current = c ? await storeForEmail(storeRef(original)) : null;
  if (!c || !current || current.sid !== c.sid || current.statsId !== c.statsId || current.stripeAccountId !== c.accountId || !canRecover(current) || await erased(current, c.email)) return null;
  const sealed = seal(JSON.stringify(c), CONTEXT);
  if (sealed.length > MAX_CAPSULE_BYTES) return null;
  const base = `${SITE_URL}/@${current.handle}`, link = await ordersLinkFor(current, c.email, base);
  const token = link ? new URL(link).searchParams.get("token") : null;
  if (!token || normaliseEmail(await ordersGrant(current, token) ?? "") !== c.email || await erased(current, c.email)) return null;
  const accessUrl = `${SITE_URL}/api/store/download?${new URLSearchParams({ handle: current.handle, token, origin: sealed })}`;
  const words = ordersWords(original.language);
  return { to: c.email, subject: words.confirmSubject(original.name, product.title).slice(0, 200), accessUrl,
    text: [words.confirmIntro(original.name), "", words.whatYouBought(product.title, ""), words.paid(formatMoney(c.paidCents, c.currency, LANGUAGES[original.language].locale)),
      ...consentEmailLines(original, session.metadata as Record<string, string>), `${CLOSING_ACCESS_SENTENCE} ${CLOSING_TERMS_WORDS}: ${SITE_URL}${CLOSING_TERMS_PATH}`, "", words.openWhatYouBought(accessUrl), "", words.ordersLinkNote,
      "", words.questions(original.name), words.paymentWent(original.name)].join("\n") };
}

/** A capsule permits requesting an inbox proof, never opening the file by itself. */
export function singleDigitalRenewalCovered(p: ShipmentMailPolicy | null): boolean {
  return singleDigitalAccessCovered(p) && Boolean(p?.coveredOrigins?.includes("single-digital-access-renewal") && p.singleDigitalRenewalEvidence?.trim());
}
export function singleDigitalRenewalIdentity(store: Store, sealed: string): SingleDigitalCapsule | null {
  if (!canRecover(store) || sealed.length > MAX_CAPSULE_BYTES) return null;
  const opened = unseal(sealed, CONTEXT);
  try {
    const c = opened.ok ? capsule(JSON.parse(opened.value)) : null;
    return c && c.sid === store.sid && c.statsId === store.statsId && c.accountId === store.stripeAccountId ? c : null;
  } catch { return null; }
}
export async function verifySingleDigitalRenewal(store: Store, sealed: string): Promise<{ claim: SingleDigitalCapsule; store: Store; product: Listing } | null> {
  const c = singleDigitalRenewalIdentity(store, sealed);
  const current = c ? await storeForEmail(storeRef(store)) : null;
  if (!c || !current || !singleDigitalRenewalIdentity(current, sealed) || await erased(current, c.email)) return null;
  const session = await onAccount("GET", c.accountId, `/checkout/sessions/${encodeURIComponent(c.sessionId)}?expand[]=line_items&expand[]=payment_intent.latest_charge`);
  if (!singleDigitalPaid(session, c)) return null;
  const product = await readListing(current, c.productId);
  const latest = await storeForEmail(storeRef(current));
  if (!product?.file || product.options.length || product.recurring || product.course || product.podcast || product.shipping || product.bundle || product.call || product.keys ||
    !latest || !singleDigitalRenewalIdentity(latest, sealed) || await erased(latest, c.email)) return null;
  return { claim: c, store: latest, product };
}
export type SingleDigitalRenewalDraft = { token: string; accessUrl: string; message: { from: string; to: string; subject: string; text: string; replyTo: string } };
/** Random URL nonce is NOT an issued grant. No SET happens until beforePost,
 * after the existing sender has selected/reserved an eligible transport. */
export function singleDigitalRenewalDraft(store: Store, sealed: string, claim: SingleDigitalCapsule): SingleDigitalRenewalDraft {
  const token = randomBytes(32).toString("hex");
  const accessUrl = `${SITE_URL}/api/store/download?${new URLSearchParams({ handle: store.handle, token, origin: sealed })}`;
  const words = ordersWords(store.language);
  return { token, accessUrl, message: { from: fromStore(store), to: claim.email, replyTo: store.email,
    subject: words.ordersSubject(store.name), text: [words.ordersIntro(store.name, 1), "", accessUrl, "", words.ordersLinkNote, "", words.ordersIgnore].join("\n") } };
}
export async function activateSingleDigitalRenewal(store: Store, sealed: string, draft: SingleDigitalRenewalDraft): Promise<boolean> {
  const c = singleDigitalRenewalIdentity(store, sealed);
  if (!c || !/^[a-f0-9]{64}$/.test(draft.token) || draft.message.to !== c.email) return false;
  // Exact existing a/e grant schema, token-key derivation and24h lifetime.
  // ordersLinkFor cannot issue a preselected nonce; ordersGrant independently
  // verifies this activation/readback without changing the borrowed module.
  const key = `nl:orders:link:${createHash("sha256").update(`nimbus-orders:${draft.token}`).digest("hex").slice(0,40)}`;
  const [written] = await redisPipeline([["SET", key, JSON.stringify({ a: c.accountId, e: c.email }), "NX", "EX", ORDERS_LINK_SECONDS]]);
  return written === "OK" && normaliseEmail(await ordersGrant(store, draft.token) ?? "") === c.email && !(await erased(store, c.email));
}
