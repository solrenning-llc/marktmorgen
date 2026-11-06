/**
 * What a creator is told when their plan's renewal payment did not go
 * through (232 [CA1] unit 4), in one place, so the studio, the email and the
 * Terms say the same thing and say what the code does:
 *
 *   - checkout, free copies and list sign-ups need a paid-up plan
 *     (lib/billing.ts isPaidUp: lib/store-checkout.ts, lib/free.ts,
 *     lib/store-join.ts, lib/paypal-sales.ts);
 *   - emails to the list need it (lib/plan.ts canUse "email", lib/mail.ts);
 *   - AI drafts, uploads and lesson video follow costStandingOf
 *     (lib/plan-standing.ts: lib/ai.ts, lib/ai-spend.ts, lib/upload-budget.ts,
 *     videoLimitFor, picturesLimitFor, taskRoomFor, and the upload routes'
 *     own refusal); a buyer's new review photo follows costsPaused
 *     (app/api/store/review/route.ts, unit 4b1); imports and funnel
 *     migrations follow costPauseCode and costsPaused
 *     (app/api/store/import, app/api/store/import/funnel, lib/imports.ts
 *     runImport, unit 4b2); new Zoom, Google Calendar and Meta connections
 *     and Meta's daily read follow costPauseCode (lib/integration-pause.ts,
 *     lib/meet-routes.ts, lib/meta-routes.ts, lib/meta-ads.ts, unit 4b3);
 *     webhook deliveries, new endpoints and test messages follow
 *     integrationPauseWord (lib/webhooks.ts, units 4b4b1 and 4b4b2);
 *     reads through an API key, MCP included, follow integrationPauseWord
 *     (lib/api-guard.ts, unit 4b4c).
 */
export const RENEWAL_PAUSED_WORDS =
  "Until it is paid, your checkout takes no new orders, free copies or sign-ups, and emails to your list, AI drafts, lesson video, imports from other platforms, new connections to Zoom, Google Calendar and Meta with Meta's daily ad-spend read, and new uploads, your buyers' review photos included, are paused. New webhook endpoints cannot be added, and webhooks are not sent to your endpoints, not even later, except events from your Stripe account, which are sent once the payment is recorded, as far back as Stripe keeps them (30 days). Reading your store through your API keys, AI assistants included, waits too, and so does adding to it through them; removing labels, taking back access and removing webhook endpoints do not.";

export const RENEWAL_KEPT_WORDS =
  "Your store's page stays up, your buyers keep reaching what they already bought except lesson video, your studio stays open, and nothing is deleted.";

export const RENEWAL_RESUME_WORDS = "Everything starts again as soon as Stripe records the payment.";
