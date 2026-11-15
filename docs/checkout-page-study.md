# Checkout on a Marktmorgen page: study (257 [KJ2])

Study only. Nothing here is built, switched on or changed at Stripe. Written by Claude 4 (nuvem V) on 15 November 2026 from Stripe's official pages, read that day as raw HTML (quotes are exact), and from the code on `main` that day.

**Question.** Can the buyer pay inside a page of Marktmorgen's own (Stripe's embedded Checkout), so the creator can show what the buyer gets, the guarantee, the refund policy and only real reviews around the payment form, while everything today's hosted Checkout guarantees keeps holding?

**Answer, in short.** Compatible in principle, with five conditions that must be met before any build, listed at the end. Until then the hosted page stays exactly as it is.

## What Stripe says (read 2026-11-15)

Stripe shows no "last updated" date on these pages. They carry API version `2026-10-28.endive`.

| Point | Stripe's words | Source |
| --- | --- | --- |
| Embedded mode exists | `ui_mode` value `embedded_page`: "The Checkout Session is displayed as an embedded form on your website." Default: "Defaults to hosted_page." | [API: create a Checkout Session](https://docs.stripe.com/api/checkout/sessions/create) |
| Mounting | `stripe.createEmbeddedCheckoutPage({ fetchClientSecret })`, then `checkout.mount(...)`. "Always load Stripe.js from js.stripe.com to remain compliant. Don’t include the script in a bundle or host it yourself." | [Embedded quickstart](https://docs.stripe.com/checkout/embedded/quickstart) |
| After paying | "specify the URL of the return page in the return_url parameter". `success_url`: "This parameter is not allowed if ui_mode is embedded_page or elements." | Quickstart; API reference |
| Direct charges on the creator's account | The direct-charges guide has a "Full embedded page" variant: the session is created with the `Stripe-Account` header, and Stripe.js is started with `{ stripeAccount }`. "The connected account’s branding is used in Checkout". "Charges that you create directly on the connected account are reported only on that account and in your Connect Dashboard." The application fee in the example is optional. | [Direct charges](https://docs.stripe.com/connect/direct-charges) |
| No iframe in an iframe | "Avoid placing Checkout within another iframe, because some payment methods require redirecting to another page for payment confirmation." | Direct charges |
| Payment methods | "For charges where the connected account is the MoR, including direct charges … the payment method must be enabled on the connected account." | [Dynamic payment methods for Connect](https://docs.stripe.com/connect/dynamic-payment-methods) |
| Browser support | "Checkout with ui_mode set to embedded_page supports only Safari version 17 or later and iOS version 17 or later." (a footnote; which rows carry it was not mapped) | [Payment method support](https://docs.stripe.com/payments/payment-methods/payment-method-support) |
| PCI | "both Checkout and Elements allow you the flexibility and customizability of a self-hosted form, while also meeting PCI eligibility for the SAQ A." | [PCI guide](https://stripe.com/guides/pci-compliance) |
| Content Security Policy | Checkout: `connect-src`, `frame-src` and `script-src https://checkout.stripe.com`, `img-src https://*.stripe.com`. Stripe.js: `frame-src https://*.js.stripe.com https://js.stripe.com https://hooks.stripe.com`, `script-src https://*.js.stripe.com https://js.stripe.com`, `connect-src https://api.stripe.com`. Also: "Currently, we don’t support Cross-origin isolated sites." | [Security guide](https://docs.stripe.com/security/guide) |
| What embedded keeps | Built in: "Automatic tax collection", "Adaptive Pricing", "Support for digital wallets and Link". Customizable: "Collect Tax IDs", "Apply discounts", "Optional items", "Subscription upsells". Custom domains are "Full hosted page only". | [How Checkout works](https://docs.stripe.com/payments/checkout/how-checkout-works) |
| Look | "CSS from your host page … doesn’t cross the iframe boundary". Use "the Dashboard Branding Settings or the [appearance] parameter". | [Appearance](https://docs.stripe.com/payments/checkout/customization/appearance) |

## Checked against our code (main, 15 November 2026)

1. **The money stays the creator's.** `lib/store-checkout.ts` makes every sale a direct charge on the connected account with no application fee. Embedded mode changes where the form is drawn, not the charge. It would be the same session, the same `Stripe-Account` header and still no fee. Holds.
2. **The creator's own ways to pay.** Today's session uses the payment methods switched on in the creator's account (`lib/help-content.ts`, "the ones you switch on in your own Stripe account"). Embedded mode reads the same account. Holds. Gap: Safari and iOS older than 17 cannot use embedded mode, so a fallback to the hosted page is needed for them.
3. **PCI.** SAQ A in both modes: card fields stay in Stripe's frame and never reach our servers. Holds.
4. **Tax, art. 9a and the tax gate.** Tax is applied in the session body (`lib/tax.ts` applyTax, `automatic_tax[enabled]`), and Stripe lists automatic tax as built into embedded mode. The deemed-supplier and gate logic (`lib/deemed-supplier.ts`, `lib/tax-gate.ts`, `PLANS_ON_SALE`) does not depend on the form's mode. Holds, and no gate changes.
5. **Extras and offers after paying.**
   - The order bumps (`lib/product-extras.ts`, MAX_BUMPS) are chosen on our product page before the session is made, so they are unchanged.
   - The offer after paying (`lib/upsell.ts`) works from the session and the customer after payment, on our thanks page. In embedded mode that page becomes the `return_url`.
   - Its two safeguards hold in both modes: the card is saved only for payments while the buyer is there (`setup_future_usage` "on_session", in the session body), and a secret cookie is set on our own domain when the checkout opens.
   - To be checked in test mode: that the redirect-based methods (iDEAL and the like), which already meet no offer after paying, still return to it.
6. **Things the code sets that embedded mode refuses.**
   - `success_url` (today `/@handle/thanks?session_id=…`) must become `return_url`.
   - `cancel_url` (today the store page) has no meaning when the form is on our page.
   - `branding_settings` (`lib/checkout-branding.ts`, 536 [CB1]) is listed as "not allowed if ui_mode is …". Which modes was not confirmed, so this is to be checked; embedded mode has the `appearance` parameter instead.
7. **The API version.** We pin `STRIPE_VERSION = "2026-08-26.dahlia"` (`lib/stripe-connect.ts`). The pages above describe `2026-10-28.endive`, where the value is `embedded_page`. The value our pinned version accepts must be confirmed in its own changelog before a build. Not confirmed: an open gap.
8. **Content Security Policy.** The store pages' policy (`lib/csp.ts`) allows neither `js.stripe.com` nor `checkout.stripe.com` today. A build needs exactly Stripe's hosts above, only on the page that draws the form.
9. **Privacy.** Stripe.js must load from `js.stripe.com` on our page, where today the buyer meets Stripe only on Stripe's own page. The privacy policy and `lib/person-data.ts` must say so before it ships. Not done.
10. **The embed on the creator's own site** (the WG complement on this item). Stripe asks not to put Checkout "within another iframe". If our widget is drawn in an iframe on the creator's site, the form must not be inside it: the widget would open our page, or the hosted page, instead.

## Costs (MR)

There is no new provider and no new Stripe fee: the same session and the same direct charge. Stripe.js and the form are served by Stripe. The page around the form is one of ours, drawn per request with the store's existing public-request ceiling (`lib/traffic.ts`). A build adds no new cost line beyond that page, which is priced as today's store pages.

## Conversion, before and after

The item asks to measure conversion before and after. Without personal tracking, and within VR: count, per store and in aggregate only, the sessions opened and the sessions paid in each mode, behind the switch.
- Today the hosted page's opened and paid sessions can be read from the records the checkout already keeps.
- No count is made until the build. No number exists yet, and none is claimed.

## Conditions before any build

1. Confirm the embedded value for our pinned API version, or the version bump it needs, in Stripe's changelog.
2. Check in Stripe's test mode, with test keys only and no live account touched:
   - a direct charge in embedded mode;
   - a redirect-based method;
   - the offer after paying;
   - `branding_settings` versus `appearance`;
   - Safari 17 and the fallback to the hosted page.
3. Update the CSP only for that page, and update the privacy policy and `lib/person-data.ts` text.
4. Build behind a switch that stays off, with the hosted page unchanged as the default and the fallback.
5. AX274: the page around the form gets the full AAA review. The form inside Stripe's frame is Stripe's, and that is said as a gap, not as a pass.

Stripe test mode needs test API keys in the environment, and their presence is the owner's call. Until then this stays a study.
