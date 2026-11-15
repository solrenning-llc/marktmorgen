// Key families of the topic "nl:team..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { D, E, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:team:",
    "nl:team:invite:",
    "nl:team:lock:",
    "nl:team:log:",
    "nl:team:of:",
  ],
  closing: {
    "nl:team:": E,
    "nl:team:invite:": X(7),
    "nl:team:lock:": E,
    "nl:team:log:": E,
    "nl:team:of:": D("prepare"),
  },
};
