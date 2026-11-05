# SES delivery events for per-email reports

This is an owner-run account step, not an application deployment step. The code does not create, edit or subscribe an AWS resource. Enable Delivery and DeliveryDelay only after this unit's callback funding, independent reviews and nine CI aggregators are complete and the product PR is merged. Callback funding belongs to this unit; it cannot be deferred to the separate 30-day retention unit. An unknown provider or Redis cost is not zero.

The application sends one `nl_mail` tag shared by every recipient of a broadcast or sequence step. It is the email's existing campaign identifier, never an address or recipient identifier. Signed events aggregate only four counts for that identifier: delivered, permanently bounced, temporarily bounced/delayed and complained. Bounce types `Transient` and `Undetermined`, and delivery delays, never remove an address and never pause a list. Only `Permanent` bounces and complaints enter the existing health protection.

## Owner step in Amazon SES

1. Open the **Amazon Simple Email Service (SES)** console in the same AWS Region as `AWS_SES_REGION`.
2. Choose **Configuration** → **Configuration sets** → **marktmorgen**. This is the name declared by the repository's stack (`Events`). Before editing, confirm that the production value of `AWS_SES_CONFIGURATION_SET` is exactly `marktmorgen`; the account's live value has not been read by this code change. If it differs, use that configured set and reconcile the discrepancy with the owner first.
3. Open **Event destinations**, select the existing destination **bounces-and-complaints**, and choose **Edit**. Do not add a second destination: two enabled destinations would duplicate every count.
4. Keep the destination enabled and select exactly **Deliveries**, **Hard bounces**, **Complaints**, and **Delivery delays** (`DELIVERY`, `BOUNCE`, `COMPLAINT`, and `DELIVERY_DELAY` in SES API v2). Do not select sends, rejects, rendering failures, subscriptions, opens or clicks; Marktmorgen uses no tracking pixel and does not need those events.
5. Keep **Amazon SNS** as the destination and keep the existing topic **marktmorgen-email**. Its full ARN must be exactly the production value of `AWS_SES_TOPIC_ARN` (`arn:aws:sns:<AWS_SES_REGION>:<the existing account id>:marktmorgen-email`). Do not create or change a topic, subscription, role, account, Region or configuration set as part of this code change.
6. Review the four selections and save the existing destination only after this unit's callback funding and product merge above are complete.

The SNS topic must continue to post to the existing HTTPS endpoint **`https://marktmorgen.com/api/mail/ses`**. That endpoint accepts only the configured topic, Amazon's regional signing certificate and a recent valid signature; it deduplicates the SNS message before changing health or report counts.

## How to check the account setting

1. Reopen **SES** → **Configuration sets** → **marktmorgen** → **Event destinations**. There must be one enabled destination named **bounces-and-complaints**, with the four event types above and SNS topic **marktmorgen-email**.
2. Open **Amazon Simple Notification Service (SNS)** → **Topics** → **marktmorgen-email**. The topic ARN must equal `AWS_SES_TOPIC_ARN` character for character.
3. In that topic, open **Subscriptions**. There must be one **HTTPS** subscription whose endpoint is `https://marktmorgen.com/api/mail/ses` and whose status is **Confirmed**. `Pending confirmation`, another host, another path or a second subscription is not a working match.
4. Return to the SES destination and confirm it still says **Enabled**. These dashboard checks prove the wiring only; they do not prove delivery, cost coverage or a 30-day report. Do not send a test event before this unit's cost ceiling is merged.

Read-only API equivalents for the owner to retain as evidence (no create/update API is required):

```sh
aws sesv2 get-configuration-set-event-destinations \
  --configuration-set-name marktmorgen --region "$AWS_SES_REGION"
aws sns list-subscriptions-by-topic \
  --topic-arn "$AWS_SES_TOPIC_ARN" --region "$AWS_SES_REGION"
aws sns get-subscription-attributes \
  --subscription-arn "<the existing confirmed HTTPS subscription ARN>" \
  --region "$AWS_SES_REGION"
```

In SES API v2, `GetConfigurationSetEventDestinations` must return one matching `EventDestinations[]` entry with `Name=bounces-and-complaints`, `Enabled=true`, `MatchingEventTypes` equal to `DELIVERY`, `BOUNCE`, `COMPLAINT`, `DELIVERY_DELAY`, and `SnsDestination.TopicArn` equal to `AWS_SES_TOPIC_ARN`. The outer SNS envelope uses `Type=Notification`; its nested SES `eventType` values are `Delivery`, `Bounce`, `Complaint`, `DeliveryDelay` (different casing from the API selection). `ListSubscriptionsByTopic` must show the exact HTTPS endpoint above with a real confirmed ARN. `GetSubscriptionAttributes` supplies `EffectiveDeliveryPolicy`, `RedrivePolicy` if present, and `RawMessageDelivery`; raw delivery must remain false because this endpoint verifies the signed SNS envelope. Retain the effective policy rather than assuming a default. Do not alter retries, redrive or subscriptions to fit a calculation.

The repository stack calls this CloudFormation destination `EventsToTopic`; its present console name is **bounces-and-complaints**. A later stack update must preserve the four event types or it can restore the old bounce/complaint-only selection.

Official references, read 4 November 2026:

- [Setting up Amazon SES event publishing](https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-activity-using-notifications-event-publishing.html)
- [Creating an event destination](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination.html)
- [Amazon SES event contents](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html)

## Implementation checkpoint: bounded Redis components

