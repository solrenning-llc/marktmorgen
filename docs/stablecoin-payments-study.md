# Stablecoin payments through the creator's own Stripe account: study (402 [WX3])

State: study only (queue item 402 [WX3], FIM1 tail). Nothing is built, switched on, contracted or requested. No Stripe account was opened or changed, no Dashboard request was sent, no terms were accepted and nobody was contacted. Written 06/11/2026. Revised 07/11/2026 after Codex J's documentary review of 06/11/2026 (geography, fee scope, unknown cost, Stripe Tax wording).

Item 402 was cancelled by LQ7 on 28/10/2026 and restored by LQ17 the same night (23h37 Fortaleza); it stands in the FIM1 tail as "estudo de stablecoin".

## How the sources were read (and the limit that follows)

- On 06/11/2026 this session's network policy refused direct fetches of `docs.stripe.com`, `stripe.com` and `support.stripe.com` (proxy answered 403 to CONNECT). The Stripe pages below were therefore read **through search-engine extracts of the official pages, with the search restricted to Stripe's own domains**. Each is an official Stripe page, but what was read is the extract, not the whole page. Every claim marked **(extract)** must be re-read on the live page before any build.
- The official `stripe` Node SDK, version 23.1.0 (published by Stripe on npm, API version `2026-10-28.endive`, OpenAPI `v2596`), was downloaded and read directly: its typings and its CHANGELOG. Claims marked **(SDK)** come from that read.
- Regulators: EUR-Lex (MiCA, Implementing Regulation 282/2011) and Congress.gov/GovInfo (GENIUS Act), also through extracts **(extract)**.
- Owner-relayed Stripe answers already recorded in this repository are marked **(repo)**.
- Codex J's documentary review of this study (#2922, 06/11/2026) read the live pages [S1], [S2] (Checkout guide), [S6], [S15] and [S21]. Claims marked **(review)** come from that review's report, not from this session's own read; they also need the full re-read before any build.

## What Stripe offers today

