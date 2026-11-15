// Key families of the topic "nl:hooks..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, E, I, T, X, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  elsewhere: [
    "nl:hooks:anchor:",
    "nl:hooks:cfg:",
    "nl:hooks:d:",
    "nl:hooks:evt:",
    "nl:hooks:log:",
    "nl:hooks:pos",
    "nl:hooks:q",
    "nl:hooks:stores",
    "nl:hooks:wait:",
  ],
  closing: {
    "nl:hooks:anchor:": E,
    "nl:hooks:cfg:": E,
    "nl:hooks:d:": T("prepare", 7),
    "nl:hooks:evt:": X(30),
    "nl:hooks:log:": E,
    "nl:hooks:pos": C,
    "nl:hooks:q": I,
    "nl:hooks:stores": I,
    "nl:hooks:wait:": E,
  },
};
