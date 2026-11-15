// Key families of the topic "nl:plan-refund..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:plan-refund:",
    "nl:plan-refund:ending",
    "nl:plan-refund:next",
  ],
  closing: {
    "nl:plan-refund:": C,
    "nl:plan-refund:ending": C,
    "nl:plan-refund:next": C,
  },
};
