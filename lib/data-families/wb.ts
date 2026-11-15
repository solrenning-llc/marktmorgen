// Key families of the topic "nl:wb..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, E, T, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:wb:",
    "nl:wb:cursor",
    "nl:wb:link:",
    "nl:wb:n:",
    "nl:wb:once:",
  ],
  closing: {
    "nl:wb:": E,
    "nl:wb:cursor": C,
    "nl:wb:link:": T("nl:erase:ix:", 60),
    "nl:wb:n:": E,
    "nl:wb:once:": E,
  },
};