| Topic | Finding | Basis |
| --- | --- | --- |
| Product | "Stablecoin payments" (payment method type `crypto`, Dashboard name "Stablecoins and Crypto"). The buyer pays from their own crypto wallet; the merchant receives fiat in its Stripe balance. | [S1], [S2] (extract); [S12] (SDK) |
| Merchant location and availability | **Three separate states, not one.** (a) General availability, per the Checkout guide: businesses in the United States, every state except New York, with access granted after Stripe's review. (b) Private preview, per the current overview: acceptance by businesses in the European Union, Hong Kong, Mexico and Switzerland. (c) Account approval: in either case Stripe reviews each account, and some accounts cannot be onboarded. The payment method support table lists Business location: United States; Currency: USD; Customer country: Worldwide. None of this establishes eligibility for any creator or account. | [S1], [S2] (review); [S3] (extract) |
| Creator countries the platform targets | US: general availability (except NY), after account approval. European Union: private preview only, not general availability. Canada, the UK and the EEA countries outside the EU: no acceptance listed in the pages read. A private preview is not an offer a creator can rely on, and this table does not establish eligibility for any creator. | [S1], [S2] (review); [S3], [S10] (extract) |
| Access | Not on by default for the general product: the business requests "Stablecoins and Crypto" in its Dashboard and Stripe reviews it before activation; some accounts cannot be onboarded. Stablecoins on Link are described as switched on with Link for "eligible US businesses", and Stripe's support says Pay with Crypto is open to "a limited set of US merchants". The two descriptions differ; which applies to a given account is **not confirmed**. | [S2], [S6], [S9] (extract) |
| Tokens and networks | USDC on Tempo, Ethereum, Solana, Polygon and Base; USDP on Ethereum and Solana; USDG on Ethereum (USDP/USDG for US businesses). The SDK's enums also list networks `sui` and tokens `usdt`, `phantom_cash`, `ousd`, `usdsui` (added 2026-03 to 2026-10). Which of these a given account can take today is **not confirmed**. | [S1], [S4] (extract); [S12], [S13] (SDK) |
| Charge currency and settlement | Charged in USD; settles to the merchant's Stripe balance in its local currency (USD for a US creator). The creator never holds crypto. | [S1], [S2] (extract) |
| Amount limit | USD 10,000 per transaction (Link: USD 1 to 10,000). | [S1], [S6] (extract) |
| Integrations | Payment Links, Checkout, Elements and the Payment Intents API; with dynamic payment methods Stripe shows it automatically to eligible buyers. Checkout Session `payment_method_types` and `payment_method_options[crypto]` accept it (`setup_future_usage` only `none`). Payment Method Configurations gained a `crypto` entry (API 2025-10-29). | [S2], [S8] (extract); [S12], [S13] (SDK) |
| Confirmation timing | Since API 2025-09-30 a submitted payment's PaymentIntent goes to `processing` and the buyer is redirected back **only when the payment is finalized**. Whether a Checkout Session then reports `payment_status: "paid"` at `checkout.session.completed`, or `unpaid` followed by `checkout.session.async_payment_succeeded`, is **not confirmed** by any page read. | [S7] (extract) |
| Disputes | "Dispute support: No"; Stablecoins on Link: "instantly guaranteed and can't be disputed". Manual capture not supported. | [S1], [S9] (extract) |
| Refunds | Full and partial refunds supported; **always returned as stablecoins to the customer's original wallet**; refunds carry the blockchain transaction hash (API 2025-10-29). For the separate deposit mode, Stripe warns that a buyer who paid from an exchange or omnibus wallet "might not be able to recover refunded funds". Whether that warning also applies to the ordinary wallet flow is **not confirmed**. | [S1], [S11] (extract); [S13] (SDK) |
| Subscriptions | Subscription and invoice payment settings accept `crypto` (SDK). Stripe's guide "Set up a subscription with stablecoin payments" (Checkout `mode=subscription`, the buyer authorizes pulls from the wallet) is **private preview**; Stablecoins on Link: subscriptions and off-session **not supported**. | [S5], [S6] (extract); [S12] (SDK) |
| Connect | Platforms can take crypto payments for all charge types; each connected account must have it enabled; accounts with full Dashboard access (Standard) enable it in their own Dashboard; capability `crypto_payments` (`active` when on). Direct charges are not named separately. | [S14] (extract); [S13] (SDK) |
| Price | **US pricing page, general Payments stablecoins: 1.5% of the transaction amount in USD** for US businesses (listed as including conversion to fiat, wallet and AML screening, fraud prevention, gas sponsorship). **Stablecoins on Link, listed separately on the same US page: 0.8% as a promotional rate through 2027-01-01, plus 0.2% thereafter.** Both as read on 06/11/2026; rates for the private-preview regions were not read, and no rate is universal. No fixed per-charge fee was shown. Fee on a refund: **not confirmed**. These are Stripe's prices to the merchant; no Marktmorgen price or coefficient is changed. | [S15] (extract; review) |

## Who pays what, with Marktmorgen's model

- Marktmorgen's store charges are **direct charges on the creator's Standard account, with no application fee** (SR5 table in AGENTS.md; platform = the Delaware LLC's US Stripe account, owner's decision of 28/10/2026 in docs/stripe-platform-eligibility.md). On direct charges where the connected account uses its own Stripe pricing, **the connected account pays Stripe's fees, refunds and chargebacks** [S16] (extract), and Stripe's fee-payer page for direct charges supports allocating the processing fee to a Standard creator [S21] (review). So the stablecoin processing fee (on US general Payments, 1.5% [S15]) falls on the creator's account. That fee payer setting does not prove that any other cost is zero: platform support, compute, retries, evidence, legal and tax work stay Marktmorgen's and are unknown (see "Cost to Marktmorgen").
- Stripe Tax on those direct charges is charged to the creator's account, not the platform, per the Stripe answer of 28/10/2026 13h55 relayed by the owner (repo, docs/stripe-platform-eligibility.md (d)). Stripe Tax's fee is charged when a Checkout Session with automatic tax completes and a registration covers the buyer [S17] (extract). Stripe's Checkout guide says Stripe Tax calculates from the amount, currency, product details and customer location for card or stablecoin payments, with no separate stablecoin-specific Stripe Tax configuration [S2] (review). That is provider documentation only: Stripe Tax's behavior is **not confirmed** for a creator's own account or for Marktmorgen's Checkout integration (no test-mode run), and the legal treatment and the deemed-supplier gate below stay open.
- `lib/receiving-costs.ts` models what *Marktmorgen* pays to receive its own plan and add-on payments. A stablecoin payment on a creator's store does not touch it. Paying Marktmorgen's own plans in stablecoins is outside this item (and would be a subscription, which is private preview).

