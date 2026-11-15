// Key families of the topic "nl:teams..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:teams:state:",
  ],
  closing: {
    // Consent state is token-keyed, encrypted, and expires after 600 seconds; the registry conservatively prices one day.
    "nl:teams:state:": X(1),
  },
};
