// Key families of the topic "nl:cal..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, T, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:cal:builds:",
    "nl:cal:busy:",
    "nl:cal:cfg:",
    "nl:cal:chg:",
    "nl:cal:err:",
    "nl:cal:good:",
    "nl:cal:lock:",
    "nl:cal:out:",
    "nl:cal:pace:",
    "nl:cal:refused:",
    "nl:cal:tok:",
  ],
  closing: {
    // The private feed's counts (C4-4), by the store's id, go with it, as its copy does; the changed mark and its makings, by the calls id, expire.
    "nl:cal:builds:": E,
    "nl:cal:chg:": X(40),
    "nl:cal:pace:": E,
    "nl:cal:refused:": E,
    "nl:cal:busy:": T("nl:cal:cfg:", 1),
    "nl:cal:cfg:": E,
    "nl:cal:err:": T("nl:cal:cfg:", 1),
    "nl:cal:good:": T("nl:cal:cfg:", 1),
    "nl:cal:lock:": T("nl:cal:cfg:", 1),
    "nl:cal:out:": E,
    "nl:cal:tok:": T("nl:cal:cfg:"),
  },
  followed: [
    "nl:cal:cfg:",
  ],
};
