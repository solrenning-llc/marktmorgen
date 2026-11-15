// Key families of the topic "nl:grp..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { X, er, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:grp:",
    "nl:grp:pi:",
    "nl:grp:take:",
  ],
  closing: {
    "nl:grp:": er(400),
    "nl:grp:pi:": X(400),
    "nl:grp:take:": X(30),
  },
};
