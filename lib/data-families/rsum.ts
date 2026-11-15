// Key families of the topic "nl:rsum..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:rsum:",
    "nl:rsum:last:",
    "nl:rsum:lock:",
    "nl:rsum:ver:",
  ],
  closing: {
    // A product's AI summary of its reviews (lib/review-ai-summary.ts): kept eight days, and goes with the store.
    "nl:rsum:": E,
    "nl:rsum:last:": E,
    "nl:rsum:lock:": E,
    "nl:rsum:ver:": E,
  },
};
