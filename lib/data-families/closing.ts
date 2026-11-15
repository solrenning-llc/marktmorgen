// Key families of the topic "nl:closing..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, Cr, E, I, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:closing:credit:",
    "nl:closing:final",
    "nl:closing:held",
    "nl:closing:lock",
    "nl:closing:paid:",
    "nl:closing:refund:",
    "nl:closing:shut:",
    "nl:closing:told:",
    "nl:closing:undo",
    "nl:closing:work:",
  ],
  closing: {
    // Queue item 307 [EC1]: a store's closing emails, the addresses told and its members' last payments, named by its folder; the stores whose members are held.
    "nl:closing:credit:": E,
    "nl:closing:final": I,
    "nl:closing:held": I,
    "nl:closing:paid:": E,
    "nl:closing:refund:": C,
    "nl:closing:told:": E,
    "nl:closing:work:": E,
    "nl:closing:lock": C,
    // A plan paid for a store already closing, until it is ended and returned (company); a closed store's address, hashed, until it expires.
    "nl:closing:shut:": Cr(30),
    "nl:closing:undo": C,
  },
};
