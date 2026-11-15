// Key families of the topic "nl:store..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, Cr, E, I, T, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:store:leads:",
  ],
  elsewhere: [
    "nl:store:before-catalog:",
    "nl:store:delivery:",
    "nl:store:delivery:over:",
    "nl:store:folder-owner:",
    "nl:store:handle:",
    "nl:store:id:",
    "nl:store:lock:",
    "nl:store:owner:",
    "nl:store:owner:*",
    "nl:store:photo:",
  ],
  closing: {
    "nl:store:before-catalog:": T("prepare"),
    "nl:store:delivery:": E,
    "nl:store:delivery:over:": I,
    "nl:store:folder-owner:": E,
    "nl:store:handle:": Cr(30),
    "nl:store:id:": E,
    "nl:store:leads:": E,
    "nl:store:lock:": E,
    "nl:store:owner:": T("prepare"),
    "nl:store:owner:*": C,
    "nl:store:photo:": E,
  },
  followed: [
    "nl:store:leads:",
  ],
};
