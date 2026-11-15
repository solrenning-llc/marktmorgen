// Key families of the topic "nl:stamp..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, T, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:stamp:copy:",
  ],
  elsewhere: [
    "nl:stamp:drop",
    "nl:stamp:problem:",
  ],
  closing: {
    "nl:stamp:copy:": T("prepare", 400),
    "nl:stamp:drop": C,
    "nl:stamp:problem:": X(31),
  },
};
