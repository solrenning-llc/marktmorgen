// Key families of the topic "nl:list..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:list:try:",
  ],
  closing: {
    // A store with no list: its one try of the day to be given one (lib/store-readings.ts, listForNaming). By its id,
    // gone with it, as its readings' counts are (it also expires in two days).
    "nl:list:try:": E,
  },
};
