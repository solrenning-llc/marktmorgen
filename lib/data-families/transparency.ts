// Key families of the topic "nl:transparency..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:transparency:",
    "nl:transparency:acted:",
    "nl:transparency:since",
  ],
  closing: {
    "nl:transparency:": C,
    "nl:transparency:acted:": C,
    "nl:transparency:since": C,
  },
};
