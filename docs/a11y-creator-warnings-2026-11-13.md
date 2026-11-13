# Accessibility warnings for creators, and Marktmorgen's own media: inventory (13 November 2026)

AX274 Part A item 6: before publishing, the studio warns about contrast below 7:1, a picture with no text
alternative, a video with no captions or transcript, headings out of order and a link without a clear purpose,
and offers the fix in one press, never changing the creator's content without their approval. Item 4 (hearing
and media) asks captions, a transcript and audio description for Marktmorgen's own videos. This is what the code
on `main` and the open pull requests did on 13 November 2026. No code changes with it.

## The five warnings

| Warning | State | Where | Open PRs |
| --- | --- | --- | --- |
| Contrast below 7:1 | **Done without a warning: fixed for the creator.** The creator's colour is moved until button words keep 7:1 and text in the creator's colour keeps 7:1 on the page, a card and an item (`lookColours`, `nearestPassing`); the themes' own colours are set at 7:1 or more. Nothing the creator types is changed: only how their colour is drawn. | `lib/store-look.ts`; `tests/band-link-contrast.test.ts` | #3916, #3922 touch the file (other lines) |
| Picture with no text alternative | **Done, in part.** "Can everyone use your store?" lists the products of the store's first page whose picture has no description, and counts the ones it could not read as unchecked, never as fine; the sales page's coach counts its pictures with no description. Each links to the place to write it; nothing is written for the creator. | `lib/store-access-check.ts`, `components/store-access-check.tsx`, `lib/page-coach.ts` | none on these files |
| Video with no captions | **Done for lessons.** "Can everyone follow your lessons?" lists the lessons whose video can take captions and has none, says which are still being written by AI, and counts apart the videos kept where captions cannot be added. | `lib/course-access-check.ts`, `components/course-access-check.tsx` | #3881 changes it (a refund owed that cannot be read whole) |
| Video with no transcript | **Not done.** No check, and no place to give a lesson or a sales page video a transcript. | none | none |
| Headings out of order | **Not needed: the creator cannot set a heading's level.** A sales page's blocks draw their own headings (`h2` for a block, `h3` inside it; `components/sales-blocks.tsx`), and a blog post's only heading is a line starting with `## ` (`lib/store-blog.ts`), drawn under the post's title. | `components/sales-blocks.tsx`, `lib/store-blog.ts` | none |
| Link without a clear purpose | **Done.** The store's links whose words do not say where they go, and the sales page's buttons, are found by one rule (`vagueLinkTitle`) and listed with the place to change them. | `lib/link-purpose.ts`, `lib/store-access-check.ts`, `lib/page-coach.ts` | none |
| Emails (the same checks) | **In an open PR.** `lib/mail-access-check.ts` is new in #4414. | #4414 | #4414 |

What "before publishing" means today: the checks are panels the creator opens (the store's, the course's) and
the coach beside the sales page editor. None stops or holds a publish, and none should without the owner's
decision: a store that cannot publish because of a missing description would stop selling.

## Gaps, for decision

These are new features, not small fixes, so they are listed rather than built:

1. **Products after the first page.** The store check reads only the cards the store's record already carries
   (the first `STORE_PAGE_SIZE` products), so a picture without a description on a later product is not
   listed. Checking every product means reading more of the record per check.
2. **Transcripts.** A place to give a lesson video, and a sales page video, a transcript (typed, uploaded, or
   made from its captions), shown to buyers beside the video, and a check that lists the videos without one.
   Making one from captions already written costs nothing more; writing one with AI would be a paid job with
   its own ceiling (AX274: never a cost without a ceiling).
3. **Videos kept on YouTube, Vimeo or Loom** (sales pages, the store's welcome video, the thank-you note).
   Their captions live at the provider, and reading whether they have any needs the provider's API. At most a
   reminder beside the field ("Check your video has captions on YouTube").
4. **A warning at the moment of publishing.** A short line beside "Save" or "Publish" when the page's checks are
   not done, with the link to each, never a block on publishing.

## Marktmorgen's own media (item 4)

Marktmorgen has no video or audio of its own today: no media file in `public/`, and no YouTube, Vimeo or Loom
embed on its own pages (`app/`, outside the creators' pages and the studio). Every video on the site is a
creator's, and is covered by the warnings above. When Marktmorgen makes its own help or product videos, each
needs captions, a full transcript, extended audio description (1.2.7) and, for help videos, sign language
(1.2.6), as AX274 item 4 asks; their cost belongs to the fixed costs (FX275), with a ceiling, before any is made.
