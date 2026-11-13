/** A stand-in for lib/email.ts for tests/reminder-after-switch.test.ts: every email is kept here, none is sent. */
export const NIMBUS_FROM = "Marktmorgen <hello@marktmorgen.test>";
export const sent: { to: string; subject: string; text: string }[] = [];
export function isSenderConfigured(): boolean {
  return true;
}
export async function sendEmail(message: { to: string | string[]; subject: string; text: string }): Promise<boolean> {
  sent.push({ to: Array.isArray(message.to) ? message.to[0] : message.to, subject: message.subject, text: message.text });
  return true;
}
