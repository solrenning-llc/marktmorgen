# Audit of 601 [KB22]: what exists and what is missing

Date: 2026-11-06. Base: origin/main 5c0731550. Audit only; no product code, price, limit, gate or flag changed.
Method: grep of `lib/`, `app/`, `components/`, `package.json`, `vercel.json`; `git ls-remote origin` branch names; `docs/codex-queue.md` items 436, 582, 588, 595, 598, 601 and the branch stats of `claude2/ac1-ach-fees`, `claude2/gr1-invoice-payments`, `claude/kb-kajabi-gaps`. Greps show presence, not behavior: nothing here was run in a browser or against Stripe. Open PRs were not listed (`gh` returned no JSON); only branch names were checked, so a PR with a different branch name could overlap.

Classes: 1 buildable now with no money or gate; 2 done; 3 blocked by an owner gate or decision; 4 needs supplier spend.

Money rule applied: every sale is a direct charge on the creator's own Stripe account, so payment methods are Stripe account settings, never a Marktmorgen balance.

## Table

| # | Sub-feature | (a) In main | (b) Other work | Class | Notes |
|---|---|---|---|---|---|
| 1 | ACH debit | Deliberately OFF: `lib/instant-pay.ts:22` lists `us_bank_account` in `DELAYED_METHODS`; `onlyInstantMethods` (l.37) excludes it from every Checkout Session because access is handed over at "paid". Studio only lists methods the account has on, read-only (`lib/payment-methods.ts:70`, `components/payments-panel.tsx`). | 436 [AC1], branch `claude2/ac1-ach-fees` (fees recorded, queue-only commit) | 3 | Turning ACH on changes the instant-payment rule and the worst-month receiving cost (MR, `lib/receiving-costs.ts`). AC1 decides which periods keep the margin. Do not duplicate. |
| 2 | Installments | Exists: payment plan kind `plan` (`lib/webhooks.ts:1319`, `lib/refunds.ts:444`, `lib/api-sales.ts:147`), 2 to 12 payments (`lib/feature-pages.ts:393`); Klarna/Afterpay "pay later" shown read-only (`lib/payment-methods.ts:50`). The checkout builder file was not located by grep. | none | 2 | Calls and payment requests have no installments by design (`feature-pages.ts:553,623`). |
| 3 | Tax report for the creator | Stripe Tax is switched on per store (`lib/tax.ts:80-134`, `automatic_tax`). No creator-facing tax report found (no grep hit). Sales CSV exists (`salesCsv`, `lib/stats.ts`, `app/api/store/export/route.ts`); whether it has tax columns is unknown. | 595 [KB16] covers other numbers, not tax | 1 | Read-only summary from the creator's own Stripe data, worded as a record, not tax advice. Needs a check that the data is on the creator's account (Stripe Tax reports vs. session `total_details`). |
| 4 | PDF receipts | No receipt PDF. PDF tooling exists: `pdf-lib` and `@pdf-lib/fontkit` (`package.json:15,21`), PDF/UA tagging `lib/tagged-pdf.ts` (H1/H2/P, artifacts, lang, title, XMP), used by `lib/certificate-pdf.ts` (route `app/[handle]/certificate/[id]/pdf/route.ts`) and `lib/form-response-pdf.ts`. The purchase email and its resend exist (`lib/purchase-email.ts`, `app/api/store/resend/route.ts`). Stripe's own hosted invoice can be switched on (`invoice_creation`, `lib/tax.ts:116`, setting `invoices`). | `claude3/certificate-pdf-ceiling`, `claude3/gl7-form-pdf` (same PDF family) | 1 | Reuse `tagged-pdf.ts`. veraPDF and screen-reader checks are not in the repo: stay a stated gap (AX274). |
| 5 | Receipt numbering | None (`receipt_number`/`invoiceNumber` grep empty). | none | 1 | Needs a per-store sequence; where it lives (Redis counter vs. derived from Stripe) is an open design question. Must not renumber on resend. |
| 6 | Batch receipt download | None. Whole-store export exists (`lib/store-export.ts`). | none | 1 | Must be bounded (rows, bytes) like the existing export allowances (`lib/store-allowance`). Depends on 4 and 5. |
| 7 | Multi-line invoices | Cart with several items exists (`components/store-cart.tsx`, `app/api/store/cart`); Stripe invoice has one line per item when `invoices` is on. A creator-issued invoice with several lines does not exist: payment requests are one payment (`lib/feature-pages.ts:623`, `app/api/store/pay-request`). | none | 1 | Extend payment requests to lines with one total; direct charge, same tax path. Open question: request record shape. |
| 8 | Own plan invoices in the studio | No list found. `billing_portal` appears only for buyers' memberships (`lib/membership-manage.ts`). Plan billing is `lib/billing.ts` (platform account). Whether the studio links a portal is unknown. | none | 1 | Read the creator's plan invoices (Stripe `hosted_invoice_url`, already used in `lib/billing-reminders.ts:181`). Selling stays closed (PLANS_ON_SALE) but reading needs no gate; confirm with a synthetic test. |
| 9 | Notification preferences by event | Pieces only: phone alerts (`lib/phone-alerts*.ts`), store number alerts (`lib/store-alerts.ts`), account-change notice that is always sent (`lib/account-notice.ts`). No single per-event-type preference found. | 590 [KB11] has per-contact email categories (different thing) | 1 | Safety notices (account, disputes, closing) must stay non-optional. |
| 10 | Preview of an unpublished product | `app/api/store/preview` and `lib/preview-screen.ts` serve the page editor's desktop/phone preview. A buyer-view link to a draft product was not found. | 593 [KB14] "view the store as a test customer" (adjacent) | 1 | Signed, expiring, noindex link; no checkout from it. |
| 11 | Member directory with social links; branded entry pages | Opt-in directory exists (`lib/help-content.ts:769`, `app/privacy/page.tsx:787`). Social links in it and store-branded sign-in pages not found. | 583 [KB4] community | 1 | New personal data field: consent text, privacy page and `lib/person-data.ts` change together. |
| 12 | Clone a non-course product | Whole-store copy as drafts (`lib/store-copy-rules.ts`, `lib/store-copy.ts`); funnel copy; course copy in 294. | 582 [KB3] already queues product, offer, email, form, page duplication | 2/covered | Do not build here; KB3 owns it. |
| 13 | Edge protection (WAF, CDN) | Strict CSP (`lib/generated-app-policy.ts`, `lib/help-content.ts:1031`); BotID only on sign-in (`lib/bot-check.ts`, `components/signin-form.tsx:43`); no WAF rules in `vercel.json`. | none | 4 | Firewall rules and plan tier are a Vercel account setting. Cost line: hosting/Vercel plan (fixed, FX275) with a dated official price. Unknown, not zero. Needs the owner. |
| 14 | Meta Pixel and GA4 events per step | Pixel ids stored for 6 platforms (`lib/pixels.ts`, kinds meta/google/tiktok/pinterest/x/reddit); server-side Purchase/Lead (`lib/ad-events.ts`, `lib/reddit-conversions.ts`, `app/api/store/ads-event`). Client events for view, add to cart, checkout start not found. | 613 [WP12] (X/Reddit) | 1 | Only with the existing consent path; names per platform from official docs, dated. |
| 15 | Tiers that unlock different content | Done: `lib/tier-rules.ts`, `lib/tier-switch.ts`, `app/api/store/tiers` (2 to 6 tiers, access read from the product the subscription is on now). | none | 2 | |
| 16 | Refund with tax included or not; resend receipt | Resend: done (`app/api/store/resend/route.ts`, 3 a day per sale). Refunds: `lib/refunds.ts`, `app/studio/refund`. A choice to refund tax or not, and its wording, not found. | 270 [GR1] branch touches refunds in stats only | 1 | Check Stripe's refund-of-tax behavior in official docs first (unknown today). |
| 17 | Creator exports and deletes the whole account | Export done (`app/api/store/export/route.ts`, `lib/store-export.ts`, backups). Plan closing and deletion flows exist (`lib/plan-closing*.ts`, `lib/closing-refunds.ts`); a self-serve "delete everything" for the creator was not found. | 598 [KB19] | 1 for delete (needs owner-approved wording) | Deletion must never touch Hazelsong or creator content without the creator's own confirmed action. |
| 18 | `lib/agentic-feed.ts` vs. AI discovery controls | Feeds: `lib/agentic-feed.ts`, `lib/agentic-catalog.ts`, `lib/llms-text.ts` (`app/llms.txt`, Marktmorgen site only); robots are open to every crawler incl. AI (`lib/store-search-check.ts:80`). No per-creator switch. | none | 1 | One setting that drives both feed and robots; default unchanged. |

