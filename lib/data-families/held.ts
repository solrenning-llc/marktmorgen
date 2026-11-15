// Key families of the topic "nl:held..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, Cr, I, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:held:month:",
    "nl:held:retry:",
    "nl:held:stores",
    "nl:held:walk",
  ],
  closing: {
    "nl:held:month:": Cr(400),
    "nl:held:retry:": Cr(2),
    "nl:held:stores": I,
    "nl:held:walk": C,
  },
};
