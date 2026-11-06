# Meta Marketing API version — November 4, 2026

CX-29(5), confirmed against Meta's official [Graph API versions page](https://developers.facebook.com/docs/graph-api/changelog/versions) on November 4, 2026. The page has separate Graph API and Marketing API tables.

| Table | Version | Release | Retirement |
| --- | --- | --- | --- |
| Marketing API | v25.0 | February 18, 2026 | Not yet specified |
| Marketing API | v24.0 | October 8, 2025 | October 6, 2026 |
| Graph API | v26.0 | July 29, 2026 | Not yet specified |

The Marketing API table has no v26.0 row. It links v25.0 to [Marketing API v25.0](https://developers.facebook.com/docs/marketing-api/marketing-api-changelog/version25.0). That linked page was not needed to establish the table's version and dates and was not independently verified for this change. On this dated evidence, v25.0 is the supported default for reading a store's ad accounts and spend; choosing v26.0 from the separate Graph API table was not supported by the Marketing API table.

The official page returned HTTP 200 through a direct HTTPS GET after the search reader returned HTTP 429. The retrieved HTML's SHA-256 was `049de076e7410210cb1e57fdf743f0057246387f14df9d8324cd32700ac439ef`. This hash identifies that retrieval; it is not an assertion that Meta's dynamic page will keep the same bytes.

`lib/meta-ads.ts` now defaults to v25.0, including consent, token exchange, account reads, spend reads and permission revocation. Its existing `META_GRAPH_VERSION` deployment override remains unchanged. `lib/ad-events.ts` already uses v25.0 and is unchanged.

The concrete benefit is that the existing ad spend reader asks for the Marketing API version Meta currently lists, so creators can use imported spend in their existing results once the integration is configured. Reliable existing results support retention; this change adds no supplier call, charge, spending permission or allowance. No price, limit, commission, opening flag or funding protection changes.

## Verification and limits

`tests/meta-ads.test.ts` exercises the real version selector and integration with synthetic credentials, in-memory Redis and a replaced `fetch`. It checks the default, malformed settings, the preserved explicit setting, consent URL, every provider URL's version, paginated spend reads and revocation. The new checks fail against the previous v26.0 default. The test never reaches Meta or another real provider. The related integration pause tests also run against doubles.

No Meta account was connected, and no live API compatibility, deployed configuration or end-to-end customer use was verified. State: local implementation and directed tests, pending PR and GitHub checks; no claim of customer availability.

Accessibility: no interface, email or customer text changes. Steps and decisions stay the same; no applicable rendered criterion changed and no assistive technology test was performed.
