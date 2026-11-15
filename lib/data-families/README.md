# Key families, one file per topic (C2-213, variant B1)

The registry of key families lives in `lib/data-families.ts`. Its four lists stay as they are. A new family can also
go in a topic file here. Its entries are then joined to those lists when `lib/data-families.ts` loads.

- The topic is the first part of the family's name after `nl:`, as `topicOf` says in `scripts/data-families-index.mjs`. For `nl:gift:code:` it is `gift`, in `lib/data-families/gift.ts`.
- A topic file exports `families`, of type `TopicFamilies` (`lib/data-family-kinds.ts`). Each of its four parts is optional:

  ```ts
  import { X, type TopicFamilies } from "@/lib/data-family-kinds";

  export const families: TopicFamilies = {
    elsewhere: [
      "nl:gift:code:",
    ],
    closing: {
      "nl:gift:code:": X(30),
    },
  };
  ```

- Write one entry a line, in alphabetical order.
- A family is never in a topic file and in `lib/data-families.ts` both.
- After adding or removing a topic file, run `node scripts/data-families-index.mjs`. `index.ts` is generated and is never edited by hand. `tests/data-families-index.test.ts` fails while it is stale.
