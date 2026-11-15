// Key families of the topic "nl:crm..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { E, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:crm:co:",
    "nl:crm:deals:",
    "nl:crm:pacc:",
    "nl:crm:pipes:",
    "nl:crm:tasks:",
    "nl:crm:v:",
  ],
  elsewhere: [
    "nl:crm:co:lock:",
    "nl:crm:fields:",
    "nl:crm:stages:",
    "nl:crm:tasklock:",
    "nl:crm:taskrecount:",
  ],
  closing: {
    "nl:crm:co:": E,
    "nl:crm:co:lock:": X(1),
    "nl:crm:deals:": E,
    "nl:crm:fields:": E,
    "nl:crm:pacc:": E,
    "nl:crm:pipes:": E,
    "nl:crm:stages:": E,
    "nl:crm:tasklock:": X(1),
    "nl:crm:taskrecount:": X(1),
    "nl:crm:tasks:": E,
    "nl:crm:v:": E,
  },
};
