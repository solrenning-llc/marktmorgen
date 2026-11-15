// Key families of the topic "nl:esync..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, I, T, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:esync:tags:",
  ],
  elsewhere: [
    "nl:esync:bad:",
    "nl:esync:cfg:",
    "nl:esync:j:",
    "nl:esync:log:",
    "nl:esync:q",
    "nl:esync:seen:",
  ],
  closing: {
    "nl:esync:bad:": E,
    "nl:esync:cfg:": E,
    "nl:esync:j:": T("prepare", 7),
    "nl:esync:log:": E,
    "nl:esync:q": I,
    "nl:esync:seen:": X(30),
    "nl:esync:tags:": E,
  },
};
