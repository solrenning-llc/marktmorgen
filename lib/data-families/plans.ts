// Key families of the topic "nl:plans..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, I, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:plans:lock",
    "nl:plans:pending",
  ],
  closing: {
    "nl:plans:lock": C,
    "nl:plans:pending": I,
  },
};
