// Key families of the topic "nl:forget..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, Cr, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:forget:kept",
    "nl:forget:month:",
    "nl:forget:q",
  ],
  closing: {
    // Deleted stores whose webhooks, keys and assistant notes are tried again (lib/store-forget-retry.ts): the line, and each month's counts.
    "nl:forget:kept": C,
    "nl:forget:month:": Cr(400),
    "nl:forget:q": C,
  },
};
