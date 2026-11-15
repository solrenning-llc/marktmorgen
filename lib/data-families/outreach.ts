// Key families of the topic "nl:outreach..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, E, T, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:outreach:",
    "nl:outreach:stoplink:",
  ],
  elsewhere: [
    "nl:outreach:stop:all",
  ],
  closing: {
    "nl:outreach:": E,
    "nl:outreach:stop:all": C,
    "nl:outreach:stoplink:": T("nl:outreach:"),
  },
  followed: [
    "nl:outreach:",
  ],
};
