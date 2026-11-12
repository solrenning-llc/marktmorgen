# External-page attribution study

**Date:** November 5, 2026
**Status:** Study only — before implementation

This study defines the evidence required to count activity on a creator-owned external page without a Marktmorgen checkout. It does not make that capability available today. This change contains no script, endpoint, account, vendor setup, acceptance of terms or production request. A later implementation needs its own reservation, RED, cost proof, privacy review, accessibility review and final CI.

## Decision

Do not implement or advertise the external-page counter yet. The useful, honest primitive is an **accepted page event**, not a visit by a known person. It is not a unique person, not a sale and not revenue attribution. When the page never reaches a Marktmorgen checkout, revenue remains **unknown**.

Item 630 [HN6], resource 36 currently says “visits”. Before product work, that word must either be narrowed in product copy to aggregated external-page events or be supported by a separately reviewed, consented and funded deduplication design. This study chooses no person profile and no persistent identifier.

The operating cost is **unknown, never zero**. There is no finite launch budget until verified supplier and infrastructure costs cover the request, function execution, logs, storage writes and reads, retention, export and deletion. The feature therefore remains disabled by default.

## Official source record

| Official source | Dated source used | What it bounds here |
| --- | --- | --- |
| [EDPB Guidelines 2/2023 on Article 5(3) of the ePrivacy Directive](https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-22023-technical-scope-art-53-eprivacy-directive_en) | Version 2.0 adopted October 7, 2024; final page October 16, 2024 | Access to or storage on a device can include URLs, pixels, local processing and identifiers; the scope is not limited to traditional cookies. This is not a finding that a particular design is exempt. |
| [EDPB Cookie Banner Taskforce report](https://www.edpb.europa.eu/our-work-tools/our-documents/other/report-work-undertaken-cookie-banner-taskforce_en) | Adopted January 17, 2023 | Refusal must be real, consent must not be preselected, and withdrawal must be available. National implementation can still differ. |
| [EUR-Lex: Regulation (EU) 2016/679, Articles 5 and 7](https://eur-lex.europa.eu/eli/reg/2016/679/oj) | Regulation dated April 27, 2016 | Data minimization and demonstrable, withdrawable consent. |
| [EUR-Lex: Directive 2002/58/EC, Article 5(3)](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02002L0058-20091219) | Consolidated text dated December 19, 2009 | Device storage/access must be assessed before an optional script or identifier is used. |
| [ANPD: Guia orientativo — Cookies e proteção de dados pessoais](https://www.gov.br/anpd/pt-br/documentos-e-publicacoes/guia-orientativo-cookies-e-protecao-de-dados-pessoais.pdf) | Published October 18, 2022; official page modified January 23, 2025 | Brazilian guidance for purpose, necessity, transparency, consent and easy rejection/management. |
| [ICO: Storage and access technologies](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/cookies-and-similar-technologies/) | Official guidance current when retrieved | Pixels, link decoration and scripts can be storage/access technologies; purpose-specific consent and withdrawal matter. |
| [California Privacy Protection Agency FAQ](https://cppa.ca.gov/faq.html) | Official page current when retrieved | Global Privacy Control can communicate an opt-out; minimization and deletion remain relevant. The FAQ is guidance, not legal advice. |
| [W3C Referrer Policy](https://www.w3.org/TR/referrer-policy/) | Candidate Recommendation January 26, 2017 | A page can reduce cross-origin URL leakage with no-referrer or origin-only policy. |
| [ClickFunnels: Custom HTML/JavaScript element](https://support.myclickfunnels.com/docs/how-to-use-the-custom-html-javascript-element) | Published November 15, 2024; updated October 27, 2026 | Competitor precedent for code on an external page, with an explicit warning that custom code can break a page. It is not a privacy endorsement. |
| [WordPress: Custom HTML block](https://wordpress.com/support/wordpress-editor/blocks/custom-html-block/) | Last reviewed October 5, 2026 | External sites commonly accept static embedded markup. It does not establish permission to track. |
| [Whop: attribute affiliates in an embedded checkout](https://docs.whop.com/third-party-integrations/embedded-checkouts/attribute-affiliates-embedded-checkout) | Official documentation current when retrieved | Competitor precedent: a parameter can be carried into an embedded checkout and a completed checkout can confirm a sale. It does not prove a visit or a person. |

All links above were **Retrieved November 5, 2026**. Legal applicability remains a review question for the later implementation; this study does not claim a universal consent exemption.

## Consent and browser-refusal boundary

The only acceptable bootstrap is inert inline markup that performs no optional storage and makes no Marktmorgen request. For an unknown country, the conservative path is to ask before loading the script and before the first network request. A later implementation must document the exact regions where another lawful basis is relied on; uncertainty is not treated as permission.

The order is mandatory:

1. Render the creator’s own page with the external counter inactive.
2. Show purpose-specific controls in the page’s own consent surface; refusal is as easy as acceptance.
3. Read browser refusal signals locally. **Global Privacy Control** overrides an older optional acceptance for this measurement.
4. Only after a positive applicable decision may the page load the bounded script and make its first Marktmorgen request.
5. Offer withdrawal from the same surface. Withdrawal stops future requests and clears any optional local state.

The invariant is: **no consent means no request and no storage**. A refusal, absent answer, malformed answer or unknown decision must not be converted into an event. Marktmorgen must not infer acceptance from scrolling, continued browsing, a closed banner or another product’s consent.

## Minimized event boundary

A future creator setup would issue a scoped public token bound to one store and an **allowlisted HTTPS origin**. The server would verify the Origin header against that binding. The payload may contain only:

- the bound store/token reference;
- a coarse **normalized path category** chosen from an allowlist, not the literal path when it can contain personal data;
- allowlisted, length-bounded **campaign tags** such as cleaned source, medium and campaign values;
- a coarse event time bucket generated by the receiver.

The browser and application **must not send or store** the **full query string**, **full referrer**, **IP address**, name, **email**, fingerprint, user-agent-derived identity or any **persistent cross-site identifier**. No vendor pixel IDs are accepted in this channel. Although network infrastructure necessarily observes an IP address while routing a request, application code must not copy it into the event; the later review must separately verify infrastructure logs, access, redaction and retention.

A restrictive referrer policy should send no referrer or origin only. Campaign values must be stripped of unexpected keys and control characters before they are admitted. Unknown fields reject the event rather than being retained “for later”.

**Campaign tag values must reject personal data before any normalization.** An email-like, name-like, phone-like, account-like or high-entropy identifier value must reject the whole event. The receiver must not strip or hash an email or other personal data and retain the transformed value. The existing campaign cleaner is therefore not sufficient on its own: a later implementation must apply and test this refusal before calling that cleaner, and an uncertain value fails closed.

## Honest measurement and attribution

The receiver may aggregate accepted events by store, day, allowlisted origin, normalized path category and cleaned campaign tags. Retries are not proof of another visitor. Without a separately funded, consented deduplication design, the UI must **never label the count as a unique visitor**, “people”, “buyers” or “sales”.

The readings remain distinct:

- **Accepted page event:** a bounded request that passed consent, origin, schema, allowance and storage acknowledgement.
- **Visit/person:** not established by this design.
- **Sale:** established only by a completed Marktmorgen checkout (or another separately verified commerce event), never by page activity alone.
- **Revenue attribution:** can be shown only from the existing attribution rules after a confirmed sale carries the accepted campaign context.
- **Buyer answer:** the existing post-purchase buyer answer remains a separate declared source of evidence; it is not silently merged into measured clicks.

If a later external page sends the buyer into a **Marktmorgen checkout**, the existing bounded attribution context may connect that checkout to a confirmed sale. If no Marktmorgen checkout occurs, sales and revenue attribution remain **unknown**, even when the creator reports revenue elsewhere.

## Reuse; do not create a second tracking center

A later implementation must extend the existing boundaries rather than add parallel settings:

- docs/ht10-pixels-attribution.md remains the disclosure and product-language baseline;
- lib/attribution-rules.ts remains the source for attribution windows and honest table semantics;
- lib/embed-sdk.ts remains the one external bootstrap/integration surface;
- lib/embed-sites.ts remains the allowlisted-site boundary;
- lib/traffic.ts remains the traffic normalization boundary.

The creator must have a **single canonical pixel and attribution center**. Do not add a second pixel registry, a second consent preference, a second campaign table or a vendor-specific identity. The event accepts no vendor pixel IDs. This study does not expand the existing advertising pixels or their provider identifiers.

## Cost, abuse and lifecycle gates

No event may be accepted merely because an endpoint is reachable. The system reserves a **prepaid allowance** before accepting the event; it must cover the worst-case request, compute, log, write, later read, retention, export and deletion work. A rejected, malformed, refused or over-limit request is not counted as accepted.

A funded implementation must include all of the following in one atomic admission decision:

- an exact token/store/origin binding;
- a **per-origin rate limit** and per-store limit;
- a **payload byte limit** before parsing unbounded data;
- a fixed field allowlist and bounded strings;
- a finite **retention ceiling** for raw accepted events and aggregates;
- creator export and **deletion**, including store closure;
- an explicit **refund** rule when allowance was reserved but a proven write did not occur;
- fail-closed handling when a write or acknowledgement is missing or malformed.

There is **no finite launch budget until verified supplier and infrastructure costs** are recorded for every paid operation in the monthly and yearly worst case. Free tiers do not make the cost zero. Until that proof and the product tests exist, the feature is **disabled by default**.

## Required next evidence

1. Revalidate the official sources and the production architecture on the implementation date.
2. Produce the exact cost registry entry and prepaid allowance before any network or storage work.
3. RED-test consent/refusal/GPC, unknown country, origin binding, payload limits, unknown acknowledgements, retention and deletion.
4. RED-test every UI phrase so an accepted page event is never promised as a person, visit, sale or revenue.
5. Coordinate public-page accessibility and shared files before changing the embed or attribution surfaces.
6. Require independent review and all final workflow aggregators on the exact implementation head.

This document is the preimplementation decision record for existing queue item 630 [HN6](36). It neither completes that resource nor authorizes product code.
