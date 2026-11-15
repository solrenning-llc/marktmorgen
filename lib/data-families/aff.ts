// Key families of the topic "nl:aff..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, E, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:aff:",
  ],
  elsewhere: [
    "nl:aff:leads:lock:",
    "nl:aff:link:",
    "nl:aff:payday:",
    "nl:aff:payday:lock",
    "nl:aff:seen:",
    "nl:aff:session:",
  ],
  closing: {
    "nl:aff:": E,
    "nl:aff:leads:lock:": X(1),
    "nl:aff:link:": X(1),
    "nl:aff:payday:": E,
    "nl:aff:payday:lock": C,
    "nl:aff:seen:": X(2),
    "nl:aff:session:": X(30),
  },
};
