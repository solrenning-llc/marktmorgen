// Key families of the topic "nl:order-confirmation..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:order-confirmation:closed:",
    "nl:order-confirmation:due",
    "nl:order-confirmation:erased:",
    "nl:order-confirmation:person:",
    "nl:order-confirmation:row:",
    "nl:order-confirmation:source:",
    "nl:order-confirmation:store:",
  ],
  closing: {
    // Constructed pre-URL origins are never activated. Pending/unknown have no
    // fixed TTL; built own erasers remove confirmed payloads and protect older
    // unresolved recipients with bounded row markers and dedicated fences.
    // Lifetime/copy/failure funding remains an activation blocker, not permission
    // to retain a closed store's payload without reviewed funding/cleanup.
    "nl:order-confirmation:closed:": C,
    "nl:order-confirmation:due": C,
    "nl:order-confirmation:erased:": C,
    "nl:order-confirmation:person:": C,
    "nl:order-confirmation:row:": C,
    "nl:order-confirmation:source:": C,
    "nl:order-confirmation:store:": C,
  },
};
