// Key families of the topic "nl:pp..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { Cr, E, I, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:pp:",
    "nl:pp:item:",
    "nl:pp:open:",
    "nl:pp:stores",
    "nl:pp:unk:month:",
  ],
  closing: {
    "nl:pp:": E,
    "nl:pp:item:": X(400),
    "nl:pp:open:": E,
    "nl:pp:stores": I,
    "nl:pp:unk:month:": Cr(400),
  },
};
