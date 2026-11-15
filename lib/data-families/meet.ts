// Key families of the topic "nl:meet..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, E, I, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:meet:conn:",
    "nl:meet:lock:",
    "nl:meet:log:",
    "nl:meet:q",
    "nl:meet:r:",
    "nl:meet:refresh:",
    "nl:meet:rf:",
    "nl:meet:state:",
    "nl:meet:stores",
    "nl:meet:test:",
    "nl:meet:user:",
    "nl:meet:zoomseen:",
  ],
  closing: {
    "nl:meet:conn:": E,
    "nl:meet:lock:": E,
    "nl:meet:log:": E,
    "nl:meet:q": I,
    "nl:meet:r:": E,
    "nl:meet:refresh:": E,
    "nl:meet:rf:": E,
    "nl:meet:state:": X(1),
    "nl:meet:stores": I,
    "nl:meet:test:": E,
    "nl:meet:user:": I,
    "nl:meet:zoomseen:": C,
  },
};
