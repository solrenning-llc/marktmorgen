// Key families of the topic "nl:upd..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, T, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:upd:last:",
    "nl:upd:latest:",
    "nl:upd:off:",
    "nl:upd:stop:",
  ],
  elsewhere: [
    "nl:upd:job:",
  ],
  closing: {
    "nl:upd:job:": X(120),
    "nl:upd:last:": E,
    "nl:upd:latest:": E,
    "nl:upd:off:": E,
    "nl:upd:stop:": T("nl:erase:ix:", 400),
  },
};
