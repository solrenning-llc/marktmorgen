# Codex G — review #1824

Exact head 72d966c7ebf13c890c140e4e16320a8a2d6eebd7; merge-base e6e7e1d5210eff2e11f0e6e40dd14dbcb5338cfb. Entire nine-file PR diff read (433 additions /49 deletions), including every sentence of the seven-language dictionary and both generated/documentary changes. It is a merge head; HEAD^..HEAD is empty, so the correct three-dot merge-base diff was used. No product, foreign branch, reservation, CI or merge mutation by G.

## MEDIUM — unknown catalog read generates an incomplete policy

lib/store-policy-input.ts:39–42 promises that an unreadable product catalog will fail instead of silently omitting the cancellation rules. It calls readListings(store,visibleIds(store)) and trusts its reduced list. That reader omits unknown/nonparseable/missing records at lib/catalog.ts:689–701 instead of throwing.

Independent proof uses actual claimHandle, ensureStatsId, addProduct, setProductLink, moveProduct, setSubscription, storeForEmail, policyInput, policyFacts and the repository MemoryRedis. It creates 25 free products, a paid ebook and a paid monthly membership, moves the paid pair to the bottom by the actual writer, and confirms 27 visible / neither paid item in the 24-item catalog head. A healthy read identifies both sold kinds.

At the actual batched GET of the off-head listings only, return one of: [] envelope; each record null; malformed JSON "{"; non-listing JSON "{}". The backing catalog stays intact. All four yield sellsDigital=false, sellsMemberships=false and sections=[seller], instead of an unknown/error state. The known paid catalog is no longer represented in the policy. The page consumes that exact helper result at app/[handle]/policies/page.tsx:43 and therefore has no cancellation/membership section (source-level consequence, not a claimed browser/SSR test).

13 checks /4 causal failures; nine controls pass, including the real-writer setup, actual read intercept for each mode, a thrown transport error remaining unknown, and healthy retry restoring both sold kinds. An exception-only test and the current source-string test do not cover nonthrowing unknown records.

Proof original tests/g1824-unknown-catalog.proof.ts@828de14f6d0b5cda11679f5bdd948844309eb79a. Strict TS found its fixture's monthly Recurring object omitted the explicit defaults trialDays and payments. Identified variant tests/g1824-unknown-catalog-typed.proof.ts@01c1e765e22c9b22ca67e3bfcf56d3e9d9651649 supplies both as 0. All five is() statement texts are identical; both versions reproduce 13/4. Preserve the typed version for the return. No assertion or causal transport case weakened. New helper/page absent from the base: do not describe this residual proof as an unchanged executable test against the pre-feature base.

Require complete known coverage of the requested visible catalog before deriving policy claims, or derive the facts from an authoritative complete representation. Unknown must produce the specified error/unknown state. Do not treat omission as absence of paid products.

## LOW — accessibility inventory is stale

docs/accessibility-inventory.json:1951 records routeInventory.pageTemplates=132. Official generateInventory on the clean exact head produces134. Same generator check on base records132/actual133: the PR adds its policy route but does not update the count, increasing the stale difference by one. Existing accessibility-inventory test16/1 fails. Entire generated comparison has only this numeric difference; no claim of accessibility conformance is made. Regenerate with the official generator and review the derived statement digest; no file changed by G.

## Functional RED / linked checks

Independent tests/g1824-translation-red.proof.ts@98df8d71a318feb8ae59c5fca831332c86cbdc39 uses ONLY the existing policyFacts export, avoiding absent-module compilation as fake RED. Identical bytes on complete base: 4 checks /3 causal failures (German, Portuguese, no seller name) plus English control. Exact head:4/4.

Original seven-file focal selection: policy-page14, policy-words49, policy-facts17, statement77, site-pages12, platform-US-English42 pass (211 checks); inventory16/1 fails as disclosed.
Seven more linked files pass: digital-consent93, agent-coverage13; catalog-reads9, catalog-ceiling5, site-page-append12, plan-cost-registry19, store-data-registry7 node:test tests, 52 total. Thus existing suite selection14 files:13 pass, one inventory failure; custom333 checks includes that single failure plus node52/52, no skipped tests.
Strict scoped TS covers the page, all changed helpers, new tests, the independent functional RED and typed residual proof:0. ESLint all changed TS/TSX plus G proofs:0 errors/warnings; typed variant also checked separately. Public-data scanner3,268 tracked files/0 corrections. Three-dot diff-check0.
No full global build/CI, browser, authenticated creator journey, actual Redis/provider/account operation or legal-language/conformance certification. Dictionary read for technical correspondence and obvious completeness only; no claim that current laws or translations were independently approved by counsel. New all-visible catalog reads/cost envelope are not certified as funded, and unknown is not treated as zero.

Runner tests/g-review-run.mjs@92d2819151af36b546686fd8690a1119b2851b4c. Run: node tests/g-review-run.mjs g1824-translation-red.proof.ts g1824-unknown-catalog-typed.proof.ts .
