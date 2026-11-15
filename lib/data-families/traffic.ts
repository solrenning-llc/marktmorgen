// Key families of the topic "nl:traffic..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, I, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:traffic:c:",
    "nl:traffic:day:",
    "nl:traffic:folders:",
    "nl:traffic:n:",
    "nl:traffic:r:",
    "nl:traffic:x:",
  ],
  closing: {
    "nl:traffic:c:": E,
    "nl:traffic:day:": E,
    "nl:traffic:folders:": I,
    "nl:traffic:n:": E,
    "nl:traffic:r:": E,
    "nl:traffic:x:": E,
  },
};
