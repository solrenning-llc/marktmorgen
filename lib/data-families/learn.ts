// Key families of the topic "nl:learn..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, T, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:learn:enr:",
  ],
  elsewhere: [
    "nl:learn:link:",
    "nl:learn:paid:",
    "nl:learn:pass:",
    "nl:learn:passes:",
    "nl:learn:rate:addr:",
    "nl:learn:rate:ip:",
  ],
  closing: {
    "nl:learn:enr:": E,
    "nl:learn:link:": X(1),
    "nl:learn:paid:": E,
    "nl:learn:pass:": T("nl:learn:passes:", 90),
    "nl:learn:passes:": E,
    "nl:learn:rate:addr:": X(1),
    "nl:learn:rate:ip:": X(1),
  },
  followed: [
    "nl:learn:passes:",
  ],
};
