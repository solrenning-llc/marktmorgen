// Key families of the topic "nl:sweep..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:sweep:cursor",
    "nl:sweep:walk:",
  ],
  closing: {
    "nl:sweep:cursor": C,
    // The checkout sweep's place in one store's completed or expired checkouts of the day (lib/checkout-sweep.ts, walkDay):
    // the five-minute job's own, like its cursor; two keys a store at most, each kept a day.
    "nl:sweep:walk:": C,
  },
};
