// Key families of the topic "nl:rev..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, I, T, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:rev:",
    "nl:rev:all:",
    "nl:rev:new:",
    "nl:rev:off:",
    "nl:rev:pay:",
    "nl:rev:stop:",
    "nl:rev:sum:",
    "nl:rev:vis:",
  ],
  elsewhere: [
    "nl:rev:ask:due",
    "nl:rev:ask:sent:",
    "nl:rev:link:",
    "nl:rev:lock:",
    "nl:rev:refunds:seen:",
    "nl:rev:refunds:since:",
    "nl:rev:stores",
  ],
  closing: {
    "nl:rev:": E,
    "nl:rev:all:": E,
    "nl:rev:ask:due": I,
    "nl:rev:ask:sent:": X(120),
    "nl:rev:link:": T("nl:erase:ix:", 60),
    "nl:rev:lock:": E,
    "nl:rev:new:": E,
    "nl:rev:off:": E,
    "nl:rev:pay:": E,
    "nl:rev:refunds:seen:": E,
    "nl:rev:refunds:since:": E,
    "nl:rev:stop:": T("nl:erase:ix:", 400),
    "nl:rev:stores": I,
    "nl:rev:sum:": E,
    "nl:rev:vis:": E,
  },
};
