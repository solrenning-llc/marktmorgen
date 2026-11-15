// Key families of the topic "nl:recount..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:recount:",
    "nl:recount:ids",
    "nl:recount:lock",
    "nl:recount:state",
    "nl:recount:sum",
  ],
  closing: {
    "nl:recount:": C,
    "nl:recount:ids": C,
    "nl:recount:lock": C,
    "nl:recount:state": C,
    "nl:recount:sum": C,
  },
};