## What the code does today

- `lib/instant-pay.ts` lists `"crypto"` in `DELAYED_METHODS`, and `onlyInstantMethods` sends it in `excluded_payment_method_types[]` on every Checkout Session it builds: a creator who switches stablecoins on in Stripe still never shows them to a buyer here. The reason written there: products are handed over when Stripe says "paid", and a crypto transfer "says complete at checkout and paid days later". Per [S7] that description may be out of date (the redirect now waits for finalization), but the Checkout-level status is unconfirmed, so the exclusion stays correct until a test-mode run proves otherwise.
- `lib/payment-methods.ts` already reads the creator's Payment Method Configuration and shows `crypto` as "Stablecoins" in the "held" group; the help text (`lib/help-content.ts`, `lib/feature-pages.ts`) tells creators stablecoins are left out on purpose. That copy is accurate today.
- Nothing in Marktmorgen holds, converts or moves crypto, creates wallets or keys, and nothing would under any option below.

## Taxes, art. 9a and regulation

- **EU art. 9a / location evidence.** A US creator can take stablecoins from buyers worldwide, so EU consumers can pay this way; art. 9a (docs/eu-vat-article-9a.md) treats Marktmorgen as the deemed supplier of electronically supplied services whatever the payment method. Art. 24f of Implementing Regulation 282/2011 lists bank details (the location of the account used for payment, or the billing address held by the bank) among the evidence items [S18] (extract). A wallet payment gives no bank or card country, so one of the usual two non-contradictory items is missing for those sales. This is this study's reading of the article, **not an official ruling**; under the TX policy the deemed-supplier gate (`lib/deemed-supplier.ts`) would have to handle a sale with no bank evidence before stablecoins could ever be shown on an EU-reachable checkout.
- **Most-tax / margin.** The processing fee is the creator's under the direct-charge fee-payer setting and Marktmorgen takes 0% commission, so this study changes no Marktmorgen price, fee coefficient or tax treatment, and nothing here lowers any tax or fee assumption. That is not a margin result: the costs under "Cost to Marktmorgen" stay unknown, not zero.
- **EU MiCA (Regulation (EU) 2023/1114).** Applies in full since 30 December 2024, with e-money token rules since 30 June 2024 [S19] (extract). It governs issuers and crypto-asset service providers. EU acceptance is in private preview only [S1] (review), so MiCA has no generally available acceptance case for Marktmorgen's EU creators today. What it would mean for an EU creator in that preview, or whether a US creator's EU buyers raise any MiCA point for the creator or the platform, was **not examined** and is not assumed to be none.
- **US.** The GENIUS Act (Public Law 119-27, 18 July 2025) regulates payment-stablecoin issuers [S20] (extract). The New York exclusion is Stripe's; Stripe's resource pages attribute it to NYDFS rules, which was **not confirmed** on an NYDFS source. State money-transmitter law: no official source was read; the creator receives fiat from Stripe and Marktmorgen never holds funds, but no conclusion is drawn.

## Cost to Marktmorgen

