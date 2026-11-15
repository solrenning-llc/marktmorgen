// Key families of the topic "nl:resend-budget..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:resend-budget:{",
  ],
  closing: {
    // Global financial holds must not be erased to manufacture free quota.
    // They have no approved active funding; the production review is absent.
    "nl:resend-budget:{": C,
  },
};
