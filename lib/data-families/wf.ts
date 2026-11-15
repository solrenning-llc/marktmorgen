// Key families of the topic "nl:wf..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:wf:held:",
    "nl:wf:log:",
    "nl:wf:run:",
    "nl:wf:runs:",
  ],
  elsewhere: [
    "nl:wf:abandoned:",
    "nl:wf:day:",
  ],
  closing: {
    "nl:wf:abandoned:": X(2),
    "nl:wf:day:": E,
    "nl:wf:held:": E,
    "nl:wf:log:": E,
    "nl:wf:run:": E,
    "nl:wf:runs:": E,
  },
};
