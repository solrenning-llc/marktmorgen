// Key families of the topic "nl:orders..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, I, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:orders:folders:",
    "nl:orders:link:",
    "nl:orders:n:",
    "nl:orders:open:",
    "nl:orders:pending:",
    "nl:orders:seen:",
  ],
  closing: {
    "nl:orders:folders:": I,
    "nl:orders:link:": X(1),
    "nl:orders:n:": E,
    "nl:orders:open:": E,
    "nl:orders:pending:": E,
    // Legacy marks expire in45days. The inactive original-window checkpoint
    // may retain its receipt for767days; this is not its legacy price envelope.
    "nl:orders:seen:": X(767),
  },
};
