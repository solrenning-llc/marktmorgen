// Key families of the topic "nl:tip..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    // A gift's checkout mark (lib/store-tip-checkout.ts, R20 finding 3).
    "nl:tip:co:",
  ],
  closing: {
    // A gift's checkout mark (lib/store-tip-checkout.ts, R20 finding 3): a hash names it, never the store; gone by itself in two days.
    "nl:tip:co:": X(2),
  },
};
