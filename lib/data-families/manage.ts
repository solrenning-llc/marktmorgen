// Key families of the topic "nl:manage..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:manage:link:",
    "nl:manage:opens:",
    "nl:manage:portal:",
  ],
  closing: {
    "nl:manage:link:": X(1),
    "nl:manage:opens:": X(1),
    "nl:manage:portal:": E,
  },
};