- **Today: this document adds no production IO.** It is a study: no call, command or storage changes (the exclusion is a field on the Checkout Session request already made, and the Payment Method Configuration GET already happens when the studio page opens). That is not a statement that the feature would cost nothing.
- **If ever built** (the smallest form: drop `crypto` from `DELAYED_METHODS` for one-time checkouts only): no new Stripe call per checkout and no new storage is an **unimplemented hypothesis**, not an MR admission; it would hold only once built and tested under the existing per-store request ceilings. Unknown and not zero: platform support (including wallet refunds that cannot reach the buyer), compute, retries, evidence work, legal and tax work, and the art. 9a evidence work above. Unknown remains unknown. Any version that waits on `async_payment_succeeded` would reuse the existing delayed-payment handling, not add a second checkout or processor.

## Customer benefit and profit path (VR item 3)

- **Benefit to the creator:** buyers with stablecoins and no card, or with cards that fail cross-border, can pay; for a US creator on general Payments, 1.5% [S15] versus Stripe's card pricing (Link stablecoins are priced separately); no disputes. Stripe's own case study (Shadeform) is vendor marketing, not evidence for creators here.
- **Benefit to the buyer:** pays from a wallet; refunds come back to the same wallet.
- **Profit path for Marktmorgen:** none direct (0% commission, the fee is the creator's). Indirect only: a creator who sells more may keep a plan longer. There is **no measured demand** from creators or buyers here, so the path is not demonstrable today.

## Risks

1. Availability is narrow: general availability only for US creators outside New York, after account approval; the European Union, Hong Kong, Mexico and Switzerland in private preview only; Canada and the UK not listed. A studio switch would be dead for most of the target countries (VR item 2: nothing shown that does not work for the viewer).
2. Settlement status at Checkout is unconfirmed; turning it on without proof could hand over a product before payment or show "nothing was paid".
3. Refunds go only to the original wallet; a buyer paying from an exchange account may not get the money back. EU and other consumer refund rights stay owed whatever the rail.
4. Memberships and payment plans (subscriptions) cannot use it outside a private preview.
5. EU location evidence (art. 24f) is thinner for wallet payments.
6. Stripe pages disagree among themselves (access by request versus automatic with Link; Payment Element cell blank in the support table versus "Elements" in the text).

## Recommendation

**Later, not now.** Keep `crypto` excluded and the current copy as is. No build while there is no measured demand, general availability is US-only (EU in private preview), subscriptions are private preview and the Checkout status is unconfirmed. If the owner wants it later, the smallest version is: one-time checkouts only, for creators whose account reports `crypto` available, after a test-mode run on synthetic data shows the Checkout Session's status at `checkout.session.completed`, and after the deemed-supplier gate handles a sale without bank evidence.

### Depende do dono

- Decide whether to pursue stablecoin acceptance at all (recommended: not now, review if creators ask). No action is needed to keep the current state.
- Before any build, someone with network access to Stripe's sites must re-read pages [S1]–[S17] and [S21] in full, since this study read extracts only.

## What could not be confirmed

- The Checkout Session `payment_status` at completion for a stablecoin payment.
- Whether the US 1.5% (or the Link rate) is refunded with a refund, and any fixed fee or currency-conversion fee for non-USD balances.
- Which tokens/networks a specific account gets (docs list USDC/USDP/USDG; the SDK enum lists more).
- Which access route (review versus automatic with Link) applies to a creator's Standard account.
- Whether Stripe Tax, as the Checkout guide documents it for card or stablecoin payments, works the same on a creator's own account and through Marktmorgen's integration (no test-mode run); the legal treatment and the deemed-supplier gate stay open.
- Any NYDFS, state money-transmitter or MiCA point for a US creator selling to EU buyers.

## Sources (all read on 06/11/2026)

| Id | Source | URL | How read |
| --- | --- | --- | --- |
| S1 | Stripe Docs, Stablecoin payments | https://docs.stripe.com/payments/stablecoin-payments | extract; live (review) |
| S2 | Stripe Docs, Accept stablecoin payments (Checkout guide) | https://docs.stripe.com/payments/accept-stablecoin-payments?payment-ui=checkout | extract; live (review) |
| S3 | Stripe Docs, Payment method support | https://docs.stripe.com/payments/payment-methods/payment-method-support | extract |
| S4 | Stripe Changelog, Phantom Cash and USDT (2026-04-22, Dahlia) | https://docs.stripe.com/changelog/dahlia/2026-04-22/stablecoin-payments-phantom-cash-and-usdt | extract (title) |
| S5 | Stripe Docs, Set up a subscription with stablecoin payments | https://docs.stripe.com/billing/subscriptions/stablecoins | extract |
| S6 | Stripe Docs, Stablecoins on Link | https://docs.stripe.com/payments/link/stablecoins | extract; live (review) |
| S7 | Stripe Changelog, processing status for stablecoin payments (2025-09-30, Clover) | https://docs.stripe.com/changelog/clover/2025-09-30/stablecoin-payments-processing-status | extract |
| S8 | Stripe Changelog, stablecoins in Payment Method Configurations (2025-10-29) | https://docs.stripe.com/changelog/clover/2025-10-29/stablecoin-payments-pmc | extract |
| S9 | Stripe Support, Pay with stablecoins on Link / Understanding Stripe's crypto products | https://support.stripe.com/questions/pay-with-stablecoins-on-link ; https://support.stripe.com/questions/understanding-stripes-crypto-products | extract |
| S10 | Stripe Support, Crypto supportability and availability by region; Stripe Money Management availability | https://support.stripe.com/questions/crypto-supportability-and-availability-by-region ; https://stripe.com/money-management/availability | extract |
| S11 | Stripe Docs, Deposit mode stablecoin payments (private preview) | https://docs.stripe.com/payments/deposit-mode-stablecoin-payments | extract |
| S12 | `stripe` npm 23.1.0 typings (`Charges`, `PaymentIntents`, `Checkout/Sessions`, `Subscriptions`, `Invoices`) | https://www.npmjs.com/package/stripe/v/23.1.0 | direct (SDK) |
| S13 | `stripe` npm 23.1.0 CHANGELOG: 18.3.0 (2025-07-01) `crypto` method, `crypto_payments` capability; 19.2.0 (2025-10-29) PMC, refunds, Solana; 21.0.0 (2026-03-25) Checkout options, Tempo; 22.1.0 (2026-04-23) USDT; 22.3.0 (2026-06-24) Sui; 23.1.0 (2026-10-29) OUSD | https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md | direct (from the npm tarball) |
| S14 | Stripe Docs, Stablecoin payments, Connect section | https://docs.stripe.com/payments/stablecoin-payments | extract |
| S15 | Stripe Pricing; Local payment methods pricing | https://stripe.com/pricing ; https://stripe.com/pricing/local-payment-methods | extract; live (review) |
| S16 | Stripe Docs, Create invoices with Connect; Platform earnings report | https://docs.stripe.com/invoicing/connect ; https://docs.stripe.com/connect/platform-earnings-report | extract |
| S17 | Stripe Docs, How Stripe Tax works | https://docs.stripe.com/tax/how-tax-works | extract |
| S18 | EUR-Lex, Implementing Regulation (EU) No 282/2011, consolidated 14/04/2025, art. 24f | https://eur-lex.europa.eu/eli/reg_impl/2011/282 | extract |
| S19 | EUR-Lex, Regulation (EU) 2023/1114 (MiCA), art. 149 | https://eur-lex.europa.eu/eli/reg/2023/1114/oj/eng | extract |
| S20 | Congress.gov, Public Law 119-27 (GENIUS Act) | https://www.congress.gov/119/plaws/publ27/PLAW-119publ27.pdf | extract |
| S21 | Stripe Docs, Fee payer behavior for direct charges | https://docs.stripe.com/connect/direct-charges-fee-payer-behavior | live (review) |
| R1 | This repository: AGENTS.md (SR5); docs/stripe-platform-eligibility.md (28/10/2026 decision and Stripe answer); lib/instant-pay.ts; lib/payment-methods.ts; docs/eu-vat-article-9a.md | — | direct |

No price, limit, commission, flag, gate, tax assumption or customer-facing text was changed by this study.
