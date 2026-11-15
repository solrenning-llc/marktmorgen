// Key families of the topic "nl:cimg..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, E, T, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:cimg:",
    "nl:cimg:doors",
    "nl:cimg:n:",
  ],
  closing: {
    "nl:cimg:": T("files"),
    "nl:cimg:doors": C,
    "nl:cimg:n:": E,
  },
};
