// Key families of the topic "nl:heard..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { I, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:heard:done:",
    "nl:heard:off",
  ],
  closing: {
    "nl:heard:done:": X(30),
    "nl:heard:off": I,
  },
};
