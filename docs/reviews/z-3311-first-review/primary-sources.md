# Public primary-source check, 8 November 2026 UTC

https://docs.stripe.com/api/v2/core/accounts/object (retrieved through the public search tool, turn11view0) identifies the V2 account object and describes requirements and configuration as nullable. Its example includes an active card-payments capability. This corroborates the actual field path and top-level nullability only.

The API is pinned in the reviewed source to 2026-08-26.dahlia. The version-qualified page and nested field query links returned inaccessible/internal errors in this environment. Targeted official-domain searches did not resolve the nested enums. No exact pinned-version enum or nested-summary nullability was independently established from those failed lookups. The old fixtures' inactive string is not certified as a documented Stripe enum by this review.

No CLI installation, authenticated API, account operation, vendor contact, payment, or real provider call was made. The fault-injected whitespace/future_unknown probes prove handling of unknown strings in the actual consumer; they are not claims that Stripe emitted either response in production.
