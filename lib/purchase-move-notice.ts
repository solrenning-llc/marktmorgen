/**
 * The creator is told, once, that a buyer moved their purchases to another
 * email (611 [WP10], unit 4a): so they know which address reaches that
 * buyer now, and that the orders on their Stripe account stay under the
 * old one, with refunds tied to the original order.
 *
 *   nl:pm:told:<id>   string  the notice of that move was sent (a mark, taken once; released when it did not go)
 *
 * The mark is taken before the email; an email that did not go (the store's
 * figure spent or unreadable, the sender down) gives it back, so the next
 * try of the move tells them. It is one of the store's own emails, taken
 * from its figure before it goes (lib/email.ts, EmailMeter "store",
 * "email"), like the other notices to a creator about their store.
 * Nothing is said to have gone that did not (rule 24).
 */
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import type { MoveRequest } from "@/lib/purchase-move-rules";
import type { Store } from "@/lib/store";

/** How long the mark is kept: past the move's own claim (lib/purchase-moves.ts, MOVE_MARK_SECONDS), so it is told once. */
export const MOVE_TOLD_SECONDS = 3 * 86_400;

const toldKey = (id: string) => `nl:pm:told:${id}`;

export type Told = "sent" | "already" | "unsent";

/** The notice's words: US English, as the studio speaks. */
export function moveNoticeText(store: string, from: string, to: string): { subject: string; text: string } {
  return {
    subject: "A buyer moved their purchases to another email",
    text: [
      `A buyer of ${store} moved their purchases from ${from} to ${to}, after confirming both addresses by email.`,
      "",
      `To reach this buyer, use ${to}.`,
      "",
      `Their past orders stay on your Stripe account under ${from}. Refunds stay with the original order.`,
      "",
      "You don't need to do anything.",
    ].join("\n"),
  };
}

/** Tells the creator of one move, once. */
export async function tellCreatorOfMove(store: Store, id: string, request: Pick<MoveRequest, "from" | "to">, now = Date.now()): Promise<Told> {
  const value = claimValue(now);
  const claimed = await claimMark(toldKey(id), MOVE_TOLD_SECONDS, value);
  if (claimed === "taken") return "already";
  // Unknown whether it is ours: nothing is sent, so the creator is never told twice; the next try asks again.
  if (claimed === "unknown") return "unsent";
  const words = moveNoticeText(store.name, request.from, request.to);
  let sent = false;
  try {
    sent = await sendEmail({ meter: { by: "store", store, kind: "email" }, from: NIMBUS_FROM, to: store.email, subject: words.subject, text: words.text });
  } catch (error) {
    console.error("a purchase move notice could not be sent", error);
  }
  if (sent) return "sent";
  await releaseMark(toldKey(id), value).catch(() => undefined);
  return "unsent";
}
