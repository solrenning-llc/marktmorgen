// Key families of the topic "nl:pod..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, T, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:pod:",
    "nl:pod:by:",
    "nl:pod:t:",
  ],
  elsewhere: [
    "nl:pod:n:",
    "nl:pod:ok:",
  ],
  closing: {
    "nl:pod:": E,
    "nl:pod:by:": E,
    "nl:pod:n:": X(2),
    "nl:pod:ok:": E,
    "nl:pod:t:": T("nl:pod:by:"),
  },
  followed: [
    "nl:pod:by:",
  ],
};
