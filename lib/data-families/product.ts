// Key families of the topic "nl:product..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:product:about:",
    "nl:product:landing:",
    "nl:product:note:",
    "nl:product:page:",
    "nl:product:pages:",
    "nl:product:pics:",
  ],
  closing: {
    "nl:product:about:": E,
    "nl:product:landing:": E,
    "nl:product:note:": E,
    "nl:product:page:": E,
    "nl:product:pages:": E,
    "nl:product:pics:": E,
  },
};
