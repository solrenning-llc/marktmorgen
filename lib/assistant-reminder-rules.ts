/**
 * The Store assistant's third function (added 17 October 2026): ONE reminder
 * email after a checkout left unpaid, only to a buyer who asked for it at
 * checkout, with one short line an AI writes from the products in that
 * checkout. Rules the browser can read too; what keeps the consent, reads
 * the checkout, asks the model and sends is lib/assistant-reminder.ts.
 *
 * Measured before it was built (17 October 2026, official pages): Kajabi,
 * ClickFunnels and HighLevel send abandoned-cart emails from workflows the
 * creator writes, and HighLevel's and Shopify's start from the address typed
 * at checkout. Here nothing is inferred from an address being typed: the
 * buyer checks a box that says exactly what they will get, the sentence they
 * checked is kept with the time and its version, and the email quotes it.
 *
 * The legal design is the conservative one, because the owner has not yet
 * confirmed with counsel which basis the EU's rules allow for this email
 * (consent, or a legitimate interest): it rests on consent alone.
 *
 *   - The box starts unchecked, says "Email me a reminder if I don't finish
 *     this order" in the store's language, and needs the buyer's address
 *     typed beside it. Not checked, or no valid address: no reminder, and
 *     the checkout opens all the same.
 *   - One reminder per checkout, at the most, about an hour after it closed
 *     unpaid (ASSIST_REMIND_AFTER_SECONDS). None when it was paid, when the
 *     address paid for those products since in another checkout, when the
 *     address pressed stop on the store's reminders, left the creator's list,
 *     bounced, or was deleted from the store (lib/suppression.ts), or when it
 *     heard about the same products this week.
 *   - CAN-SPAM: from the creator's name, with the postal address the creator
 *     gave for reminders (none given: the box is not shown, nothing is sent,
 *     and the studio says why), a stop link that works at once and a
 *     one-click unsubscribe header, and a subject that says what it is.
 *   - No urgency, scarcity, countdown, discount, code, figure or testimonial:
 *     the email says the product, its link and today's price, as the store
 *     shows them, and nothing else is offered.
 *   - The AI's part is one short neutral line about the products in that
 *     checkout, from their titles, descriptions and how each is delivered,
 *     labeled as written by AI; a line with a number, a link, an
 *     exclamation, a deal or pressure word, or that is too long is never
 *     sent (neutralLine). When the add-on's month of replies is spent, the
 *     model fails or the line does not hold, the fixed reminder goes out
 *     with no AI line at all.
 *
 * What it costs: the AI line is one reply of the add-on's month, reserved
 * from the same pool at the same worst cost as a chat message
 * (ASSISTANT_POOL) before the model is asked, settled at what it billed,
 * given back when nothing was billed; its request is inside a chat reply's
 * caps (withinReminderReply), so the add-on's month is unchanged. The email
 * is one of the store's own emails (store-email, lib/email.ts), checked for
 * room before the model is asked and taken before it is sent; the reads and
 * Stripe calls around it are ASSIST_REMIND_REQUEST_UNITS of the store's
 * public requests.
 */
import { ASSISTANT_OUTPUT_TOKENS, ASSISTANT_PRODUCTS, DEAL_WORDS, MAX_ASSISTANT_REPLY, heldToFacts, writesAFigure } from "@/lib/store-assistant-rules";
import { MAX_CART } from "@/lib/cart-rules";

/** What the creator sets in the studio: whether the box is offered at checkout. Off until they switch it on. */
export type AssistReminderSetting = { on: boolean };
export const NO_ASSIST_REMINDER: AssistReminderSetting = { on: false };

export function parseAssistReminder(raw: unknown): AssistReminderSetting {
  return { on: Boolean(raw && typeof raw === "object" && (raw as Record<string, unknown>).on === true) };
}

/**
 * The version of the box's sentence. Kept with each consent, so what a buyer
 * checked can be read back exactly (lib/buyer-words/assistant-reminder.ts);
 * a change of the sentence in any language is a new version.
 */
