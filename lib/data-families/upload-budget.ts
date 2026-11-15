// Key families of the topic "nl:upload-budget..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:upload-budget:v2:{",
    "nl:upload-budget:v2:{YYYY-MM}",
  ],
  closing: {
    "nl:upload-budget:v2:{": C,
    "nl:upload-budget:v2:{YYYY-MM}": C,
  },
};
