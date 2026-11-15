// Key families of the topic "nl:path..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { D, E, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:path:",
    "nl:path:board:owners:v1",
    "nl:path:board:v1",
  ],
  closing: {
    // The owner's Path (lib/path.ts): deleted by the prepare step (forgetPath).
    "nl:path:": E,
    // Shared indexes survive; prepare/forgetPath removes only this store's member and reverse field.
    "nl:path:board:owners:v1": D("prepare"),
    "nl:path:board:v1": D("prepare"),
  },
};
