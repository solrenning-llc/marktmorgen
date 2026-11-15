// Key families of the topic "nl:affhub..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { Cr, L, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:affhub:",
    "nl:affhub:link:",
  ],
  closing: {
    "nl:affhub:": L,
    "nl:affhub:link:": Cr(1),
  },
};
