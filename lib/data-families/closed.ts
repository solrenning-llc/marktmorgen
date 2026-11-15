// Key families of the topic "nl:closed..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:closed:batch",
    "nl:closed:due",
    "nl:closed:lock",
    "nl:closed:walk",
  ],
  closing: {
    "nl:closed:batch": C,
    "nl:closed:due": C,
    "nl:closed:lock": C,
    "nl:closed:walk": C,
  },
};
