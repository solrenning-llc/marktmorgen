// Key families of the topic "nl:pk..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:pk:",
    "nl:pk:auth:",
    "nl:pk:cred:",
    "nl:pk:drop:",
    "nl:pk:lock:",
    "nl:pk:reg:",
  ],
  closing: {
    // An account's sign-in: a person's, not a store's.
    "nl:pk:": C,
    "nl:pk:auth:": C,
    "nl:pk:cred:": C,
    "nl:pk:drop:": C,
    "nl:pk:lock:": C,
    "nl:pk:reg:": C,
  },
};
