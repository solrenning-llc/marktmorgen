// Key families of the topic "nl:letters..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, T, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:letters:i:",
    "nl:letters:s:",
  ],
  elsewhere: [
    "nl:letters:link:",
    "nl:letters:ok:",
    "nl:letters:rl:addr:",
    "nl:letters:rl:ip:",
  ],
  closing: {
    // Emails published on the store (lib/letters.ts): the store's list goes, and each copy through it.
    "nl:letters:i:": T("nl:letters:s:", 400),
    "nl:letters:s:": E,
    // Who may read an email kept for members (lib/letter-access.ts): an answer kept for minutes, a link and the counts of links asked, an hour each.
    "nl:letters:link:": X(1),
    "nl:letters:ok:": X(1),
    "nl:letters:rl:addr:": X(1),
    "nl:letters:rl:ip:": X(1),
  },
  followed: [
    "nl:letters:s:",
  ],
};
