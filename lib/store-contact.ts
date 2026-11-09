/**
 * The contact form on a store page (added 9 October 2026): a visitor writes
 * to the creator — a question before buying, a collaboration, a booking —
 * and the message lands in the creator's own inbox, with "Reply" going
 * straight back to the visitor.
 *
 * It only ever writes to the creator. Nothing is sent to the address a
 * visitor types, so the form cannot be used to email anybody else; that
 * address is only where the creator's reply will go. A few messages an hour
 * from one connection, and at most MAX_PER_DAY a day to one store, so a
 * creator is never flooded and the sends stay a small, fixed cost.
 *
 * Each message sent is also filed in the studio's inbox (lib/inbox.ts,
 * 13 October 2026), where it can be answered like a chat.
 */
import { createHash } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, type SendOutcome, isSenderConfigured, sendEmailOutcome } from "@/lib/email";
import { isRedisConfigured } from "@/lib/redis";
import { withinLimit } from "@/lib/request-guard";
import { isHouseStore } from "@/lib/house-store";
import type { Store } from "@/lib/store";
import { fileContact } from "@/lib/inbox";

import { MAX_MESSAGE, MAX_NAME, MIN_MESSAGE } from "@/lib/store-contact-rules";
/** Messages one store receives in a day, at most. */
export const MAX_PER_DAY = 20;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Whether the store page shows the form: switched on, email to send with, and never the demo store. */
export function contactOpen(store: Store): boolean {
  return store.contact.on && !store.suspended && !isHouseStore(store) && isSenderConfigured() && isRedisConfigured() && Boolean(store.email);
}

/**
 * "kept": the email to the creator may have gone, unconfirmed, and the message is in the studio's inbox; "unsure": it
 * may have gone, and it could not be filed. Neither is said as an error to send again, which could reach the creator
 * twice (audit of uncertain sends, 9 November 2026).
 */
export type ContactResult = "sent" | "kept" | "unsure" | "email" | "short" | "limited" | "closed" | "error";

/** A line with no line breaks or control characters, for a name or a subject. */
function line(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Sends a visitor's message to the creator. */
export async function sendContact(input: { store: Store; name: string; email: string; message: string; ip: string }): Promise<ContactResult> {
  const { store } = input;
  if (!contactOpen(store)) return "closed";
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  const message = input.message.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, "").trim().slice(0, MAX_MESSAGE);
  if (message.length < MIN_MESSAGE) return "short";
  const email = normaliseEmail(raw);
  const name = line(input.name, MAX_NAME);
  const who = store.statsId ?? store.handle;
  if (!(await withinLimit("contact-ip", `${who}:${input.ip}`, 3, 3_600))) return "limited";
  if (!(await withinLimit("contact-store", who, MAX_PER_DAY, 86_400))) return "limited";
  const from = name || email;
  const outcome = await sendEmailOutcome({ meter: { by: "store", store: store, kind: "email" },
    from: NIMBUS_FROM,
    to: store.email,
    replyTo: email,
    subject: `Message from ${line(from, 60)} via your store`,
    text: [
      `${from} wrote to you from your store page, marktmorgen.com/@${store.handle}:`,
      "",
      message,
      "",
      "—",
      `Press Reply to answer: it goes to ${email}.`,
      "Their address was typed by them and is not checked. Marktmorgen sent nothing to it.",
    ].join("\n"),
    idempotencyKey: `contact-${who}-${sha(`${email}|${message}`).slice(0, 24)}`,
  }).catch((): SendOutcome => "uncertain");
  // Refused for certain: nothing reached the creator, and the visitor may send it again.
  if (outcome === "refused") return "error";
  // Filed in the studio's inbox too (lib/inbox.ts), so it can be answered there with the rest. Also when the email may
  // have gone unconfirmed: the inbox is then where the creator is sure to find it.
  const filed = await fileContact({ store, email, name, text: message }).catch((error) => {
    console.error("filing a contact message failed", error);
    return false;
  });
  if (outcome === "sent") return "sent";
  return filed ? "kept" : "unsure";
}
