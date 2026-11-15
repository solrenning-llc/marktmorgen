## Summary

Fixes #4691. `app/error.tsx` only catches errors below the root layout. An error in `app/layout.tsx` itself is caught only by `app/global-error.tsx`, which did not exist, so Next's built-in page was shown. That page has no `lang`, no title of the site's own, no main region and no way back.

This adds `app/global-error.tsx`. Per Next's docs of this version (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`, "Global Error"), the page renders its own document and gets none of `app/globals.css`; it is a Client Component; its title comes from React's `<title>`; and its recovery prop is `retry`. So the page brings:
- `<html lang="en-US">`, the same value as `app/layout.tsx`, and a `<title>`;
- one `<main>` and one plain-English `h1` ("This page did not load");
- a "Try again" button that calls `retry()`, and a link to the home page;
- its own styles, from `lib/global-error-look.ts`: the site's light and dark tokens as plain values (switched by `prefers-color-scheme`), 44 px targets, a 3 px focus ring and a forced-colors rule;
- nothing from the error on screen. The digest goes to the console only, as `app/error.tsx` does.

## RED → GREEN

- RED a6b41c202, `tests/global-error-page.test.ts`: fails on main, because the component does not exist.
- GREEN: 23 checks pass. The test renders the real component with an error that carries a message and a digest, and checks:
  - lang, title, one main, one h1;
  - the button and the home link;
  - neither the message nor the digest on screen;
  - 44 × 44 px in the page's own CSS, on both controls;
  - the 3 px ring;
  - 7:1 for text, muted text, the button's words and the link, in light and in dark, and 3:1 for the ring, with those colors present in the sheet the page draws.
- `next typegen` + `tsc --noEmit`: 0 errors. eslint on the three files: clean. The home link uses `next/link`, as `app/error.tsx` does; the rule `@next/next/no-html-link-for-pages` refuses a plain `<a>`.

## Acessibilidade

- **Criteria checked:**
  - 3.1.1 (lang), 2.4.2 (title), 1.3.1 (main, h1);
  - 3.3.5 and 3.1.5 (a plain next step);
  - 2.5.5 (44 × 44);
  - 1.4.6 (7:1, light and dark);
  - 2.4.7 and 2.4.13 (3 px ring);
  - 1.4.10 (reflow at 320 px);
  - forced colors.
- **Method:**
  - the unit test above;
  - the page rendered from the component into Chromium (Playwright) at 320 and 1280 px, in light, dark and forced-colors;
  - axe-core with the tags wcag2a/aa/aaa, wcag21a/aa, wcag22aa and best-practice, plus `color-contrast-enhanced`;
  - bounding boxes, a Tab walk and the computed outline.
- **Results:**
  - axe found no violations in any of the 6 runs;
  - targets measure 121 × 50 and 214 × 50 px;
  - the 3 px ring shows on both controls (#4946a6 in light, #c3c1f7 in dark);
  - no sideways scroll at 320 px;
  - `lang` is en-US and the title is "This page did not load — Marktmorgen".
- **Not checked:**
  - an actual failure of the root layout in a running build (it cannot be triggered without changing the app);
  - the site's own theme toggle: as Next's docs say, `global-error` does not get `data-color-scheme`, so it follows the OS setting;
  - real screen readers, Safari and Firefox.
- Automated checks do not certify conformity.
- **Steps and decisions of the main task:** 0 → 0.
