// Key families of the topic "nl:share..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, I, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:share:applied",
    "nl:share:lock",
    "nl:share:read-until",
    "nl:share:stores",
  ],
  closing: {
    "nl:share:applied": I,
    "nl:share:lock": C,
    "nl:share:read-until": I,
    "nl:share:stores": I,
  },
};
