// Key families of the topic "nl:agent..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:agent:book:",
  ],
  elsewhere: [
    "nl:agent:book:lock:",
  ],
  closing: {
    "nl:agent:book:": E,
    "nl:agent:book:lock:": X(1),
  },
};
