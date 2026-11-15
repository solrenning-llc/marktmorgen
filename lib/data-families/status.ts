// Key families of the topic "nl:status..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:status:views:",
  ],
  closing: {
    // The public status page's count of an hour's requests (247 [SP4] unit 2, lib/status-page.ts), the company's, kept two hours.
    "nl:status:views:": C,
  },
};
