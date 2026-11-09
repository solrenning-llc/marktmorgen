/**
 * The one way Marktmorgen sends a research message (owner's decision 13):
 * it asks the research do-not-contact list first (doNotContactState,
 * lib/research-do-not-contact.ts) and sends only to a contact the list says,
 * in its exact shape, is clear of it; listed, unknown or not a contact it
 * reads sends nothing. Counted against the company's own email (meter
 * "company"). tests/research-do-not-contact-sending.test.ts holds, from the
 * code's imports and calls, that no other file both sends email and reads
 * the list, that only the list's own page, form and routes import it, and
 * that only this function asks it to decide a sending. Nothing calls it today: no research message is
 * sent by the site.
 */
import { sendEmail } from "@/lib/email";
import { doNotContactState } from "@/lib/research-do-not-contact";

type Message = Parameters<typeof sendEmail>[0];
export type ResearchMessage = Omit<Message, "meter">;
export type ResearchSend = "sent" | "not-sent" | "on-the-list";

export async function sendResearchMessage(
  message: ResearchMessage,
  send: (message: Message) => Promise<boolean> = (one) => sendEmail(one),
): Promise<ResearchSend> {
  const state = await doNotContactState(message.to);
  if (state === "listed") return "on-the-list";
  if (state !== "clear") return "not-sent";
  return (await send({ ...message, meter: { by: "company" } })) ? "sent" : "not-sent";
}
