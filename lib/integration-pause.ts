/**
 * New connections to Zoom, Google Calendar and Meta while what costs us to
 * run is paused (232 [CA1] unit 4b3): the plan's renewal is unpaid, or a
 * payment for it is disputed (lib/plan-standing.ts costPauseCode).
 *
 * A new connection is new work on our side: tokens to keep, meetings to make
 * for every booking, and for Meta a daily read of the ad account. So while the
 * plan's costs are paused, starting a connection and finishing one (the
 * provider's return) are refused before any provider call, and Meta's daily
 * read and the account picker's read wait. Accounts already connected stay
 * connected, and disconnecting stays open: the creator can always take a
 * permission back.
 */
import { costPauseCode, type PlanFields } from "@/lib/plan-standing";

/** The word a connection route sends back to the studio, or null when the store's costs run. */
export function integrationPauseWord(store: Pick<PlanFields, "subscriptionActive" | "renewalUnpaidSince" | "planDisputes">, nowSeconds = Date.now() / 1000): "paused_unpaid" | "paused_disputed" | null {
  const code = costPauseCode(store, nowSeconds);
  return code === "renewal_unpaid" ? "paused_unpaid" : code === "plan_disputed" ? "paused_disputed" : null;
}

const KEPT = "Accounts already connected stay connected, and you can still disconnect any of them.";

/** What the studio says for each word, the same on the video calls, calendar and numbers pages. */
export const INTEGRATION_PAUSED_WORDS: Record<"paused_unpaid" | "paused_disputed", string> = {
  paused_unpaid: `Nothing was connected: your plan's renewal payment did not go through, so new connections wait until it is paid. Check the notice at the top of your studio to pay it. ${KEPT}`,
  paused_disputed: `Nothing was connected: a payment for your plan is disputed with your bank, so new connections wait until the dispute is settled. Check the notice at the top of your studio for what happens next. ${KEPT}`,
};

/** Meta's own notice adds that its daily read waits too. */
export const META_READ_PAUSED = "Reading your Meta ad spend also waits, and starts again on its own once the payment is recorded or the dispute is won.";

/**
 * 232 [CA1] unit 4b4a: tools on accounts already connected that reach the
 * provider for the creator (a test meeting made or moved, a host's calendar
 * read again, its calendars listed or chosen, an iCal address read, Google or
 * iCal picked as the source of busy times) wait too. Taking something away
 * stays open: disconnecting, removing a calendar address, choosing no source,
 * and deleting a test meeting.
 */
const CALENDAR_KEPT = "You can still remove your calendar address, choose no calendar, or disconnect Google Calendar.";
const MEETING_KEPT = "You can still delete a test meeting or disconnect the account.";
/** "what" is refused, not queued: the sentence asks the creator to try again once paid. */
const pausedWords = (what: string, kept: string): Record<"paused_unpaid" | "paused_disputed", string> => ({
  paused_unpaid: `Nothing was changed: your plan's renewal payment did not go through, so ${what} until it is paid; try again then. Check the notice at the top of your studio to pay it. ${kept}`,
  paused_disputed: `Nothing was changed: a payment for your plan is disputed with your bank, so ${what} until the dispute is settled; try again then. Check the notice at the top of your studio for what happens next. ${kept}`,
});

/** The host calendar page's refusals (app/api/store/host-calendar). */
export const TOOLS_PAUSED_WORDS = pausedWords("calendar checks and changes cannot be made", CALENDAR_KEPT);

/** The video calls page's refusals for a test meeting (app/api/integrations/meetings). */
export const MEETING_TEST_PAUSED_WORDS = pausedWords("test meetings cannot be made or moved", MEETING_KEPT);

/** Shown where the host's Google calendar list would be, while it is not read. */
export const CALENDAR_LIST_PAUSED = "Your Google calendar list is not read while your plan's payment is unpaid or disputed. It is read again on its own once the payment is recorded or the dispute is settled.";

/**
 * 232 [CA1] unit 4b4b1: a webhook test message waits too. Endpoints already
 * added stay, can be changed and can be removed.
 */
