// Key families of the topic "nl:gsc..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, E, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:gsc:conn",
    "nl:gsc:q:",
    "nl:gsc:state:",
  ],
  closing: {
    "nl:gsc:conn": C,
    "nl:gsc:q:": E,
    "nl:gsc:state:": C,
  },
};
