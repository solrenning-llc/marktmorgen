// Key families of the topic "nl:dc..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, E, I, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:dc:addr:",
    "nl:dc:mem:",
    "nl:dc:prod:",
  ],
  elsewhere: [
    "nl:dc:due",
    "nl:dc:lock",
    "nl:dc:ok:",
    "nl:dc:srv:",
    "nl:dc:state:",
  ],
  closing: {
    "nl:dc:addr:": E,
    "nl:dc:due": I,
    "nl:dc:lock": C,
    "nl:dc:mem:": E,
    "nl:dc:ok:": E,
    "nl:dc:prod:": E,
    "nl:dc:srv:": E,
    "nl:dc:state:": X(1),
  },
};
