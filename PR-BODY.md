## Summary

AX274 Part A item 6 (ATAG 2.0 Part B), with WCAG 1.2.2 Captions and 1.2.8 Media Alternative (AAA): the page coach now asks for each video's captions and transcript before a sales page goes out, and offers the fix. Nothing is written or saved for the creator.

- **`lib/page-video-check.ts` (new, pure, browser-safe).** It finds every video a page shows: the top's, each video block's, and each video or video window in a row's columns. For each, it reads whether the block right under it is a transcript: a text block whose heading starts with "Transcript", either with words in it or still empty. It makes no read and costs nothing.
- **The page coach (`lib/page-coach.ts`).** It gets a new check, "Every video has captions and a transcript", asked only when the version being edited shows a video.
  - Its label counts the videos with no transcript, or the empty ones.
  - Its reason asks the creator to turn captions on where the video is kept (YouTube, Vimeo or Loom). Nothing here can see those captions, and an unknown is never called fine.
  - It is done only when every video has a written transcript right under it.
- **The fix (`components/page-coach.tsx`, `components/page-editor.tsx`).** "Add a transcript under it" puts an empty text block headed "Transcript" right under the first video with none, and opens it.
  - The focus goes to its first field, and the status region says where it went, as a block chosen from the gallery does.
  - Nothing is written in it, and nothing is saved until the creator saves.
  - An empty transcript already there is reported as empty, and no second one is offered.

The course editor's caption check (`lib/course-access-check.ts`) is the model. No price, limit, commission, flag, gate or creator content changed. Nothing costs anything per use: no read and no model call.

## RED → GREEN

`tests/page-coach-video-transcript.test.ts`, 13 checks:
- **RED** (commit `test(a11y): RED …`): with main's page coach, 5 of its first 8 checks fail. There is no such check, no fix is offered, and the empty and written states are not told apart.
- **GREEN:** 13 of 13. The checks cover:
  - a page with no video is not asked;
  - the hero's video, a video block and a row's video window are found;
  - the label, the reason and where the fix points;
  - an empty transcript is seen, not done, and no second one is offered;
  - a written one is done;
  - a transcript further down is not the video's;
  - the editor's fix adds an empty block headed "Transcript" right under the video, opens it, writes no words, moves the focus and says so.

`tests/page-coach.test.ts`: its "complete page" fixture now gives its video a written transcript right under it, which is what a complete page has. Its assertions are unchanged. 94 tests that name the page coach, the page editor or the sales page pass. `tsc`: no error.

## Acessibilidade

**Criteria checked:**
- ATAG B.2.1, B.3.1 and B.3.2 (prompt, check and repair, never changing the creator's content without approval);
- WCAG 1.2.2 and 1.2.8 (what the check asks for);
- 2.4.3 Focus Order (the pressed button goes away, and the focus goes to the new block's first field);
- 4.1.3 Status Messages ("Added Transcript at position 3.");
- 2.5.5 (the button is `btn-sm`, 44 px);
- the whole axe-core rule set (wcag2a/aa/aaa, wcag21a/aa, wcag22aa, best-practice, `color-contrast-enhanced`).

**Method:** the unit tests above, plus a local production build seeded with the e2e fixture store, with a scratch copy of its seed that adds a YouTube video block to "Sunday Baking"'s page (synthetic, not committed). In Playwright on Chromium, at 1280 px, as the synthetic creator, I:
1. opened `/studio/pages?product=…`;
2. pressed "See what to improve";
3. read the check;
4. pressed "Add a transcript under it";
5. read the check again, the focus and the status region;
6. ran axe.

**Results:**
- Before the press: "Every video has captions and a transcript (1 has no transcript)" and one fix button.
- After it: "… (1 transcript is empty)", no fix button, focus in the new block's "Heading" field (value "Transcript"), status "Added Transcript at position 3.", and the page unsaved.
- axe: no violation.
- Steps and decisions for the creator's main task: no new required step. The check adds one optional press and the writing.

**Exclusions and gaps:**
- Captions at YouTube, Vimeo or Loom cannot be seen from here, so they are asked in words only and never counted.
- The second version of a page (A/B) is not checked for videos. Only the version being edited is, where the fix can go.
- Firefox and WebKit were not run. No real assistive technology or person tested it.
- The check is a prompt, not a conformity claim.
