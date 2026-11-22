# Privacy and personal-data audit — 11 November 2026

Review scope: the default-branch snapshot `7b04206e79d142e08472329247876e9e649420e3`. Required repository guidance was read from `AGENTS.md`, `CLAUDE.md`, and `docs/cross-product-handoff.md`. This is an implementation review, not a legal-conformity certification.

## Areas reviewed

1. **Stored data and providers.** Sampled the privacy inventory, `lib/person-data.ts`, the person-copy and person-erasure registries, buyer library, ad events, and customer-voice flow. Store and buyer records are primarily held in Redis/Upstash; the creator's Stripe account remains the source for card sales and payment records; Marktmorgen keeps operational copies, link records, suppression fingerprints and delivery state. The policy describes Stripe, Upstash/Vercel, email providers, ad platforms and Anthropic where those flows apply.
2. **Retention.** The policy has concrete retention periods for sampled records, including short-lived access links and caches, 400-day records for some buyer operations, three-year buyer-library indexes, and store-close deletion. I did not confirm an additional retention mismatch in the sampled paths.
3. **Access, export and erasure.** `lib/person-copy.ts` refuses to call a person copy complete while a listed module is pending; the person-data and copy registries describe per-store deletion and records retained for a stated purpose. The all-store erasure path has the confirmed gap below.
4. **Logs and errors.** Two submitted code PRs remove raw caught errors from sign-in request and customer-summary logs: #3712 and #3733. The erasure-link flow still logs raw error objects; see the second finding below.
5. **Third-party transfers and legal consistency.** The sampled ad-event flow is limited to creator-configured platforms and the policy describes the consent gate and fields sent. Customer-voice text is sent only when a creator asks for the summary; the code removes emails, phone numbers and URLs, as the policy says. No additional unnecessary transfer was confirmed in these sampled flows. The all-store erasure wording does not match the actual cap.

## Finding P1-1 — All-store deletion silently stops at 60 stores

**Evidence**

- `lib/buyer-library.ts:53-54,79-84` caps `storesKnownFor(email)` at `MAX_LIBRARY_STORES = 60`. The write path records store memberships through `personWrite` without applying that read cap.
- `lib/erasure-rules.ts:129-130` also sets `MAX_ERASE_STORES = 60`.
- `lib/erasure-request.ts:149` takes only the first `MAX_ERASE_STORES` ids for an all-store request. The emailed grant contains that capped list, and its parser rejects grants with more than 60 ids (`lib/erasure-request.ts:263`). No continuation for additional stores is kept.
- Privacy Policy section 8 says the person can delete their data “from every store” they bought from or joined themselves.

**Concrete scenario**

An address present in 61 distinct open stores has only the first 60 stores included in the deletion grant. Confirming the link can finish and remove that grant; the 61st store is neither erased nor queued for a later press, although the page promises deletion from every store.

**Owner review requested**

Keep the published 60-store library display ceiling unchanged. Design a bounded continuation for the erasure flow so it enumerates all known stores in batches and cannot report completion until every store is processed. Review the Privacy Policy wording against the corrected behavior before release. The relevant erasure files have active scoped reservations, so this audit did not edit them.

## Finding P1-2 — Erasure-flow exceptions can put personal data in infrastructure logs

**Evidence**

- `lib/erasure-request.ts:166-168` logs the raw exception from the background task that looks up stores and sends the deletion link.
- `lib/erasure-request.ts:320` logs the raw exception while notifying a store owner after erasure. These paths handle the submitted address and email-provider requests; an exception may contain recipient or request details.
- The policy describes the support-email record but does not describe these raw exception payloads or their log retention.

**Owner review requested**

Replace raw error objects with fixed operation labels, and test using a synthetic exception containing a fake address and token. This file has an active hunk-scoped reservation through PR #3066; the finding is recorded for coordination and was not edited here.

## Change boundary

This report does not modify the public Privacy Policy or Terms. No prices, visible limits, commissions, sale flags, gates, or creator content were changed.
