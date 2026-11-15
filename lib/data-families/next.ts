// Key families of the topic "nl:next..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:next:",
    "nl:next:lock:",
  ],
  closing: {
    "nl:next:": E,
    "nl:next:lock:": E,
  },
};
