// Key families of the topic "nl:ship..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:ship:done:",
    "nl:ship:mail:all",
    "nl:ship:mail:closed:",
    "nl:ship:mail:due",
    "nl:ship:mail:erased:",
    "nl:ship:mail:person:",
    "nl:ship:mail:pool",
    "nl:ship:mail:pool:",
    "nl:ship:mail:row:",
    "nl:ship:mail:store:",
  ],
  closing: {
    // The direct legacy source has400days. A pending source has no TTL;
    // cleanup owns its transition, so the walk cannot promise400days for all.
    "nl:ship:done:": C,
    "nl:ship:mail:all": C,
    "nl:ship:mail:closed:": C,
    "nl:ship:mail:due": C,
    "nl:ship:mail:erased:": C,
    "nl:ship:mail:person:": C,
    "nl:ship:mail:pool": C,
    "nl:ship:mail:pool:": C,
    "nl:ship:mail:row:": C,
    "nl:ship:mail:store:": C,
  },
};
