// Key families of the topic "nl:wo..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, I, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:wo:due",
    "nl:wo:n:",
    "nl:wo:r:",
    "nl:wo:start:",
  ],
  closing: {
    "nl:wo:due": I,
    "nl:wo:n:": E,
    "nl:wo:r:": E,
    "nl:wo:start:": E,
  },
};
