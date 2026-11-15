// Key families of the topic "nl:keys..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:keys:",
  ],
  closing: {
    // License keys (lib/licence-keys.ts): a product's pool, keys, sales (with the mark of a sale refunded before it had a key, or whose full refund is still pending), records and buyers waiting.
    "nl:keys:": E,
  },
};
