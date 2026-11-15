// Key families of the topic "nl:adsrv..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:adsrv:ctx:",
    "nl:adsrv:sent:",
  ],
  elsewhere: [
    "nl:adsrv:",
    "nl:adsrv:last:",
    "nl:adsrv:sub:",
  ],
  closing: {
    "nl:adsrv:": E,
    "nl:adsrv:ctx:": X(4),
    "nl:adsrv:last:": E,
    "nl:adsrv:sent:": X(3),
    "nl:adsrv:sub:": X(400),
  },
};
