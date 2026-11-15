// Key families of the topic "nl:hostcal..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { D, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:hostcal:cfg:",
    "nl:hostcal:err:",
    "nl:hostcal:good:",
    "nl:hostcal:lock:",
  ],
  closing: {
    "nl:hostcal:cfg:": D("prepare"),
    "nl:hostcal:err:": D("prepare"),
    "nl:hostcal:good:": D("prepare"),
    "nl:hostcal:lock:": D("prepare"),
  },
};
