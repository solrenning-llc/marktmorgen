// Key families of the topic "nl:ppsell..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, T, X, er, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:ppsell:handover:",
    "nl:ppsell:mail:",
    "nl:ppsell:o:",
    "nl:ppsell:own:",
    "nl:ppsell:paid:",
    "nl:ppsell:pending:",
    "nl:ppsell:receipt:",
    "nl:ppsell:refunded:",
    "nl:ppsell:reversed:",
    "nl:ppsell:sales:",
    "nl:ppsell:watch:",
  ],
  closing: {
    "nl:ppsell:handover:": E,
    // The receipt as first made (lib/paypal-delivery.ts), so every try sends the same bytes: the store's words and the
    // buyer's address, named by the order, gone within RECEIPT_MAIL_SECONDS, and with the person (lib/erasure-index.ts).
    "nl:ppsell:mail:": er(1),
    "nl:ppsell:o:": T("nl:ppsell:sales:", 30),
    "nl:ppsell:own:": E,
    "nl:ppsell:paid:": T("nl:ppsell:sales:"),
    "nl:ppsell:pending:": E,
    // A PayPal receipt tried again (lib/paypal-delivery.ts, lib/email.ts sendEmailPinned): the time of its first try,
    // named by the order and holding only that time, gone within RECEIPT_MARK_SECONDS; the sender kept for its key, the company's, a day.
    "nl:ppsell:receipt:": X(7),
    "nl:ppsell:refunded:": E,
    "nl:ppsell:reversed:": E,
    "nl:ppsell:sales:": E,
    "nl:ppsell:watch:": E,
  },
  followed: [
    "nl:ppsell:sales:",
  ],
};
