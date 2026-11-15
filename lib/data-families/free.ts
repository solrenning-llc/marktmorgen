// Key families of the topic "nl:free..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, Cr, T, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:free:claim:",
    "nl:free:in:",
    "nl:free:n:",
    "nl:free:uses:",
  ],
  closing: {
    "nl:free:claim:": T("nl:erase:ix:", 7),
    "nl:free:in:": Cr(62),
    "nl:free:n:": C,
    "nl:free:uses:": X(7),
  },
};
