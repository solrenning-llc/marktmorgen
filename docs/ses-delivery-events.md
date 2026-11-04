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
