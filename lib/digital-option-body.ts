/** Pure original-wire comparison, not catalog authentication, valid consent,
 * admission, a funding review, a persisted source or paid-access permission. */
import { confirmationBodyDigest } from "@/lib/order-confirmation-outbox";
import { selectedDigitalOptionFromOriginal, selectedDigitalOptionForFolder, type SelectedDigitalOption } from "@/lib/digital-option-confirmation";
import { MAX_SUMMARY_LENGTH } from "@/lib/catalog-rules";

function original(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const names = ["storeHandle", "productId", "title", "currency", "consent", "summary"];
    if (Reflect.ownKeys(value).length !== names.length) return null;
    const out: Record<string, string> = Object.create(null);
    for (const name of names) {
      const d = Object.getOwnPropertyDescriptor(value, name);
      if (!d || !Object.hasOwn(d, "value") || typeof d.value !== "string" || (name !== "summary" && !d.value) || d.value.length > (name === "summary" ? MAX_SUMMARY_LENGTH : 500) || /[\u0000-\u001f\u007f]/.test(d.value)) return null;
      out[name] = d.value;
    }
    return /^[a-z]{3}$/.test(out.currency) && /^[A-Za-z0-9_-]{1,40}$/.test(out.productId) ? out : null;
  } catch { return null; }
}

/** Caller supplies separately authenticated original identity and folder.
 * Matching does not validate either, or authorize the general digital cohort. */
export function digitalOptionBodyMatches(body: unknown, product: unknown, optionId: unknown, folder: unknown, identity: unknown, maximumBytes: unknown): boolean {
  if (typeof body !== "string" || typeof maximumBytes !== "number" || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 131072 || body.length > maximumBytes || Buffer.byteLength(body) > maximumBytes) return false;
  const o = original(identity), selected = selectedDigitalOptionForFolder(product, optionId, folder);
  if (!o || !selected) return false;
  const form = new URLSearchParams(body), entries = [...form];
  if (form.toString() !== body || new Set(entries.map(([k]) => k)).size !== entries.length) return false;
  const name = `${o.title} (${selected.label})`;
  const expected: Record<string, string> = {
    mode: "payment", "metadata[store]": o.storeHandle, "metadata[product]": o.productId,
    "metadata[option]": selected.id, "metadata[title]": name.slice(0, 480), "metadata[dc]": o.consent,
    "line_items[0][quantity]": "1", "line_items[0][price_data][unit_amount]": String(selected.priceCents),
    "line_items[0][price_data][currency]": o.currency, "line_items[0][price_data][product_data][name]": name,
    "payment_intent_data[metadata][dc]": o.consent,
  };
  if (o.summary) expected["line_items[0][price_data][product_data][description]"] = o.summary;
  return Object.entries(expected).every(([k, v]) => form.get(k) === v) &&
    !entries.some(([k]) => /^metadata\[bump(?:2|3)?(?:_|\])/.test(k) || (k.startsWith("line_items[") && !Object.hasOwn(expected, k)) || /^line_items\[(?!0\])/.test(k) || /^(discounts|custom_fields|optional_items|subscription_data|shipping_options|shipping_address_collection)\[/.test(k)) &&
    !["gift", "group", "people", "preorder", "upsell_key", "bundle", "ship"].some(k => form.has(`metadata[${k}]`));
}

type Data = Record<string, unknown>;
function ownRecord(value: unknown, maximum = 128): Data | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const keys = Reflect.ownKeys(value); if (keys.length > maximum) return null;
  const out: Data = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor || !Object.hasOwn(descriptor, "value")) return null;
    out[key] = descriptor.value;
  }
  return out;
}
export type DigitalOptionRequestSnapshot = Readonly<{
  kind: "digital-option-request-snapshot"; authority: "comparison-only";
  admitted: false; permitsCheckout: false; grantsAccess: false;
  accountId: string; statsId: string; nonce: string; folder: string;
  identity: Readonly<Record<string, string>>; selected: SelectedDigitalOption;
  body: string; bodyDigest: string;
  /** Conservative encoded envelope bytes, including reporting-field overhead. */
  encodedBytes: number;
}>;
/** Captures only supplied ORIGINAL values, synchronously before any await.
 * No seal, durable source, admission, payment or access authority is created.
 * The future producer must authenticate these inputs and fund/persist its CAS.
 */
export function captureDigitalOptionRequestSnapshot(input: unknown): DigitalOptionRequestSnapshot | null {
  try {
    const value = ownRecord(input, 8), names = ["store","product","optionId","folder","body","nonce","consent","maximumBytes"];
    if (!value || Object.keys(value).length !== names.length || !names.every(k => Object.hasOwn(value,k)) ||
        typeof value.body !== "string" || typeof value.nonce !== "string" || !/^[a-f0-9]{64}$/.test(value.nonce) ||
        typeof value.folder !== "string" || typeof value.maximumBytes !== "number" || !Number.isSafeInteger(value.maximumBytes) || value.maximumBytes < 1 || value.maximumBytes > 131072 ||
        Object.getOwnPropertyDescriptor(Object.prototype,"toJSON") || Object.getOwnPropertyDescriptor(Array.prototype,"toJSON")) return null;
    const store = ownRecord(value.store), product = ownRecord(value.product);
    if (!store || !product || typeof store.statsId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(store.statsId) ||
        typeof store.stripeAccountId !== "string" || !/^acct_[A-Za-z0-9]{6,128}$/.test(store.stripeAccountId)) return null;
    for (const key of ["recurring","course","call","podcast","shipping","bundle","keys","link","file","plan","pwyw","callPackage","note"]) if (product[key]) return null;
    const fields = product.fields;
    if (!Array.isArray(fields) || Object.getPrototypeOf(fields) !== Array.prototype || Reflect.ownKeys(fields).length !== 1 || Object.getOwnPropertyDescriptor(fields,"length")?.value !== 0) return null;
    const identity = original({storeHandle:store.handle,productId:product.id,title:product.title,currency:store.currency,summary:product.summary,consent:value.consent});
    const selected = selectedDigitalOptionFromOriginal(product,value.optionId,value.folder);
    if (!identity || !selected || !digitalOptionBodyMatches(value.body,{options:[selected]},selected.id,value.folder,identity,value.maximumBytes)) return null;
    const form = new URLSearchParams(value.body), bodyDigest = confirmationBodyDigest(value.body);
    if (form.get("metadata[mm_order_origin]") !== "digital-option-v1" || form.get("metadata[mm_order_intent]") !== value.nonce || form.get("metadata[mm_order_hash]") !== bodyDigest) return null;
    const snapshot = {kind:"digital-option-request-snapshot" as const,authority:"comparison-only" as const,
      admitted:false as const,permitsCheckout:false as const,grantsAccess:false as const,
      accountId:store.stripeAccountId,statsId:store.statsId,nonce:value.nonce,folder:value.folder,
      identity:Object.freeze(identity),selected,body:value.body,bodyDigest};
    // Only fresh selected primitives/arrays are encoded; no caller JSON hook.
    const encodedBytes = Buffer.byteLength(JSON.stringify(snapshot)) + 64;
    if (encodedBytes > value.maximumBytes) return null;
    return Object.freeze({...snapshot,encodedBytes});
  } catch { return null; }
}
