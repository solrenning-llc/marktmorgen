/**
 * How long a buyer's question to the store assistant may be. In their own
 * file so the chat (components/store-assistant.tsx) reads these two numbers
 * without reaching lib/store-assistant-rules.ts, whose cost and margin imports
 * would otherwise travel to every buyer's browser.
 * lib/store-assistant-rules.ts re-exports them, so nothing else changes.
 */
export const MIN_ASSISTANT_QUESTION = 2;
export const MAX_ASSISTANT_QUESTION = 400;