The event writer uses one atomic Lua operation. A first outcome costs eight Redis commands including `EVAL`; an identical replay costs three inside that operation. A day read uses one `HMGET` for four counters. The receipt stores only a hash of the provider's message identity, but that hash is still a pseudonym and needs the stated retention/privacy treatment. It is not proof of anonymous data.

The daily hash has an internal field ceiling derived from the largest existing list-email allowance, two billing windows and eight fields per sent email, plus its three health counters. The script checks capacity before adding a receipt/counter. Hashes expire at the original event day's deadline; a replay neither moves the outcome into another day nor renews its expiry. SES uses `delivery.timestamp`, `bounce.timestamp`, `complaint.timestamp` or `deliveryDelay.timestamp`; `mail.timestamp` is the send time and is not used as an event time. Resend uses signed `created_at`. A five-second forward clock difference is accepted at that same event instant, without moving or extending it on replay. Missing/malformed times and times further ahead are not reportable. The current checkpoint retains ten days. The separate 30-day unit has not shipped.

Disposable local Redis 7.4.12 executed the exact static `RECORD_MAIL_REPORT` script: 64 concurrent identical receipts left one count, conflicting receipts and capacity overflow were refused before writes, duplicate expiry stayed fixed, and a corrupt counter was refused. `INFO commandstats` measured eight commands for a first outcome. `MEMORY USAGE` for 1,002 worst-length fields was 154,251 bytes, below the modeled 256 bytes per field plus 1,024 bytes per hash. This one allocator/version observation is a component check, not a supplier invoice or complete hosting approval.

`MAIL_REPORT_COST_COMPONENTS` in the shared cost registry records the known commands and the 2,048-byte storage allowance per sent email (eight fields). The storage family prices those bytes for ten days without free-tier credit. `mailReportCallbackCost` additionally prices a stated number of accepted delivery notices and attempts. It does not reserve money or authorize an operation. The live attempt/publication ceiling, complete worst month and funding admission remain explicitly `null`; no existing commercial review is expanded by a sizing example. A finite number of distinct counted outcomes does not bound provider publications, delivery attempts or rejected requests. The draft must remain unmerged until those new operational costs have a reviewed ceiling before spending.

## Callback calculation, including every delivered email

For `N` delivered emails with one accepted delivery notice each and `A` attempts per notice, count `N` SNS publishes, `N × A` HTTPS deliveries and function invocations. This is in addition to sending the email. Per accepted attempt, the existing guard costs two commands (`SET`, `INCR`), the SNS receipt one (`SET NX EX`), and the new atomic outcome eight including `EVAL`: **eleven Redis commands**. The calculator conservatively charges all eleven on every retry, even though an already-seen notice exits earlier. It also counts a 4,096-byte Redis transfer envelope and retained records; idempotence is never a free invocation.

Read on November 4, 2026: [SNS FAQ](https://aws.amazon.com/sns/faqs/) gives US$0.50 per million requests and US$0.60 per million HTTP notifications; [SNS pricing](https://aws.amazon.com/sns/pricing/) bills every 64 KiB chunk. Five chunks bound an accepted 300,000-byte application envelope. [Vercel compute](https://vercel.com/docs/functions/usage-and-pricing) confirms the registry's US$0.60/million invocations, US$0.128/CPU-hour and US$0.0106/GB-hour in `iad1`; the calculation charges all 30 seconds at 2 GB and all 30 CPU-seconds. [Vercel networking](https://vercel.com/docs/manage-cdn-usage) adds CDN requests, incoming and outgoing Fast Origin Transfer and Fast Data Transfer, without credits. Live Region, plan, taxes and coverage still require their own review.

An explicit **sizing assumption**, not a verified account tariff: SNS outgoing transfer US$0.20/GB, plus the registry's provider allowance. With those inputs:

| Scenario | SNS notices | Invocations | Redis commands | Modeled callback cost (USD) |
| --- | ---: | ---: | ---: | ---: |
| One delivered email, one accepted attempt | 1 | 1 | 11 | 0.0015482624 |
| 10,000 delivered emails, one accepted attempt each | 10,000 | 10,000 | 110,000 | 15.4826244 |
| Same 10,000 notices, 101 attempts each | 10,000 | 1,010,000 | 11,110,000 | 1,560.9481284 |

These are callback costs, not profit, current bills, or a certified worst month. They exclude separate send charges and other event types, which must also be funded. Unknown regional SNS transfer returns `null`. A first delivery model is not a total-attempt ceiling. The AWS HTTP/S policy allows up to 100 retries; whether the live subscription uses fewer, whether SES publishes repeated delays and whether redrive/manual replay exists must be established before selecting `A` and total notices. Four aggregate columns do not prove four total publications per email. An explicit Redis refusal (`-1`), corruption or unconfirmed write deliberately yields HTTP 500 and releases the transport receipt for retry; it must not be acknowledged as a successful recorded outcome just to lower the bill. The retry cost and failure disposition therefore belong in the funding review.

For account evidence, the owner should record the existing SNS subscription's effective HTTP/S delivery policy and whether any dead-letter redrive/manual replay is configured. No account values were read or changed by this patch. [SNS HTTP/S retry policy constraints](https://docs.aws.amazon.com/sns/latest/dg/sns-message-delivery-retries.html), read November 4, 2026, allow custom HTTP/S retries; the live policy must not be inferred from an example or default. The current request's 30-second maximum is a timeout bound, not a reviewed monthly callback budget.
