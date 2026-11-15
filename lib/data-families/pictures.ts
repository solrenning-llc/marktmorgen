// Key families of the topic "nl:pictures..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:pictures:doors:",
  ],
  closing: {
    // A store's picture uploads not yet put on anything (lib/picture-door.ts): expires a day after its last note.
    "nl:pictures:doors:": X(1),
  },
};
