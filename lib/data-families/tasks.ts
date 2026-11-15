// Key families of the topic "nl:tasks..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, E, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:tasks:bytes:",
    "nl:tasks:doors",
    "nl:tasks:held",
    "nl:tasks:taken:",
  ],
  closing: {
    "nl:tasks:bytes:": E,
    "nl:tasks:doors": C,
    "nl:tasks:held": C,
    "nl:tasks:taken:": X(1),
  },
};
