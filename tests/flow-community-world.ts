/**
 * The community send world (tests/community-mail-read-world.ts) with the email service answering as lib/email.ts
 * answers when Amazon SES has no bulk room left for the batch and the Resend fallback is at its paid quota (or its
 * proof is missing): sendBatch, which maps every non-send to "retry", says "retry"; sendListBatch, which keeps a known
 * no-send apart, says "waiting". Nothing is handed to any provider either way. Synthetic only.
 */
export * from "./community-mail-read-world";

export const batchCalls: string[] = [];
export const sendBatch = async (_messages: unknown[], key: string) => { batchCalls.push(key); return "retry" as const; };
export const sendListBatch = async (_messages: unknown[], key: string) => { batchCalls.push(key); return "waiting" as const; };
