// Key families of the topic "nl:quiet..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, Cr, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:quiet:at:",
    "nl:quiet:lock",
    "nl:quiet:seen:",
    "nl:quiet:sent:",
  ],
  closing: {
    "nl:quiet:at:": C,
    "nl:quiet:lock": C,
    "nl:quiet:seen:": Cr(2),
    "nl:quiet:sent:": Cr(30),
  },
};
