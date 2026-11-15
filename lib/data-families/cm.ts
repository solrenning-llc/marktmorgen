// Key families of the topic "nl:cm..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, I, T, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:cm:",
    "nl:cm:unsub:",
  ],
  elsewhere: [
    "nl:cm:evmail:",
    "nl:cm:evmailq",
    "nl:cm:evq",
    "nl:cm:link:",
    "nl:cm:mail:",
    "nl:cm:mailq",
    "nl:cm:rl:",
  ],
  closing: {
    "nl:cm:": E,
    "nl:cm:evmail:": X(30),
    "nl:cm:evmailq": I,
    "nl:cm:evq": I,
    "nl:cm:link:": X(1),
    "nl:cm:mail:": X(30),
    "nl:cm:mailq": I,
    "nl:cm:rl:": E,
    "nl:cm:unsub:": T("nl:cm:"),
  },
  followed: [
    "nl:cm:",
  ],
};
