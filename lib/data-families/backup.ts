// Key families of the topic "nl:backup..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:backup:last-fail",
    "nl:backup:last-ok",
    "nl:backup:lock",
    "nl:backup:ran:",
  ],
  closing: {
    // the company's daily backup run (lib/backup-run.ts), no store's
    "nl:backup:last-fail": C,
    "nl:backup:last-ok": C,
    "nl:backup:lock": C,
    "nl:backup:ran:": C,
  },
};
