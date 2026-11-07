// CX-116 second review of #2999 (proof only, rule 30): the line #2999 edits
// keeps a member coupon inside the closed single-file category, but a store
// sale or a fair-price coupon on the same product still takes it out, so the
// legacy unprotected payment POST is made. Pre-existing on main too.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EU_WITHDRAWAL_CONSENT_VERSION } from "@/lib/digital-consent";
import { createCheckout } from "@/lib/store-checkout";
import { singleDigitalFixture } from "./single-digital-confirmation-world";

for (const kind of ["member", "sale", "fair"] as const) {
  test(`a single file with a ${kind} coupon stays closed: no legacy payment POST`, async () => {
    const f = await singleDigitalFixture();
    const now = Math.floor(Date.now() / 1000);
    if (kind === "sale") f.store.sale = { ...f.store.sale, name: "Spring", coupon: "spring30", percent: 30, starts: now - 60, ends: now + 3600, all: true, products: [] };
    if (kind === "fair") f.store.fair = { ...f.store.fair, on: true, levels: { IN: 50 } } as typeof f.store.fair;
    process.env.STRIPE_SECRET_KEY = "sk_test_SYNTHETIC_ONLY";
    let paymentPosts = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST" && path.endsWith("/checkout/sessions")) paymentPosts++;
      if (path.includes("/coupons")) return Response.json({ id: "mm_x", percent_off: 30 });
      return Response.json({ id: "cs_test_SyntheticLegacyDigital001", url: "https://checkout.stripe.com/c/pay/synthetic" });
    }) as typeof fetch;
    const extras = {
      digitalConsent: { version: EU_WITHDRAWAL_CONSENT_VERSION, at: Math.floor(f.created / 1000) },
      ...(kind === "member" ? { member: { percent: 30, email: "member@example.com" } } : {}),
      ...(kind === "fair" ? { country: "IN" } : {}),
    };
    let returned = false;
    try { await createCheckout(f.store, f.product, "https://example.test", undefined, extras, f.runtime); returned = true; } catch { /* closed */ }
    assert.equal(paymentPosts, 0, "no legacy payment POST for a single file");
    assert.equal(returned, false, "no unprotected payment URL");
  });
}
