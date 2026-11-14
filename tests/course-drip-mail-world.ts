// Synthetic world: the real lib/email, with sendEmail recording each message and answering "sent" (no provider is
// called, nothing is metered).
export * from "../lib/email";

export const mail: { sent: { to: string; subject: string }[] } = { sent: [] };

export async function sendEmail(message: { to: string | string[]; subject: string }): Promise<boolean> {
  mail.sent.push({ to: String(message.to), subject: message.subject });
  return true;
}
