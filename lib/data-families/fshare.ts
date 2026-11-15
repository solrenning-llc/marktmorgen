// Key families of the topic "nl:fshare..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { T, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:fshare:",
    "nl:fshare:n:",
  ],
  closing: {
    "nl:fshare:": T("nl:fshares:"),
    "nl:fshare:n:": X(62),
  },
};
