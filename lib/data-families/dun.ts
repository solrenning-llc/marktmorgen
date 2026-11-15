// Key families of the topic "nl:dun..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, E, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:dun:",
    "nl:dun:card:",
    "nl:dun:cards:",
    "nl:dun:count:",
    "nl:dun:cursor",
    "nl:dun:report:",
  ],
  closing: {
    "nl:dun:": E,
    "nl:dun:card:": E,
    "nl:dun:cards:": E,
    "nl:dun:count:": E,
    "nl:dun:cursor": C,
    "nl:dun:report:": E,
  },
};
