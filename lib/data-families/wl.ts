// Key families of the topic "nl:wl..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, I, T, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:wl:",
    "nl:wl:t:",
  ],
  elsewhere: [
    "nl:wl:jobs",
  ],
  closing: {
    "nl:wl:": E,
    "nl:wl:jobs": I,
    "nl:wl:t:": T("nl:erase:ix:", 7),
  },
};
