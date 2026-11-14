# Checks before publishing in the studio (12 November 2026)

AX274 Part A items 2 and 6 (ATAG 2.0 Part B): before something goes out, the studio warns about what a reader
cannot use and offers a fix the creator approves; it never changes the creator's content on its own. This is an
inventory from main `f964dbd9` and a record of what this change adds. It is not a conformity claim.

## What each editor checks

| Editor | Picture without words | Link or button words | Video captions or transcript | Contrast under 7:1 | Heading order | One-press fix |
| --- | --- | --- | --- | --- | --- | --- |
| Page editor | Required: a picture block cannot be saved without words unless marked decorative (`lib/sales-page.ts`, `parseRowElement`); coach line "described" (`lib/page-coach.ts`) | Coach line `button_words` (`lib/page-coach.ts`, `lib/link-purpose.ts`) | Not checked: YouTube and Vimeo players are outside Marktmorgen; no transcript field | Blocks use the theme's colors only | Levels set by the renderer from block order (`components/sales-blocks.tsx`) | No |
| Store page | Store check (`lib/store-access-check.ts`) | Store links (`lib/link-purpose.ts`) | n/a | Button colors moved to 7:1 and the creator told (`lib/store-look.ts`) | Set by the renderer | No |
| Course lessons | n/a | n/a | Captions per lesson video (`lib/course-access-check.ts`); transcripts not checked | Theme | Set by the renderer | Link to the captions field |
| Product editor | Empty description means decorative by design (`components/product-image-editor.tsx`); counted by the store check | n/a | n/a | Theme | n/a | No |
| Email editor | **Added here** | **Added here** (buttons and bare addresses) | n/a (no video in emails) | Colors moved to 7:1 (`lib/mail-body.ts`, `lib/email-theme.ts`) | One heading level (`h2`), no skip possible | **Added here** |

## Added: "Can everyone read it?" in the email's "Check before it goes out"

`lib/mail-access-check.ts` reads the email exactly as it is drawn (`parseMailBlocks`, the first six pictures,
the same `https://` addresses made links) and names, in reading order:

- a picture with no words, or words that say nothing, such as "image" or a file name (WCAG 1.1.1);
- a button whose words do not say where it goes, such as "Click here" (2.4.4, 2.4.9);
- a bare web address, which the email turns into a link whose words are the address (2.4.9).

`components/mail-access-review.tsx` lists them with why each matters, "Show it in the text" (opens Write and
selects the place) and, where safe, a fix in one press with words the creator types: describe the picture,
rename the button, or turn an address alone on its line into a button. Vague, empty or too long words are
refused with the error tied to the field. A fix refuses to write when that place changed since the check.
Every fix is said in a status region, which is in the page from the start and takes the focus after a press
(the pressed control may be gone), and can be undone. Long addresses wrap, so nothing scrolls sideways at 320 px. "It is only decoration" changes nothing in the text
(an email already draws a picture with no words as `alt=""`); that choice is kept on the page only.

The email is never blocked: the panel says "You can still send it", and "Yes, send it" stays as it was.

## Not done, and why

- **The "send anyway" choice is not stored with the email.** Keeping it would add bytes to every campaign record
  in the store's data room, which is counted against the plan; that needs a product decision, not this change.
- **Page-builder videos:** captions of a YouTube or Vimeo video cannot be read without calling those services;
  there is no transcript field. A transcript field is a product decision.
- **Product pictures:** an empty description is the product editor's own "decorative" today; telling it apart
  from a forgotten one needs a separate decorative mark, a data change.
- **Contrast:** colors are already moved to 7:1 for stores and emails, so no pair below 7:1 can go out; a
  warning with a choice instead would be a change of behavior.
- **Assistive technology:** checked with axe (every WCAG 2.0–2.2 A/AA/AAA rule), target size, real Tab presses
  and reflow in Chromium (`tests/e2e/mail-access-review.mjs`); Firefox and WebKit run in CI. No screen reader,
  voice control or person was used: a gap, not a pass.
