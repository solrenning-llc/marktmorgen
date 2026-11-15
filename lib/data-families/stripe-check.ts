// Key families of the topic "nl:stripe-check..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:stripe-check:last",
    "nl:stripe-check:lock",
    "nl:stripe-check:runs",
  ],
  closing: {
    "nl:stripe-check:last": C,
    "nl:stripe-check:lock": C,
    "nl:stripe-check:runs": C,
  },
};
