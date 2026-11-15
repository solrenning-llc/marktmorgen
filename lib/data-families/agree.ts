// Key families of the topic "nl:agree..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, T, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:agree:p:",
    "nl:agree:r:",
    "nl:agree:s:",
    "nl:agree:v:",
  ],
  elsewhere: [
    "nl:agree:lock:",
  ],
  closing: {
    // Proposals and agreements (lib/agreement-store.ts): the store's lists go, and each agreement and its versions through them.
    "nl:agree:lock:": X(1),
    "nl:agree:p:": E,
    "nl:agree:r:": T("nl:agree:s:", 400),
    "nl:agree:s:": E,
    "nl:agree:v:": T("nl:agree:s:", 400),
  },
  followed: [
    "nl:agree:s:",
  ],
};
