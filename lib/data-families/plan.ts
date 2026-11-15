// Key families of the topic "nl:plan..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, Cr, I, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:plan:closing:",
    "nl:plan:closing:after",
    "nl:plan:ended",
    "nl:plan:paying",
  ],
  closing: {
    "nl:plan:closing:": Cr(400),
    "nl:plan:closing:after": C,
    "nl:plan:ended": I,
    "nl:plan:paying": I,
  },
};
