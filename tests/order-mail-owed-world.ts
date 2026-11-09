/**
 * lib/email.ts for tests/order-mail-owed.test.ts: a scripted sender. Each
 * send answers the next outcome queued (`answers`), "sent" when none is, and
 * is written down in `sends`. No email leaves; nothing else of lib/email.ts
 * is run.
 */
export type SendOutcome = "sent" | "refused" | "uncertain";
export const NIMBUS_FROM = "Marktmorgen <hello@example.test>";
export const sends: { to: string; subject: string; text: string; idempotencyKey?: string; meter: unknown; attachments?: unknown }[] = [];
export const answers: (SendOutcome | "throw")[] = [];
export async function sendEmailOutcome(message: { meter: unknown; to: string; subject: string; text: string; idempotencyKey?: string; attachments?: unknown }): Promise<SendOutcome> {
  sends.push({ ...message });
  const next = answers.shift() ?? "sent";
  if (next === "throw") throw new Error("synthetic: the sender threw");
  return next;
}