Class 2 (done): 2, 15, 12 (covered by KB3), resend half of 16, export half of 17. Class 3: 1. Class 4: 13.

## Proposed class 1 units (in order)

Order is smallest risk first, then dependencies. Files marked "(confirm)" were not read in full.

| Unit | Scope | Files it would touch | Acceptance test |
|---|---|---|---|
| U1 | Receipt PDF, one sale (4) | new `lib/receipt-pdf.ts`; route like `app/[handle]/certificate/[id]/pdf/route.ts`; `lib/tagged-pdf.ts` only read | Synthetic Stripe session: PDF has title, `lang`, PDF/UA XMP, reading-order structure tree, amounts equal the session's; wrong store or unpaid or refunded session gets no PDF |
| U2 | Receipt numbering (5) | `lib/receipt-pdf.ts`, a number rule file (new), store data family registered in `lib/data-families.ts` (confirm) | Same sale always gets the same number; two stores never share a sequence; resend never renumbers; the key has a retention rule and a closing entry |
| U3 | Batch download (6) | new route under `app/api/store/`, allowance via `lib/store-allowance` (confirm) | Cap on count and bytes enforced before any generation; over cap refuses with a plain message; ZIP lists files in number order |
| U4 | Tax summary for the creator (3) | new `lib/tax-summary.ts`, studio panel in `app/studio/page.tsx` (confirm), sales CSV columns in `lib/stats.ts` | From a synthetic set of sessions, totals of tax collected per region equal the sum of `total_details.amount_tax`; unknown data shows "not available", never 0 |
| U5 | Own plan invoices (8) | new `lib/plan-invoices.ts`; studio plan card | Lists only the caller's own customer invoices; no other store's; invoice URL shown only when `https`; empty state is plain text |
| U6 | Notification preferences (9) | new `lib/notify-prefs-rules.ts`, `app/api/store/notify-prefs`, studio panel; readers in `lib/store-alerts.ts`, `lib/phone-alerts.ts` | Each optional event honors off; the always-on safety notices cannot be switched off; defaults equal today's behavior |
| U7 | Draft product preview (10) | new signed-link rule, product page read path (confirm) | Link expires; draft renders noindex; no checkout button works from it; revoked on publish |
| U8 | AI discovery switch (18) | `lib/agentic-feed.ts`, `lib/store-sitemap.ts` (confirm), setting in store data | Off means feed 404 and robots disallow the AI user agents named in a dated list; default leaves today's output byte-identical |
| U9 | Per-step pixel events (14) | `lib/pixels.ts`, the store page script (confirm) | Events fire only after consent; each id still passes its shape check; no event name outside the platform's documented list |
| U10 | Refund tax choice and wording (16) | `lib/refunds.ts`, `app/studio/refund` | Only after the Stripe docs check: amounts shown equal what Stripe will refund; synthetic test for tax-inclusive and exclusive stores |
| U11 | Multi-line creator invoice (7) | `app/api/store/pay-request`, `lib/pay-request*` (confirm) | Lines sum to the charge; one direct charge on the creator's account; limits in `REQUEST_LIMITS` unchanged |
| U12 | Directory social links, branded entry (11) | `lib/person-data.ts`, privacy page, community studio | Field is opt-in, erased with the person, shown only to members who opted in |
| U13 | Whole-account deletion (17) | closing flow (confirm) | Needs owner wording first; synthetic test that nothing outside the creator's own store is touched |

U1 to U3 should go together in one lane (shared PDF files); U4, U5, U6 are independent and can run in parallel.

## Unknowns stated

- Open PRs were not enumerated; branch names only. Re-check the open PR list before reserving files (Pedidos repetidos, step 5).
- The checkout code that creates payment plans was not located; item 2 rests on webhook, refund and help text.
- Whether the sales CSV has tax columns, whether the studio links a plan billing portal, and whether store-alerts has per-kind switches were not read.
- Cost lines: U1 to U13 add no supplier spend (PDF made in the existing function, Stripe reads on the creator's account). Redis writes for numbering (U2) and the PDF run time need the worst-case cost row per plan in `tests/plan-cost-registry.ts` before shipping; unknown, not zero. Item 13 needs a dated Vercel price.
- Nothing here was run; no claim that any feature works for a customer.
