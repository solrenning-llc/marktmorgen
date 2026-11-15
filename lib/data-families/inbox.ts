// Key families of the topic "nl:inbox..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, T, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:inbox:",
    "nl:inbox:tok:",
  ],
  closing: {
    "nl:inbox:": E,
    "nl:inbox:tok:": T("nl:inbox:"),
  },
  followed: [
    "nl:inbox:",
  ],
};
