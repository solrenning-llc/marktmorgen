// Key families of the topic "nl:pkg..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, T, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:pkg:",
    "nl:pkg:s:",
    "nl:pkg:t:",
  ],
  closing: {
    "nl:pkg:": T("nl:pkg:s:"),
    "nl:pkg:s:": E,
    "nl:pkg:t:": T("nl:pkg:s:"),
  },
  followed: [
    "nl:pkg:s:",
  ],
};
