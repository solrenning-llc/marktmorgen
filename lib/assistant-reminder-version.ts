/**
 * The version of the checkout reminder box's sentence. Kept with each
 * consent, so what a buyer checked can be read back exactly
 * (lib/buyer-words/assistant-reminder.ts); a change of the sentence in any
 * language is a new version.
 *
 * In its own file so the box on a store's checkout
 * (components/assistant-reminder-box.tsx) reads this one string without
 * reaching lib/assistant-reminder-rules.ts, whose imports bring the store
 * assistant's rules and cost tables into every buyer's browser.
 * lib/assistant-reminder-rules.ts re-exports it, so nothing else changes.
 */
export const ASSIST_REMIND_VERSION = "assist-remind-1";
