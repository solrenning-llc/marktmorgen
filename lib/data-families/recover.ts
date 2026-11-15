// Key families of the topic "nl:recover..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, I, T, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:recover:off:",
  ],
  elsewhere: [
    "nl:recover:asks",
    "nl:recover:link:",
    "nl:recover:once:",
    "nl:recover:sent:",
    "nl:recover:tries:",
  ],
  closing: {
    "nl:recover:asks": I,
    "nl:recover:link:": T("nl:erase:ix:", 400),
    "nl:recover:off:": E,
    "nl:recover:once:": E,
    "nl:recover:sent:": X(15),
    "nl:recover:tries:": X(1),
  },
};
