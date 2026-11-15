// Key families of the topic "nl:auth..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:auth:code:",
    "nl:auth:devices:",
    "nl:auth:fresh:",
    "nl:auth:lastcode:",
    "nl:auth:link:",
    "nl:auth:linkcode:",
    "nl:auth:move-broken:",
    "nl:auth:move:",
    "nl:auth:moving:",
    "nl:auth:rec:",
    "nl:auth:rec:bound:",
    "nl:auth:rec:link:",
    "nl:auth:rec:set:",
    "nl:auth:rec:until:",
    "nl:auth:second:",
    "nl:auth:session:",
    "nl:auth:sessions:",
  ],
  closing: {
    // An account's sign-in: a person's, not a store's.
    "nl:auth:code:": C,
    "nl:auth:devices:": C,
    "nl:auth:fresh:": C,
    "nl:auth:lastcode:": C,
    "nl:auth:link:": C,
    "nl:auth:linkcode:": C,
    "nl:auth:move-broken:": C,
    "nl:auth:move:": C,
    "nl:auth:moving:": C,
    "nl:auth:rec:": C,
    "nl:auth:rec:bound:": C,
    "nl:auth:rec:link:": C,
    "nl:auth:rec:set:": C,
    "nl:auth:rec:until:": C,
    "nl:auth:second:": C,
    "nl:auth:session:": C,
    "nl:auth:sessions:": C,
  },
};
