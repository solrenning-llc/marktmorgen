// Key families of the topic "nl:lnote..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:lnote:",
  ],
  closing: {
    // A student's private lesson notes (290 [SQ1], lib/lesson-notes.ts), named by the store's statsId.
    "nl:lnote:": E,
  },
};
