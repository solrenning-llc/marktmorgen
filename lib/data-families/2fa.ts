// Key families of the topic "nl:2fa..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, Cr, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:2fa:",
    "nl:2fa:hold:",
    "nl:2fa:keptstar:",
    "nl:2fa:lock:",
    "nl:2fa:locked:",
    "nl:2fa:lockedset:",
    "nl:2fa:once:",
    "nl:2fa:rescue:",
    "nl:2fa:setup:",
  ],
  closing: {
    // An account's sign-in: a person's, not a store's.
    "nl:2fa:": C,
    "nl:2fa:hold:": C,
    "nl:2fa:keptstar:": Cr(400),
    "nl:2fa:lock:": C,
    "nl:2fa:locked:": C,
    // nl:2fa:lockedset: also holds one shared list of kept accounts, at most KEPT_ANY_MAX tags of 41 bytes (lib/two-step.ts KEEP_ANY).
    "nl:2fa:lockedset:": C,
    "nl:2fa:once:": C,
    "nl:2fa:rescue:": C,
    "nl:2fa:setup:": C,
  },
};
