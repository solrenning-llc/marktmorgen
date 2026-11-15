// Key families of the topic "nl:slink..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, T, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:slink:",
    "nl:slink:store:",
  ],
  closing: {
    "nl:slink:": T("nl:slink:store:"),
    "nl:slink:store:": E,
  },
  followed: [
    "nl:slink:store:",
  ],
};
