// Key families of the topic "nl:pre..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, I, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:pre:",
    "nl:pre:give:",
    "nl:pre:jobs",
    "nl:pre:pi:",
  ],
  closing: {
    "nl:pre:": E,
    "nl:pre:give:": X(1),
    "nl:pre:jobs": I,
    "nl:pre:pi:": X(430),
  },
};
