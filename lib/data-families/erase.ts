// Key families of the topic "nl:erase..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { Cr, E, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:erase:ix:",
    "nl:erase:link:",
  ],
  closing: {
    "nl:erase:ix:": E,
    "nl:erase:link:": Cr(1),
  },
  followed: [
    "nl:erase:ix:",
  ],
};