export const WEBHOOK_TEST_PAUSED_WORDS = pausedWords("webhook test messages cannot be sent", "You can still change or remove any endpoint.");

/**
 * 232 [CA1] unit 4b4b2: a new endpoint is new delivery work, so adding one
 * waits too, through the studio and the API alike.
 */
export const WEBHOOK_ADD_PAUSED_WORDS = pausedWords("new webhook endpoints cannot be added", "You can still change or remove any endpoint.");

/**
 * 232 [CA1] unit 4b4b2: a delivery that comes due while the plan's costs are
 * paused is not sent and not tried again; the studio's log shows why. It
 * still counts as one of the month's webhook deliveries (lib/webhooks.ts).
 * Events read from the creator's Stripe account are not read while paused,
 * so they are sent once the plan is paid (watchStripe).
 */
export const WEBHOOK_PAUSED_NOT_SENT_WORDS: Record<"paused_unpaid" | "paused_disputed", string> = {
  paused_unpaid: "Not sent: your plan's renewal payment did not go through, so webhooks are not sent until it is paid, and this one is not sent later. After the payment is recorded, events are sent as usual while the month's webhook deliveries last, and events from your Stripe account in the meantime are sent then, as far back as Stripe keeps them (30 days).",
  paused_disputed: "Not sent: a payment for your plan is disputed with your bank, so webhooks are not sent until the dispute is settled, and this one is not sent later. After the dispute is settled, events are sent as usual while the month's webhook deliveries last, and events from your Stripe account in the meantime are sent then, as far back as Stripe keeps them (30 days).",
};

/** Added when the refused delivery was counted against the month. */
export const WEBHOOK_PAUSED_COUNTED = "It counts as one of this month's webhook deliveries.";

/**
 * 232 [CA1] unit 4b4c: reading a store through one of its API keys (the REST
 * API's reads and every MCP tool) waits too. Each read is our work and may
 * read the creator's Stripe account, and the month it would be counted in is
 * the one the unpaid or disputed payment was for. Writes through a key that
 * take something away (taking access back, removing a webhook endpoint,
 * removing labels only) are not paused; they still count as the month's API
 * requests. Writes that add or change wait too (API_WRITE_PAUSED_WORDS).
 */
export const API_READ_PAUSED_WORDS: Record<"paused_unpaid" | "paused_disputed", string> = {
  paused_unpaid: "Nothing was read: your plan's renewal payment did not go through, so reading your store through your API keys, AI assistants included, waits until it is paid; try again then. Check the notice at the top of your studio to pay it. Removing labels, taking back access and removing webhook endpoints through the API are not paused.",
  paused_disputed: "Nothing was read: a payment for your plan is disputed with your bank, so reading your store through your API keys, AI assistants included, waits until the dispute is decided for us or, if it is decided for you, at most until the period that payment covered ends. Check the notice at the top of your studio for what happens next. Removing labels, taking back access and removing webhook endpoints through the API are not paused.",
};

/**
 * 232 [CA1] unit 4c: adding to a store through a write key (a lead, a lead's
 * labels, a product given with no payment, a webhook endpoint) waits too,
 * before the month's API requests are counted (a labels request's body is
 * read first, to see whether it adds). Each is our work and may start more
 * of it (a sequence a label starts, an email to a buyer, deliveries), and
 * the checkout already takes no new orders or free copies. Taking something
 * away stays open (lib/api-guard.ts, apiAdder).
 */
export const API_WRITE_PAUSED_WORDS: Record<"paused_unpaid" | "paused_disputed", string> = {
  paused_unpaid: "Nothing was changed: your plan's renewal payment did not go through, so adding leads, adding labels, giving products and adding webhook endpoints through your API keys waits until it is paid; try again then. Check the notice at the top of your studio to pay it. Removing labels, taking back access and removing webhook endpoints through the API are not paused.",
  paused_disputed: "Nothing was changed: a payment for your plan is disputed with your bank, so adding leads, adding labels, giving products and adding webhook endpoints through your API keys waits until the dispute is decided for us or, if it is decided for you, at most until the period that payment covered ends. Check the notice at the top of your studio for what happens next. Removing labels, taking back access and removing webhook endpoints through the API are not paused.",
};
