// Key families of the topic "nl:dsched..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, I, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:dsched:",
    "nl:dsched:due",
    "nl:dsched:lock:",
  ],
  closing: {
    // Discount codes waiting for their start (511 [CK3], lib/discount-schedule.ts): go with the store; the due list loses its members.
    "nl:dsched:": E,
    "nl:dsched:due": I,
    "nl:dsched:lock:": E,
  },
};
