// Key families of the topic "nl:courses..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, I, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:courses:drip",
    "nl:courses:lock",
  ],
  closing: {
    "nl:courses:drip": I,
    "nl:courses:lock": C,
  },
};
