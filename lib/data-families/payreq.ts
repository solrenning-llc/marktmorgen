// Key families of the topic "nl:payreq..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, I, T, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:payreq:due",
    "nl:payreq:o:",
    "nl:payreq:p:",
    "nl:payreq:r:",
    "nl:payreq:s:",
  ],
  elsewhere: [
    "nl:payreq:lock:",
    "nl:payreq:stores",
    "nl:payreq:w:",
  ],
  closing: {
    // Payment requests (lib/payment-request-store.ts): the store's lists go, and each request through them; its reminders and its place in the sweep's list are taken out.
    "nl:payreq:due": I,
    "nl:payreq:lock:": X(1),
    "nl:payreq:o:": E,
    "nl:payreq:p:": E,
    "nl:payreq:r:": T("nl:payreq:s:", 400),
    "nl:payreq:s:": E,
    "nl:payreq:stores": I,
    "nl:payreq:w:": X(1),
  },
  followed: [
    "nl:payreq:s:",
  ],
};
