// Key families of the topic "nl:api..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, T, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:api:hold:",
    "nl:api:k:",
    "nl:api:keys:",
    "nl:api:used:",
  ],
  closing: {
    "nl:api:hold:": E,
    "nl:api:k:": T("prepare"),
    "nl:api:keys:": E,
    "nl:api:used:": E,
  },
};
