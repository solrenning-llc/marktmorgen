// Only the external mail boundary is replaced; Redis and both contact/inbox modules are real.
export * from "../lib/email";
export const isSenderConfigured = () => true;
export const mail = { sent: 0, succeeds: true, during: undefined as undefined | (() => void) };
export async function sendEmail(): Promise<boolean> {
  mail.sent += 1;
  mail.during?.();
  return mail.succeeds;
}
