// Key families of the topic "nl:imports..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, E, I, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:imports:active",
    "nl:imports:busy:",
    "nl:imports:cf:",
    "nl:imports:cf:lock:",
    "nl:imports:list:",
    "nl:imports:lock",
    "nl:imports:moved:",
    "nl:imports:rows:",
  ],
  closing: {
    "nl:imports:active": I,
    "nl:imports:busy:": E,
    "nl:imports:cf:": E,
    "nl:imports:cf:lock:": E,
    "nl:imports:list:": E,
    "nl:imports:lock": C,
    "nl:imports:moved:": E,
    "nl:imports:rows:": E,
  },
};
