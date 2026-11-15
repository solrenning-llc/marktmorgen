// Key families of the topic "nl:lib..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { L, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:lib:",
  ],
  elsewhere: [
    "nl:lib:joined:",
    "nl:lib:link:",
  ],
  closing: {
    "nl:lib:": L,
    "nl:lib:joined:": L,
    "nl:lib:link:": X(1),
  },
};
