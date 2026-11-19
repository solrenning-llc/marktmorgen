// The numbers-email world (tests/numbers-email-claim-world.ts) with the email's text kept, for
// tests/weekly-spend-unread.test.ts: what the weekly email says when the ad spend could not be read.
export * from "./numbers-email-claim-world";
import { control } from "./numbers-email-claim-world";

export const texts: string[] = [];
export async function sendEmail(message: { to: string; subject: string; text?: string }): Promise<boolean> {
  control.sent.push({ to: message.to, subject: message.subject });
  texts.push(String(message.text ?? ""));
  return true;
}
export const sendEmailPinned = (message: Parameters<typeof sendEmail>[0]) => sendEmail(message);
