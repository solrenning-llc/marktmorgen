// Key families of the topic "nl:yearly..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, I, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:yearly:price:",
  ],
  elsewhere: [
    "nl:yearly:fallback:both",
    "nl:yearly:fallback:check",
    "nl:yearly:fallback:try:",
    "nl:yearly:fallback:void",
    "nl:yearly:link:",
  ],
  closing: {
    // A failed yearly renewal moved to monthly (lib/yearly-fallback.ts): its tries lapse; the daily job takes each entry out of its list.
    "nl:yearly:fallback:both": I,
    "nl:yearly:fallback:check": I,
    "nl:yearly:fallback:try:": X(2),
    "nl:yearly:fallback:void": I,
    "nl:yearly:link:": X(30),
    "nl:yearly:price:": E,
  },
};
