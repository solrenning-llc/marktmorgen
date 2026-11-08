# Buyer metadata language inventory

Base: `a34da184802c2d5bd656498ddd044312aecff9f6`.
Assignment: C4-20261106-0945-U-49. This records the rule 30 sibling search for a
known store losing its language when a buyer page is unavailable.

## Corrected scope

`app/[handle]/media-kit/page.tsx`, `generateMetadata`: resolve the store before
testing whether its media kit is shown. A known, active store with an unavailable
kit uses its existing `missingTitle` and store name. Unknown and suspended stores
keep the general fallback and no-index/no-follow. Published metadata and page
rendering are unchanged. This replaces the existing metadata lookup; it adds no
lookup or provider operation.

The permanent test is byte-identical to public evidence
`09a22a2b2169d23d01765b7f7cc2c4428cb17e44`, renamed to
`tests/media-kit-metadata-language.test.ts`: 18 checks, seven failures and eleven
passing controls on the base; all 18 pass after the correction. It exercises all
seven languages, published titles and the absent-store fallback.

## Sibling search

Static search covered the 49 `generateMetadata` declarations under
`app/[handle]`, including literal general not-found titles and the booking
fallback. The following are coordination leads, not a claim that their current
owners or latest heads have been reviewed. No sibling product file is changed.

| Page | Same-pattern lead on the pinned base | Existing evidence or coordination boundary |
| --- | --- | --- |
| `[slug]/page.tsx` | A filtered page lookup loses the known store before the general fallback. | U public evidence `5860e022`; classification pending. |
| `blog/page.tsx` | A known store with no posts takes the general fallback. | U evidence `a4b7b3fd`; blog family coordinated with Codex T. |
| `blog/[post]/page.tsx` | The filtered post lookup can discard the known store. | Blog family; separate causal test and ownership check required. |
| `letters/page.tsx` | The filtered list lookup can discard the known store. | Separate causal test and ownership check required. |
| `letters/[letter]/page.tsx` | The filtered letter lookup takes the general fallback. | U evidence `8fa3c58e`; Claude 5 announced this file for mail-picture ownership work. |
| `p/[product]/page.tsx` | A filtered product lookup can discard the known store. | Product-page/PF1 coordination boundary; no expansion into Codex C2's work. |
| `p/[product]/reviews/page.tsx` | A known store with an absent or hidden product takes the general fallback. | U evidence `19f20879`; separate attribution/release required. |
| `shop/[collection]/page.tsx` | The filtered collection result may hide the store context. | Catalog family; separate causal test and ownership check required. |
| `book/page.tsx` | The booking fallback is a general English title. | U evidence `a9ebb661`; booking-family coordination required. |
| `page.tsx` | The general fallback follows an absent store. | No known-store language defect established by this search. |

Existing evidence identifiers refer to durable U branches reported in the
coordination channel. They are not new RED executions in this change. Claude 4
assigns follow-up corrections; uncertain ownership is never treated as freedom
to edit. Privacy, suspension, listing visibility and failure handling require
their own review before changing sibling fallbacks.

## Validation and limits

Directed suites: media metadata 18/18, store kit 17/17, store language 980/980.
Selected-root TypeScript: two roots, zero diagnostics. ESLint: zero errors.
Public-data scanner: 4,212 files, zero corrections. Diff whitespace check passes.
The test uses the repository's synthetic Redis fixture and real metadata
function. No real browser, native Redis or external provider was exercised.
