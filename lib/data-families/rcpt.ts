// Key families of the topic "nl:rcpt..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:rcpt:n:",
    "nl:rcpt:seq:",
  ],
  closing: {
    // A store's receipt numbers (601 [KB22] U2, lib/receipt-number.ts): by its id, gone with it.
    "nl:rcpt:n:": E,
    "nl:rcpt:seq:": E,
  },
};