export const ASSIST_REMIND_VERSION = "assist-remind-1";

/** How long after the checkout closed unpaid the reminder goes. */
export const ASSIST_REMIND_AFTER_SECONDS = 60 * 60;
/** A reminder not sent this long after it was due is dropped: the moment has gone. */
export const ASSIST_REMIND_STALE_SECONDS = 6 * 60 * 60;
/**
 * How long the consent and the checkout it is for are kept, from when the
 * checkout opened: the address, the sentence checked, when and its version.
 * Then they are deleted by themselves, sent or not.
 */
export const ASSIST_REMIND_KEEP_SECONDS = 3 * 86_400;
/** Consents one store takes in a day. Each is at most one email, from the store's own figure. */
export const ASSIST_REMINDERS_PER_STORE_DAY = 50;
/** The longest answer the model may write: one line. */
export const ASSIST_REMIND_OUTPUT_TOKENS = 80;
/** The longest line that is sent. */
export const MAX_ASSIST_REMIND_LINE = 220;
/** The model is given this long; the fixed reminder goes past it. */
export const ASSIST_REMIND_TIMEOUT_MS = 8_000;
/** Products one reminder reads at the most: a cart's. */
export const ASSIST_REMIND_PRODUCTS = MAX_CART;
/** Database commands one reminder makes at the most, besides the model call's own: a review ceiling. */
export const ASSIST_REMIND_COMMANDS = 40;
/** Public requests of the store's window one reminder counts as: its reads and its two calls to the creator's Stripe account. */
export const ASSIST_REMIND_REQUEST_UNITS = 4;

/**
 * Where one checkout's consent is kept (lib/assistant-reminder.ts), named
 * here so the other reminder (lib/checkout-recovery.ts, remindAbandoned)
 * can leave that checkout to this one without importing the sender.
 */
export const assistRemindKey = (session: string) => `nl:assist:remind:${session}`;

/** Words of pressure the line may never use, in the store languages, beyond the deal words. */
const PRESSURE =
  /\b(now|today|tonight|soon|hurry|quick|quickly|fast|last|left|limited|ending|ends|expires?|deadline|before it'?s gone|don'?t miss|miss out|while (it|they) lasts?|popular|everyone|people love|ahora|hoy|pronto|[uú]ltim[oa]s?|maintenant|aujourd'hui|vite|dernier|jetzt|heute|schnell|letzte|adesso|oggi|subito|nu|vandaag|snel|laatste|agora|hoje|r[aá]pido)\b/i;

/**
 * The model's line as it may be sent, or "" when it may not: one line,
 * bounded, no figure in digits or words, link, exclamation or quotation of a deal, no pressure
 * word in any language the store speaks, and nothing the products' own words
 * do not hold (heldToFacts).
 */
export function neutralLine(raw: unknown, facts: string): string {
  if (typeof raw !== "string") return "";
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^["“'«]+|["”'»]+$/g, "").trim();
  if (!text || text.length > MAX_ASSIST_REMIND_LINE) return "";
  // No figure at all, in digits or in words of any store language ("ten thousand cooks", "five hours a week").
  if (/\d/.test(text) || writesAFigure(text) || /[!¡]/.test(text) || /https?:|www\.|@/.test(text)) return "";
  if (DEAL_WORDS.test(text) || PRESSURE.test(text)) return "";
  if (!heldToFacts(text, facts)) return "";
  return text.slice(0, MAX_ASSISTANT_REPLY);
}

/**
 * Whether one reminder's model request stays inside what one reply of the
 * assistant is priced at (assistantMessageWorstMicroUsd): no more products
 * read, no longer an answer, no more commands. Held in
 * tests/assistant-reminder.test.ts.
 */
export function withinReminderReply(commandsPerReply: number): boolean {
  return ASSIST_REMIND_PRODUCTS <= ASSISTANT_PRODUCTS && ASSIST_REMIND_OUTPUT_TOKENS <= ASSISTANT_OUTPUT_TOKENS && ASSIST_REMIND_COMMANDS <= commandsPerReply;
}
