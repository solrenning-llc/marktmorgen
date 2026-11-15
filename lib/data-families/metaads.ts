// Key families of the topic "nl:metaads..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, E, I, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:metaads:conn:",
    "nl:metaads:gen",
    "nl:metaads:pass",
    "nl:metaads:read:",
    "nl:metaads:reading:",
    "nl:metaads:state:",
    "nl:metaads:stores",
    "nl:metaads:user:",
  ],
  closing: {
    "nl:metaads:conn:": E,
    "nl:metaads:gen": C,
    "nl:metaads:pass": C,
    "nl:metaads:read:": E,
    "nl:metaads:reading:": E,
    "nl:metaads:state:": X(1),
    "nl:metaads:stores": I,
    "nl:metaads:user:": I,
  },
};
