/**
 * lib/email.ts for tests/licence-notice-refused.test.ts: everything of the
 * real module, but its two senders scripted. Each send answers the next
 * outcome queued (`answers`), "sent" when none is, and is written down in
 * `sends` with its meter. No email leaves.
 */
export * from "../lib/email";
import type { SendOutcome } from "../lib/email";

type Sent = { to: string; subject: string; text: string; idempotencyKey?: string; meter: { by: string; store?: { handle?: string }; kind?: string } };
export const sends: Sent[] = [];
export const answers: (SendOutcome | "throw")[] = [];
export async function sendEmailOutcome(message: Sent): Promise<SendOutcome> {
  sends.push({ ...message });
  const next = answers.shift() ?? "sent";
  if (next === "throw") throw new Error("synthetic: the sender threw");
  return next;
}
export async function sendEmail(message: Sent): Promise<boolean> {
  return (await sendEmailOutcome(message)) === "sent";
}
