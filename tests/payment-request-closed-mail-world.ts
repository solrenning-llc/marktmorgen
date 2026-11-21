export * from "../lib/email";
export const mail = { attempts: 0, outcome: "sent" as "sent" | "refused" | "uncertain" };
export async function sendEmailOutcome() { mail.attempts++; return mail.outcome; }
export async function sendEmail() { mail.attempts++; return true; }
