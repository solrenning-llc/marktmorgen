// Key families of the topic "nl:assist..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, I, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:assist:c:",
    "nl:assist:missed:",
    "nl:assist:next:",
    "nl:assist:nextlock:",
    "nl:assist:pool:",
    "nl:assist:remind:",
    "nl:assist:remindq",
    "nl:assist:remindwho:",
  ],
  closing: {
    "nl:assist:c:": X(1),
    "nl:assist:missed:": E,
    "nl:assist:next:": X(3),
    "nl:assist:nextlock:": X(1),
    "nl:assist:pool:": E,
    "nl:assist:remind:": X(3),
    "nl:assist:remindq": I,
    "nl:assist:remindwho:": X(3),
  },
};
