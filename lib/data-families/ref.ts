// Key families of the topic "nl:ref..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:ref:all",
    "nl:ref:by:",
    "nl:ref:c:",
    "nl:ref:code:",
    "nl:ref:cursor",
    "nl:ref:list:",
    "nl:ref:mine:",
    "nl:ref:mycode:",
    "nl:ref:owed",
  ],
  closing: {
    "nl:ref:all": C,
    "nl:ref:by:": C,
    "nl:ref:c:": C,
    "nl:ref:code:": C,
    "nl:ref:cursor": C,
    "nl:ref:list:": C,
    "nl:ref:mine:": C,
    "nl:ref:mycode:": C,
    "nl:ref:owed": C,
  },
};
