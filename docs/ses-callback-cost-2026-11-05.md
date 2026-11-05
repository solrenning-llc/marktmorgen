# DR1: callback funding evidence and the remaining activation barrier

Evidence checked: November 4, 2026 (America/Fortaleza). File date: November 5 UTC.

**Status: evidence only, not admission. CURRENT_MAIL_REPORT_ADMISSION remains null. callbackAttemptsPerEmailCeiling remains unknown.** No report operation, SES setting, subscription, price, entitlement or flag changes. The preparatory implementation is #2321, source `codex/h-dr1-event-time`; its tests establish inactivity before Redis, not financial coverage. 30-day retention is not shipped.

This records independently checked public tariffs and an exact arithmetic counterexample to adopting the largest HTTP/S retry scenario under the present compute envelope. It does not certify the owner's accounts, a current bill, a complete worst month, profitability or permission to enable Delivery/DeliveryDelay.

## Official evidence

### Amazon SNS: publications, deliveries and bytes

- [SNS FAQ](https://aws.amazon.com/sns/faqs/): USD 0.50 per million publish/API requests and USD 0.06 per 100,000 HTTP deliveries, equivalent to USD 0.60 per million. HTTP and HTTPS are the supported URL transports.
- [SNS pricing](https://aws.amazon.com/sns/pricing/): Standard-topic publications and deliveries are metered in 64 KB chunks. Outbound transfer is separate. KMS, payload filtering and other optional services can add charges; their absence in the live topic has not been established. No free-tier allowance reduces this evidence's rates.
- [Official AmazonSNS us-east-1 price file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonSNS/current/us-east-1/index.json), publicationDate `2026-11-04T21:35:13Z`: SKU `QDX8G2WMY9NPXXPG`, Requests-Tier1, paid USD 0.0000005000/request; SKU `5N4XS8YGXD4JGDTN`, DeliveryAttempts-HTTP, paid USD 0.0000006000/notification. The zero-priced ranges are excluded. The latter SKU names attempts; duplicate delivery does not create a free hosting invocation.
- [Official AWSDataTransfer price file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/index.json), publicationDate `2026-11-03T13:31:47Z`: SKU `HQEH3ZWJVT46JHRG`, AWS Outbound, US East (N. Virginia) to External, DataTransfer-Out-Bytes, USD 0.0900000000/GB in the first paid tier (0–10,240 GB), then 0.085/0.070/0.050. USD 0.09/GB is a conditional us-east-1 public-rate ceiling for that path, not proof of the live Region, taxes or contract. The earlier calculator's USD 0.20/GB example is a sizing assumption, not a verified account tariff. Do not silently replace unknown live transfer with either figure.

The two public price files were retrieved without AWS authentication. Their regional and service attributes were matched before reading the paid dimensions. A pricing page whose interactive table is absent is not evidence of zero transfer cost.

### Attempts are not the whole lifecycle

[SNS HTTP/S retry policy](https://docs.aws.amazon.com/sns/latest/dg/sns-message-delivery-retries.html) allows `numRetries` from 0 to 100, default 3, and at most 3,600 seconds for an HTTP/S retry policy. Thus an initial attempt plus 100 configured retries gives the 101-attempt scenario. HTTP 429 and 5xx are retryable. `maxReceivesPerSecond` controls an average rate and permits spikes; it is not a monthly spending ceiling.

**101 is a retry-policy scenario, not a proven whole-email lifecycle ceiling.** [SNS Standard topics](https://aws.amazon.com/sns/features/) provide at-least-once delivery and can deliver duplicates. [SES notification contents](https://docs.aws.amazon.com/ses/latest/dg/notification-contents.html) permits recipient notifications to split and describes a delay notification on each soft bounce when configured. Four stored outcome columns cannot establish a maximum DeliveryDelay publication count, republished notice count or redrive and replay count. The docs read here do not establish a finite combined upper bound for those sources. Do not assume that a delivered message generates only one notification overall.

### Vercel: invocation and execution

[Fluid compute pricing](https://vercel.com/docs/functions/usage-and-pricing), page last updated June 16, 2026: Pro invocations USD 0.60/million, including failed requests; iad1 CPU USD 0.128/hour and provisioned memory USD 0.0106/GB-hour. Memory runs during IO; active CPU does not. Region prices differ (for example, gru1 CPU 0.221/hour and memory 0.0183/GB-hour). The live project plan, Region and billing configuration remain unverified.

[CDN pricing](https://vercel.com/docs/manage-cdn-usage) separately meters CDN requests, Fast Data Transfer and Fast Origin Transfer. The page's displayed examples are USD 0.15/GB and USD 0.06/GB; regional applicability still needs evidence. Request/response bodies, headers and URLs count, including incoming POST bytes. Excluded costs remain unknown or separately chargeable, never zero.

### Upstash: operations, replication and retained bytes

[Redis pricing](https://upstash.com/pricing/redis) gives pay-as-you-go USD 0.20/100,000 commands, USD 0.25/GB stored per month and USD 0.03/GB transfer above its allowance. This review credits no free storage or bandwidth. Writes replicated to read regions also count as commands; retained size includes replicas. The actual paid plan and read-region replication must be established. Fixed-plan billing cannot be silently treated as pay-as-you-go or vice versa.

The #2321 component proof measures eight Redis operations for a first report outcome and four for replay, counting EVAL and internal commands; the prepared read uses one HMGET/four fields. Its accepted-route sizing is eleven operations with guard and SNS receipt, 4,096 transfer bytes per attempt and retained records. Those report components are disconnected. A complete activation also counts existing health/suppression work, certificate retrieval, failed writes, released transport receipts, read budgets and retention tails. The accepted 300,000-byte application body bound does not bound bytes already billed for a larger rejected request. Rejected and duplicate callbacks still incur hosting work.

## Exact compute-only envelope: the 101-attempt scenario does not fit

The present SES route declares maxDuration 30 seconds. Conservatively charge each invocation the full 30 CPU-seconds, 2 GB for all 30 wall-seconds, and one invocation. This is the preparatory calculator's envelope, not a measured execution duration, an achievable adversarial CPU trace, or a new timeout. In exact USD arithmetic:

`per_attempt = 0.60 / 1,000,000 + 30 × 0.128 / 3,600 + 2 × 30 × 0.0106 / 3,600 = 18,659 / 15,000,000`.

The independent test uses integer rational arithmetic and rounds displayed costs UP to six decimal USD places. Existing list allowances and actual PLAN_PRICES are imported, never redefined or changed. One notice per sent email is only the stated scenario; repeated delays and split/duplicate publications are not funded by that assumption.

| Emails | Attempts per notice | Invocations | Compute-only envelope USD, rounded up |
| ---: | ---: | ---: | ---: |
| 7000 | 1 | 7000 | 8.707534 |
| 7000 | 4 | 28000 | 34.830134 |
| 7000 | 101 | 707000 | 879.460867 |
| 10000 | 1 | 10000 | 12.439334 |
| 10000 | 4 | 40000 | 49.757334 |
| 10000 | 101 | 1010000 | 1256.372667 |

At the existing Pro/Scale full list allowances, this 101-attempt compute envelope alone exceeds the respective current gross monthly prices (USD 449/999), and also each annual price divided by twelve. This rejects the present admission model; it does not establish an actual invoice or measured loss. SNS, networking, Redis, sending, all other plan entitlements, receiving costs, taxes and reserves are additional. No net-profit figure is claimed, and neither four attempts nor one attempt proves a positive complete worst-month margin.

## What must be proved before admission

1. Capture the **effective HTTP/S delivery policy** of the existing confirmed subscription, topic/destination count, raw-delivery setting, optional paid features, dead-letter configuration and redrive and replay permissions. A default or a public maximum is not live-account evidence. Do not change an account to fit the calculation.
2. Establish a finite total publication/duplicate/delay/attempt and byte lifecycle per admitted sent email, including failure and retry paths. Any unbounded or unverified part remains unknown. An application counter consulted after SNS publishes cannot prevent that upstream charge or the invocation already started.
3. Reserve the complete lifecycle's money and storage **before the first SES send**, using an existing reviewed funding boundary and preserving all send rights. The callback cannot grant itself funding after arrival. Include paid read budgets, post-cancellation exposure and the separate 30-day health/report retention design.
4. Demonstrate the full maximum-use monthly and annual units stay positive with the existing spend-floor room and the applicable TX/receiving/reserve models. If the present envelope fails, provide a causally verified tighter automatic work bound or another reviewed design; do not change prices, visible limits, flags or outcomes to manufacture a pass.
5. Obtain independent financial review and the nine final-head aggregators, then merge the complete admission unit. Only afterwards may Claude 1 perform the documented SES Delivery/DeliveryDelay step. This evidence PR neither fills reviewedAdmission nor completes CX-112.

Read-only account checks already listed in `docs/ses-delivery-events.md` include GetConfigurationSetEventDestinations, ListSubscriptionsByTopic and GetSubscriptionAttributes. No account, credential, bill, customer data, supplier contact or live callback was accessed for this evidence. Account-specific values and the enforceable prior funding ceiling remain the exact blockers; public tariff arithmetic is not their substitute.
