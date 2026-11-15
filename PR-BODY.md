## fix(a11y): help answers and questions break a word longer than a phone line (WCAG 1.4.10, 1.4.12, 274 [AX1])

Found in the measured browser sweep outside the studio (Claude 4, cloud AA, 15 November 2026). Some help answers hold a word longer than a 320 px line: an address with its path, or a tracking tag (`utm_source={{site_source_name}}&utm_campaign={{campaign.name}}.`). Each section's answers sit in a box that clips (`overflow-hidden`, for its rounded corners), so the end of the word was cut off. Nothing could scroll it back into view.

- `app/help/page.tsx`: the answer paragraphs and the questions take `wrap-anywhere` (`overflow-wrap: anywhere`). A long word breaks only where it has to.
- `tests/help-answer-long-words.test.ts`:
  - RED commits: e3c45f2dbd (answers) and 5d0c93b6ed (questions). Both fail on main.
  - It also holds the reason: an answer holds a word of 30 characters or more.

## Acessibilidade
- **Criteria:** 1.4.10 Reflow (AA), 1.4.12 Text Spacing (AA), 1.4.8 (line width unchanged).
- **Method:** a production build (`next build` + `next start`) in Chromium, with every `<details>` opened. For each clipping box, the probe measured how far the box overflows (`scrollWidth − clientWidth`) and which text ranges and elements reach past its right edge. It ran twice: with the page's own spacing, and with 1.4.12's spacing injected (line height 1.5, letters 0.12em, words 0.16em, paragraphs 2em).
- **Results:**

  | /help at 320 px | Before (main) | After (4b4dc978b4) |
  | --- | --- | --- |
  | Page's own spacing | Two answers clipped by 40 and 83 px | 0 |
  | 1.4.12 spacing | Four sections clipped by 15, 62, 109 and 160 px | 0 |

  The 15 px was the open/closed circle of "I run a website and saw MarktmorgenOutreach in my logs…", pushed out by the long word. /help at 1280 px and /help/buyers at 320 and 1280 px: 0 before and 0 after.
- **Tests:** `help-answer-long-words` 6/6; `buyer-help`, `type-scale` and `question-block` pass.
- **Not checked:**
  - The same FAQ box in `components/topic-page.tsx` (/platform's topics); it was not measured.
  - Firefox and WebKit, real devices, screen readers, testing with people.
  - Passing automation is not a claim of conformance.
- **Steps and decisions for the main task:** 0 → 0.
