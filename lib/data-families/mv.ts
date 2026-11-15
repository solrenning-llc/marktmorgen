// Key families of the topic "nl:mv..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, I, T, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:mv:",
    "nl:mv:link:",
  ],
  elsewhere: [
    "nl:mv:due",
  ],
  closing: {
    "nl:mv:": E,
    "nl:mv:due": I,
    "nl:mv:link:": T("nl:mv:"),
  },
  followed: [
    "nl:mv:",
  ],
};
