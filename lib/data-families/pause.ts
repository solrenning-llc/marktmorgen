// Key families of the topic "nl:pause..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, I, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:pause:",
    "nl:pause:due",
    "nl:pause:last:",
  ],
  closing: {
    "nl:pause:": E,
    "nl:pause:due": I,
    "nl:pause:last:": E,
  },
};
