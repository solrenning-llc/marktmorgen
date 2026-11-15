// Key families of the topic "nl:stream..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, E, I, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:stream:cap:",
    "nl:stream:v:",
  ],
  elsewhere: [
    "nl:stream:auto:",
    "nl:stream:autoowed:",
    "nl:stream:autoq",
    "nl:stream:col:",
    "nl:stream:due",
    "nl:stream:gone",
    "nl:stream:lock",
    "nl:stream:peek:",
  ],
  closing: {
    "nl:stream:auto:": E,
    "nl:stream:autoowed:": E,
    "nl:stream:autoq": I,
    "nl:stream:cap:": E,
    "nl:stream:col:": E,
    "nl:stream:due": I,
    "nl:stream:gone": C,
    "nl:stream:lock": C,
    "nl:stream:peek:": E,
    "nl:stream:v:": E,
  },
};
