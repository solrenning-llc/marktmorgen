// Key families of the topic "nl:nudge..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, E, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:nudge:",
    "nl:nudge:count:",
    "nl:nudge:cursor",
  ],
  closing: {
    "nl:nudge:": E,
    "nl:nudge:count:": E,
    "nl:nudge:cursor": C,
  },
};
