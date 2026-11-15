// Key families of the topic "nl:ses..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:ses:did:",
    "nl:ses:h:",
    "nl:ses:once:",
    "nl:ses:rest:",
    "nl:ses:state",
    "nl:ses:told:",
  ],
  closing: {
    "nl:ses:did:": C,
    "nl:ses:h:": C,
    "nl:ses:once:": C,
    "nl:ses:rest:": C,
    "nl:ses:state": C,
    "nl:ses:told:": C,
  },
};
