import { test } from "node:test";
import assert from "node:assert/strict";
import { EU_WITHDRAWAL_CONSENT_VERSION } from "@/lib/digital-consent";
import { createCheckout } from "@/lib/store-checkout";
import { singleDigitalFixture } from "./single-digital-confirmation-world";

// Same shape as the PR's "an active single digital checkout cannot bypass
// unfunded durable admission", with one more buyer-optional box per case.
for (const [name, extra] of [["control (no optional box)", {}], ["news", { news: true }], ["remind (assistant reminder box)", { remind: true }]] as const) {
  test(`active single-file checkout stays closed with ${name}`, async () => {
    const f = await singleDigitalFixture();
    let posts = 0;
    process.env.STRIPE_SECRET_KEY = "sk_test_SYNTHETIC_ONLY";
    globalThis.fetch = async (_url, init) => {
      if (init?.method === "POST") posts++;
      return Response.json({ id: "cs_test_SyntheticLegacyDigital001", url: "https://checkout.stripe.com/c/pay/synthetic" });
    };
    let returned = false;
    try {
      await createCheckout(f.store, f.product, "https://example.test", undefined,
        { ...extra, digitalConsent: { version: EU_WITHDRAWAL_CONSENT_VERSION, at: Math.floor(f.created / 1000) } },
        { ...f.runtime, lifecycle: "active", policy: null });
      returned = true;
    } catch { /* fail closed */ }
    assert.equal(posts, 0, "no legacy payment POST before funded durable admission");
    assert.equal(returned, false, "no unprotected payment URL");
  });
}
