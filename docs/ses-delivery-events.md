# SES delivery events for per-email reports

This is an owner-run account step, not an application deployment step. The code does not create, edit or subscribe an AWS resource. Do not enable the destination until the separate DR1 30-day retention and worst-month cost ceiling have been reviewed and merged; an unknown provider or Redis cost is not zero.

The application sends one `nl_mail` tag shared by every recipient of a broadcast or sequence step. It is the email's existing campaign identifier, never an address or recipient identifier. Signed events aggregate only four counts for that identifier: delivered, permanently bounced, temporarily bounced/delayed and complained. A temporary bounce or delivery delay never removes an address and never pauses a list.

## Owner step in Amazon SES

1. Open the **Amazon Simple Email Service (SES)** console in the same AWS Region as `AWS_SES_REGION`.
2. Choose **Configuration** → **Configuration sets** → **marktmorgen**. This is the name declared by the repository's stack (`Events`). Before editing, confirm that the production value of `AWS_SES_CONFIGURATION_SET` is exactly `marktmorgen`; the account's live value has not been read by this code change. If it differs, use that configured set and reconcile the discrepancy with the owner first.
3. Open **Event destinations**, select the existing destination **bounces-and-complaints**, and choose **Edit**. Do not add a second destination: two enabled destinations would duplicate every count.
4. Keep the destination enabled and select exactly **Deliveries**, **Hard bounces**, **Complaints**, and **Delivery delays** (`DELIVERY`, `BOUNCE`, `COMPLAINT`, and `DELIVERY_DELAY` in SES API v2). Do not select sends, rejects, rendering failures, subscriptions, opens or clicks; Marktmorgen uses no tracking pixel and does not need those events.
5. Keep **Amazon SNS** as the destination and keep the existing topic **marktmorgen-email**. Its full ARN must be exactly the production value of `AWS_SES_TOPIC_ARN` (`arn:aws:sns:<AWS_SES_REGION>:<the existing account id>:marktmorgen-email`). Do not create or change a topic, subscription, role, account, Region or configuration set as part of this code change.
6. Review the four selections and save the existing destination only after the 30-day cost unit above is complete.

The SNS topic must continue to post to the existing HTTPS endpoint **`https://marktmorgen.com/api/mail/ses`**. That endpoint accepts only the configured topic, Amazon's regional signing certificate and a recent valid signature; it deduplicates the SNS message before changing health or report counts.

## How to check the account setting

1. Reopen **SES** → **Configuration sets** → **marktmorgen** → **Event destinations**. There must be one enabled destination named **bounces-and-complaints**, with the four event types above and SNS topic **marktmorgen-email**.
2. Open **Amazon Simple Notification Service (SNS)** → **Topics** → **marktmorgen-email**. The topic ARN must equal `AWS_SES_TOPIC_ARN` character for character.
3. In that topic, open **Subscriptions**. There must be one **HTTPS** subscription whose endpoint is `https://marktmorgen.com/api/mail/ses` and whose status is **Confirmed**. `Pending confirmation`, another host, another path or a second subscription is not a working match.
4. Return to the SES destination and confirm it still says **Enabled**. These dashboard checks prove the wiring only; they do not prove delivery, cost coverage or a 30-day report. Do not send a test event before the separate cost ceiling is merged.

The repository stack calls this CloudFormation destination `EventsToTopic`; its present console name is **bounces-and-complaints**. A later stack update must preserve the four event types or it can restore the old bounce/complaint-only selection.

Official references, read 4 November 2026:

- [Setting up Amazon SES event publishing](https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-activity-using-notifications-event-publishing.html)
- [Creating an event destination](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination.html)
- [Amazon SES event contents](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html)

## Implementation checkpoint: bounded Redis components

The event writer uses one atomic Lua operation. A first outcome costs eight Redis commands including `EVAL`; an identical replay costs three inside that operation. A day read uses one `HMGET` for four counters. The receipt stores only a hash of the provider's message identity, but that hash is still a pseudonym and needs the stated retention/privacy treatment. It is not proof of anonymous data.

The daily hash has an internal field ceiling derived from the largest existing list-email allowance, two billing windows and eight fields per sent email, plus its three health counters. The script checks capacity before adding a receipt/counter. Hashes expire at the original provider day's deadline; a replay neither moves the outcome into another day nor renews its expiry. The current checkpoint retains ten days. The separate 30-day unit has not shipped.

Disposable local Redis 7.4.12 executed the exact static `RECORD_MAIL_REPORT` script: 64 concurrent identical receipts left one count, conflicting receipts and capacity overflow were refused before writes, duplicate expiry stayed fixed, and a corrupt counter was refused. `INFO commandstats` measured eight commands for a first outcome. `MEMORY USAGE` for 1,002 worst-length fields was 154,251 bytes, below the modeled 256 bytes per field plus 1,024 bytes per hash. This one allocator/version observation is a component check, not a supplier invoice or complete hosting approval.

`MAIL_REPORT_COST_COMPONENTS` in the shared cost registry records the known commands and the 2,048-byte storage allowance per sent email (eight fields). The storage family prices those bytes for ten days without free-tier credit. Callback attempts, SNS/hosting and the complete monthly cost remain explicitly `null`; no existing commercial review is expanded by these observations. In particular, a finite number of distinct outcomes does not bound all delivery attempts or rejected requests. The draft must remain unmerged until those new operational costs have a reviewed ceiling before spending.

For account evidence, the owner should record the existing SNS subscription's effective HTTP/S delivery policy and whether any dead-letter redrive/manual replay is configured. No account values were read or changed by this patch. [SNS HTTP/S retry policy constraints](https://docs.aws.amazon.com/sns/latest/dg/sns-message-delivery-retries.html), read November 4, 2026, allow custom HTTP/S retries; the live policy must not be inferred from an example or default. The current request's 30-second maximum is a timeout bound, not a reviewed monthly callback budget.
