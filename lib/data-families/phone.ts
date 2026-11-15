// Key families of the topic "nl:phone..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:phone:cfg:",
    "nl:phone:seen:",
    "nl:phone:st:",
  ],
  closing: {
    "nl:phone:cfg:": E,
    "nl:phone:seen:": X(40),
    "nl:phone:st:": E,
  },
};
