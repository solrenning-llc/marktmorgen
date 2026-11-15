// Key families of the topic "nl:copy..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { X, er, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:copy:",
  ],
  elsewhere: [
    "nl:copy:lock:",
  ],
  closing: {
    // A store copy's progress, named by the receiving store (lib/store-copy.ts), seven days; its one-step lock, a minute.
    "nl:copy:": er(7),
    "nl:copy:lock:": X(1),
  },
};
