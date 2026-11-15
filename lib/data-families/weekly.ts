// Key families of the topic "nl:weekly..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, Cr, I, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:weekly:lock",
    "nl:weekly:off",
    "nl:weekly:seen:",
    "nl:weekly:sent:",
    "nl:weekly:to:",
  ],
  closing: {
    "nl:weekly:lock": C,
    "nl:weekly:off": I,
    "nl:weekly:seen:": Cr(9),
    "nl:weekly:sent:": Cr(14),
    "nl:weekly:to:": { how: "erase", by: "handle" },
  },
};
