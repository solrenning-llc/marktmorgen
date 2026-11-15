// Key families of the topic "nl:remind..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:remind:",
    "nl:remind:failed:",
    "nl:remind:lock",
  ],
  closing: {
    "nl:remind:": C,
    "nl:remind:failed:": C,
    "nl:remind:lock": C,
  },
};
