/** Pure original-wire comparison, not catalog authentication, valid consent,
 * admission, a funding review, a persisted source or paid-access permission. */
import { selectedDigitalOptionForFolder } from "@/lib/digital-option-confirmation";

function original(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const names = ["storeHandle", "productId", "title", "currency", "consent"];
    if (Reflect.ownKeys(value).length !== names.length) return null;
    const out: Record<string, string> = Object.create(null);
    for (const name of names) {
      const d = Object.getOwnPropertyDescriptor(value, name);
      if (!d || !Object.hasOwn(d, "value") || typeof d.value !== "string" || !d.value || d.value.length > 500 || /[\u0000-\u001f\u007f]/.test(d.value)) return null;
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
  return Object.entries(expected).every(([k, v]) => form.get(k) === v) &&
    !entries.some(([k]) => (k.startsWith("line_items[") && !Object.hasOwn(expected, k)) || /^line_items\[(?!0\])/.test(k) || /^(discounts|custom_fields|optional_items|subscription_data|shipping_options|shipping_address_collection)\[/.test(k)) &&
    !["gift", "group", "people", "preorder", "upsell_key", "bundle", "ship"].some(k => form.has(`metadata[${k}]`));
}
