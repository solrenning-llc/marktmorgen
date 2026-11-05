/** Synthetic transport boundary; exact application Lua is tested on Redis separately. */
import { physicalPaidFixture } from "./order-confirmation-paid-fixture";
import type { ProductFile } from "@/lib/product-file";

export async function singleDigitalFixture() {
  const f = await physicalPaidFixture();
  f.product.shipping = null;
  f.product.title = "Original digital file";
  f.product.file = { pathname: "synthetic/original.pdf", name: "Original.pdf", bytes: 1200,
    contentType: "application/pdf", addedAt: new Date(f.created).toISOString() } satisfies ProductFile;
  f.runtime.policy = { ...f.runtime.policy!, coveredOrigins: ["single-digital-confirmation"] };
  return f;
}

import { randomBytes } from "node:crypto";
import { admitOrders } from "@/lib/order-admission";
import { prepareOrderConfirmationPreintent } from "@/lib/orders";
import { confirmationBodyDigest, reserveSingleDigitalConfirmationOrigin } from "@/lib/order-confirmation-outbox";
import { EU_WITHDRAWAL_CONSENT_VERSION } from "@/lib/digital-consent";

/** Seed the retention primitive from real admission. This is NOT createCheckout
 * and does not assert that a customer may pay without proved file access. */
export async function reserveDigital(f: Awaited<ReturnType<typeof singleDigitalFixture>>) {
  const nonce = randomBytes(32).toString("hex"), accountId = f.store.stripeAccountId!;
  const body = new URLSearchParams({ mode: "payment", "metadata[store]": f.store.handle,
    "metadata[product]": f.product.id, "metadata[mm_order_origin]": "single-digital-v1", "metadata[mm_order_intent]": nonce,
    "metadata[dc]": `yes:${EU_WITHDRAWAL_CONSENT_VERSION}:d:${Math.floor(f.created / 1000)}`,
    "line_items[0][quantity]": "1", "line_items[0][price_data][unit_amount]": String(f.product.priceCents),
    "line_items[0][price_data][currency]": f.store.currency });
  const bodyDigest = confirmationBodyDigest(body.toString()); body.set("metadata[mm_order_hash]", bodyDigest);
  const admission = await admitOrders(f.store, 1, f.created, 1);
  if (!admission.ok) throw Error("Synthetic admission was not granted");
  const preintent = await prepareOrderConfirmationPreintent(f.store, admission, { nonce, accountId, bodyDigest }, { now: f.runtime.now });
  if (!preintent) throw Error("Synthetic original admission was not captured");
  const input = { statsId: f.store.statsId, nonce, accountId, body: body.toString(), preintent,
    snapshot: { store: { handle: f.store.handle, name: f.store.name, email: f.store.email, sid: f.store.sid, extra: f.store.extra,
      statsId: f.store.statsId, stripeAccountId: accountId, currency: f.store.currency },
      product: { ...f.product, file: { ...f.product.file! } },
      rights: { priceCents: f.product.priceCents, currency: f.store.currency, consent: body.get("metadata[dc]") } } };
  return { input, result: await reserveSingleDigitalConfirmationOrigin(input, f.runtime), body };
}
