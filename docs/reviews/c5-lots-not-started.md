# Completeness audit, lots 1-8: items still "not started" (checked against main on 06/11/2026)

Source: `docs/completeness-audit/lot-01..08.json` (lots 3, 4, 6, 7, 8 read from their `claude5/completeness-lot*` branches, lots 1, 2, 5 from main). Lots 2 and 3 have no "not started" item. Fifty-eight items were "not started" or "unclear" in the audit; each was re-checked against main at `91d6bb50d` (grep of lib/, app/, components/, docs/, `git branch -r`, `docs/reservations/*.md`).

Classes: (1) still missing, buildable now with no money and no gate; (2) done since (or mostly present); (3) blocked by an owner gate or decision (PLANS_ON_SALE, tax gate, art. 9a, commercial review, opening, supplier account or contract); (4) needs a supplier cost line and Claude 4's approval first; (5) another agent has it.

Counts: class 1 = 33, class 2 = 2, class 3 = 11, class 4 = 9, class 5 = 3 (total 58).

Nothing in this file changes a price, limit, commission, flag or gate.

## Table

Evidence "q:NNN" is a line of docs/codex-queue.md.

| # | Tag | What the item asks (one line) | Class | Evidence |
|---|-----|-------------------------------|-------|----------|
| 10 | D7 | Path: imported products/pages may meet matching facts; import never creates a confirmed lead or sale | 1 | q:2233 "a fazer"; lib/path-facts.ts and lib/path-rules.ts have no import source. |
| 11 | D8 | Factual weekly summary inside the studio (saved time zone); email only if justified | 1 | q:2239. A weekly email already exists (lib/stats-report.ts:4); the studio summary does not. Build only the difference. |
| 12 | D9 | Path levels from PayPal day-7 data, server-confirmed, refunds subtracted | 1 | q:2245; lib/path-facts.ts:22 leaves PayPal money unknown (null); lib/paypal-sales.ts exists to read it. |
| 13 | D10 | Path lead only when the address used the confirmation link | 1 | q:2251; lib/path-facts.ts:154-161 counts `fs:` form fields, not confirmation. Verify before building: lib/path-campaign.ts:9 already says confirmation counts (possible partial overlap). |
| 14 | D11 | "Made with Marktmorgen" badge off by default, creator-controlled | 3 | q:2260 (Claude 2, 01/11): badge exists, ON by default, removable only with `canUse(store,"branding")` (lib/store-look.ts:120-133). The item asks the opposite and touches a plan right; the owner chooses. |
| 15 | D12 | Owner panel (same panel as 445-447 GE1-GE3) | 1 | q:1537, q:2265. No owner panel in app/. Internal only, no customer impact. |
| 16 | D13 | Optional groups of up to 6 creators, pseudonyms, check-in missions | 3 | q:17320: "Executar depois da abertura, na ordem AV1". |
| 18 | E1 | AI tutor in lessons | 4 | q:2351; AI spend. q:17208 (LQ6): the tutor stays failed until a new cost review. Needs `ASSISTANT_POOL`-style ceiling and a cost line. |
| 19 | E2 | Community challenges with start/end, daily tasks, points | 1 | q:2368; no challenge code (`ls lib` has none); lib/community-points.ts is the base. Branches `claude2/e2-*` are other items (E2-MEMBER-PUBLICATIONS etc.). |
| 20 | E3 | AI-built automation from a goal, creator approves | 4 | q:2374; overlaps 227 [HL8]; AI cost. |
| 21 | E4 | AI content coach add-on | 4 | q:2380; AI cost, never in trial. |
| 23 | E6 | Phone question and checkbox question at checkout | 2 | Phone field exists: lib/checkout-fields.ts:31,38. The checkbox part is 387 [TB13] (q:11136, "na fila"), so nothing new for 23. |
| 24 | E7 | Course access expiry on a creator-chosen date, points for finished lessons | 1 | q:2422; no expiry in lib/learn.ts or lib/course*.ts (only unrelated `expiresAtMs` in lib/course-origin-binding.ts). |
| 25 | E8 | Scheduled report by email | 1 | q:2428. Same work as 405 [HX1] (q:11391, "na fila"); do them as one unit. Reuse lib/stats-report.ts. |
| 26 | E9 | Optional AI explanations in page and funnel reviews | 4 | q:2434; AI allowance cost. Fixed checks already exist (lib/page-coach.ts). |
| 29 | E12 | More team seats than 5 | 1 | q:2453; lib/team.ts:48 `MAX_TEAM = 5`. Raising a limit needs the plan margin to allow it on both intervals, so first run `node scripts/margin-alignment.mjs`. Low priority. |
| 30 | E13 | Exit warning at checkout | 2 | Exit offer exists: components/exit-offer-slot.tsx, app/api/store/exit-offer/route.ts, lib/store.ts:664. Checkout is hosted by Stripe. Only a difference could remain; none is named. |
| 32 | F1 | Freer page builder | 1 | q:2601; components/page-editor.tsx is block based. Large; split by block. |
| 33 | F2 | Public Apple/Spotify podcast and RSS import | 4 | q:2608. lib/podcast-rules.ts:119-120 emits private per-buyer feeds with `itunes:block Yes`. A public feed means unmetered audio egress: needs a bandwidth ceiling and cost line. |
| 34 | F3 | Individual client portal for mentoring | 1 | q:2614; overlaps 385 [TB11]. Large. |
| 35 | F4 | More caption languages and AI dubbing, billed by use | 4 | q:2620; lib/captions.ts and lib/auto-captions-rules.ts exist; dubbing and extra languages are supplier spend. |
| 36 | F5 | In-person tickets with QR check-in | 1 | q:2626; lib/community-events.ts exists, no ticket/check-in code. |
| 37 | F6 | Export sales for Xero and QuickBooks | 1 | q:2632; no code (only lib/demo-file.ts matched). A file export needs no supplier. |
| 38 | F7 | Measured speed/mobile comparison with competitors | 1 | q:2638; document only; no such doc in docs/. Must list what could not be measured. |
| 39 | G1 | Document Meta requirements (AutoDM, comments, inbox, WhatsApp), then code ready and off | 1 | q:2726. Pure AutoDM rules exist (lib/autodm-rules.ts, item 480). Only the requirements document is missing; any API use stays off until approval. |
| 40 | G2 | Schedule posts to Meta and TikTok | 3 | q:2732; needs Meta/TikTok app review (external accounts); overlaps 228 [HL9]. |
| 41 | G3 | Document Google Business Profile, review-reply prepared and off | 1 | q:2738; document part only. AI reply drafts would be class 4. |
| 44 | H1 | Study: iPhone app | 1 | q:2758 "SOMENTE DOCUMENTO". Document only. |
| 45 | H2 | Hosted live streaming, per-minute price, automatic ceiling | 4 | q:2766; video supplier spend per minute. |
| 269 | KT3 | Describe each plan by the creator's stage | 1 | q:6492. components/home-parts.tsx:400 and :408 `bestFor` do not name a stage; only :416 (Scale) does. |
| 286 | SX2 | AI post-topic suggestions for the community | 4 | q:7816; AI cost; no code (grep found none). |
| 331 | RC1 | Stripe Tax per transaction | 3 | q:9396, after 320 TK2. lib/tax.ts:82 sets `automatic_tax` only; tax gate and a Stripe Tax fee (cost line) both apply. |
| 334 | RE2 | 3D Secure on the first payment of monthly plans | 3 | q:9473 "after 333 RE1", opening block. lib/billing.ts:354 asks 3DS only for `cycle === "year"`. Changes live billing; opening order. |
| 335 | FR1 | Annual tax reports generated by code | 3 | q:9527 "depois do Bloco de abertura"; depends on tax policy TX. |
| 338 | HZ3 | Stop Hazelsong consuming the shared budget without deleting it | 3 | q:9805; needs read access to the Vercel project and real invoices (external account); no docs file exists. |
| 345 | RN3 | Study: paid themes and store templates | 1 | q:9953; no study in docs/ (only docs/ht15-template-library.md). Document only, no build. |
| 402 | WX3 | Study: stablecoin payments through the creator's Stripe | 1 | q:11288; deliverable `docs/stablecoin-payments-study.md` absent. Document only. |
| 426 | BX2 | Earnings by month and source | 1 | q:11668. No such screen (app/studio/totals/page.tsx sums windows only). Sponsorship source 355 [ES1] is not built (no sponsor code), so ship Stripe plus "entered by you" sources first. |
| 435 | PV5 | Permanent cost-savings register and studies | 3 | q:12001, q:14732: moved after opening (AV1). docs/cost-savings.md holds only the initial inventory. |
| 442 | SV2 | Provider swap roadmap | 3 | q:1761: SV items only after opening, no new PRs; also waits on 441 SV1. |
| 576 | FT8 | "Product bundle" funnel type | 1 | q:21239. lib/funnel-types.ts ids: lead-magnet, training, challenge, launch, book, first-purchase, application, quiz. lib/bundle-rules.ts, lib/cart-bundle.ts exist to reuse. |
| 601 | KB22 | Check and build what is missing: ACH, tax report, PDF receipts, multi-line invoices, notification preferences, etc. | 1 | q:21655; an audit unit first. |
| 618 | SZ2 | Legal fields for physical goods (GPSR, Prop 65, unit price, prior lowest price) | 1 | q:21955; no `gpsr`, `unitPrice`, `lowestPrice`, `priceHistory` in lib/app/components. Physical products exist (lib/catalog.ts:247, lib/shipping.ts). |
| 620 | SZ4 | Member and past-buyer prices via Stripe on the creator's account | 1 | q:21918; no "Member price" (lib/billing.ts:1540 is unrelated). Pattern: lib/member-discount.ts. |
| 621 | SZ5 | One store in several buyer languages, own URLs, hreflang, selector | 1 | q:21921; no `hreflang` anywhere. Any machine translation would be class 4; the rules/URLs/selector need none. |
| 622 | SZ6 | One reminder for a product viewed and not bought (consent only) | 1 | q:21924; no trigger. Uses the plan's existing email allowance; confirm no new supplier line. |
| 623 | SZ7 | Back-in-stock, low-stock alerts, per-buyer limit | 1 | q:21927; no code. Email follows the waitlist pattern (existing allowance). |
| 625 | HN1 | Study: DAC7, OECD reporting, EU AI Act art. 50 | 1 | q:22014; only sources gathered (docs/official-texts-eu-2026-11-02.md); conclusions doc absent. Document only. |
| 626 | HN2 | Money-back guarantee field per product with one-click request | 1 | q:22017; only a free-text "guarantee" block (components/page-editor.tsx:1388) and the plan's own refund words (lib/plan-refund-words.ts). |
| 627 | HN3 | High-ticket plans: first payment, delay, up to 24, private links | 1 | q:22020; plan exists in lib/store-checkout.ts and lib/catalog.ts; no first-payment field or link-only plan. Overlaps 381 [TB7], 304 [GH1], 604 [WP3]: do only the difference. |
| 628 | HN4 | Paid extra module and "More from" shelf | 5 | `origin/claude3/hn4-shelf-rules` (3 commits ahead, 05/11), open PR #1932 per audit; inbox C3-26 gives part (b) to Claude 3. |
| 629 | HN5 | Sell an AI guide trained on creator content | 4 | q:22026; AI cost and "built off until the owner prices it". |
| 633 | GL1 | Study: DPA, public subprocessor list, sanctions | 1 | q:22178; no docs; study only (the public page needs legal review). inbox assigns it to Claude 2's lane. |
| 638 | GL6 | Lead ads into list and CRM | 3 | q:22178; Meta/Google/TikTok app reviews are external; the study part alone is class 1. |
| 640 | TF1 | Per-plan fee on creators' own sales and 8% storefront fee | 3 | q:22294; `COMMISSION_BPS` 625/275/0 (lib/plan.ts:67), `COMMISSION_LIVE` false: commission change, owner and opening. |
| 641 | WG1 | Give a member free days | 1 | q:22351; no creator-granted free days (lib/membership-pause.ts is the member's own pause). |
| 642 | WG2 | Retire a price option without cancelling subscribers | 5 | `origin/claude2/wg2-option-off-sale` (21 ahead), `wg2-option-count` (45 ahead), 06/11. |
| 643 | WG3 | Checkout look different per link | 5 | docs/reservations/codex.md:125 reserves "643 [WG3] part A" (`codex/p-short-link-theme`, lib/checkout-branding.ts). |

## Proposed one-PR units (class 1, no money, no gate), by customer impact

Every unit: US English UI text, WCAG 2.2 AAA (7:1 text contrast, 44x44 px targets, labels, error messages that say how to fix, no overlay widgets), the PR "Acessibilidade" section, a RED test first, synthetic data only. Re-check `git branch -r` and the reservation files before starting.

1. **626 [HN2] Money-back guarantee field.** Build: `guaranteeDays` (none, 7, 14, 30, 60; first charge only for subscriptions) on the product, a pure `lib/guarantee-rules.ts` (parse promised days from the Guarantee block, refuse publishing a contradicting text), shown on page, thank-you and confirmation email; one-click request in /orders that opens the existing refund path. Files: lib/catalog.ts, new lib/guarantee-rules.ts, components/page-editor.tsx (block at :1388), app/api/store/product/route.ts, buyer orders page. RED: a "30-day" block with a 14-day field is refused. A11y: a real label and an error that names the field; the request button is a native button with a visible name.
2. **627 [HN3] First payment, interval and link-only plan.** Build: entry amount, delay and up to 24 weekly/monthly parts on the existing plan, total never below price, expiring private link; the schedule is written on the creator's Stripe. Files: lib/store-checkout.ts, lib/catalog.ts, product route, confirmation email. RED: schedule built for 300 + 3x(rest) sums to at least the price, expired link opens no checkout. A11y: schedule as a table with dates in words, not only color.
3. **641 [WG1] Free days for a member.** Build: studio action that moves the next charge on the creator's own Stripe subscription (owner-bound, re-read on the server, refuses a member not of this store), modelled on lib/member-discount.ts. Files: new lib/member-free-days.ts, studio member route/component. RED: another store's member is refused; a past-due member is refused. Retention value, no platform cost.
4. **620 [SZ4] Member and past-buyer prices.** Build: rule "holders of X pay Z% less on A and B", "Member price" on the product page after the buyer proves the address by the existing course/library path, discount applied by Stripe on the creator's account. Files: lib/discount.ts, new lib/member-price-rules.ts, product page. RED: unproven address sees the normal price only. A11y: both prices stated in text; never color only.
5. **24 [E7] Course expiry and points for finished lessons.** Build: optional access end date per course (read at lesson open on the server), points through lib/community-points.ts. Files: lib/learn.ts, lib/course*.ts, studio course settings. RED: access after the end date is refused, an unset date never expires. A11y: warn the student in words before access ends.
6. **623 [SZ7] Per-buyer limit first (part c), then back-in-stock.** Part (c) needs no email. Then confirmed "Email me when it's back" following the waitlist pattern, charged to the plan's existing email allowance. Files: lib/catalog.ts, waitlist code, checkout limit check.
7. **618 [SZ2] Physical-goods legal fields.** Fields for manufacturer/EU responsible person, safety notes, Prop 65 text, unit price, prior lowest price shown only when true. No wording like "compliant"; the creator supplies the facts. Files: lib/catalog.ts, lib/shipping.ts, product page.
8. **576 [FT8] "Product bundle" funnel type.** Add one entry to lib/funnel-types.ts using lib/bundle-rules.ts; the "sum of separate prices" only when true and computed by code. RED: false saving is not shown.
9. **426 [BX2] Earnings by month and source.** Stripe (creator account) plus "entered by you" lines, CSV with formula protection. Files: app/studio/totals, lib/stats.ts. RED: a CSV cell beginning `=` is escaped.
10. **37 [F6] Xero/QuickBooks CSV export.** File export only, no API. **269 [KT3]** copy: Store "for those starting", Studio "for those growing" in components/home-parts.tsx:400,408 (no price or limit change).
11. Then **19 [E2]**, **11 [D8]** (studio card only), **12 [D9]**, **10 [D7]**, **25 [E8] + 405 [HX1]** together, **622 [SZ6]**, **621 [SZ5]** (URL rules and selector first), **36 [F5]**, **32 [F1]**, **34 [F3]**.
12. Document-only units (can run in parallel, need dated official sources, no code): 345 [RN3], 402 [WX3], 625 [HN1], 633 [GL1], 38 [F7], 39 [G1], 41 [G3], 44 [H1], 601 [KB22] audit.

## Notes for the owner-facing queue

- Items 14, 16, 40, 331, 334, 335, 338, 435, 442, 638, 640 must not be started: they wait on an owner decision or the opening order.
- Items 18, 20, 21, 26, 33, 35, 45, 286, 629 each need a supplier cost line and Claude 4's approval first.
- The audit's "not started" state for 23 [E6] and 30 [E13] is outdated: both are mostly present in main.
