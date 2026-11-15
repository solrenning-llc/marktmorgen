// Key families of the topic "nl:call..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, I, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:call:busy:",
    "nl:call:confirmed:",
    "nl:call:series:",
  ],
  elsewhere: [
    "nl:call:creator-reminded:",
    "nl:call:lock:",
    "nl:call:moved:",
    "nl:call:reminded:",
    "nl:call:remindq",
    "nl:call:room:",
  ],
  closing: {
    "nl:call:busy:": E,
    "nl:call:confirmed:": X(430),
    "nl:call:creator-reminded:": E,
    "nl:call:lock:": E,
    "nl:call:moved:": X(200),
    "nl:call:reminded:": X(430),
    "nl:call:remindq": I,
    "nl:call:room:": E,
    "nl:call:series:": E,
  },
};
