// Key families of the topic "nl:watch..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, E, I, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:watch:last:",
  ],
  elsewhere: [
    "nl:watch:due",
    "nl:watch:folders:",
    "nl:watch:monthly:",
    "nl:watch:opened:",
    "nl:watch:sec:",
  ],
  closing: {
    "nl:watch:due": I,
    "nl:watch:folders:": I,
    "nl:watch:last:": E,
    "nl:watch:monthly:": C,
    "nl:watch:opened:": E,
    "nl:watch:sec:": E,
  },
};
