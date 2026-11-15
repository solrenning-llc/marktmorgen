// Key families of the topic "nl:amem..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:amem:",
  ],
  elsewhere: [
    "nl:amem:lock:",
  ],
  closing: {
    // The creator's own notes for their assistant (lib/assistant-memory-store.ts): go with the store.
    "nl:amem:": E,
    "nl:amem:lock:": X(1),
  },
};
