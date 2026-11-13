/* eslint-disable @next/next/no-html-link-for-pages -- The root layout failed, so the app router may be gone with it: the way home is a native anchor, a full page load that leans on nothing that failed. */
"use client";

import { useEffect } from "react";

/*
 * Its own CSS, because the site's stylesheet came with the layout that failed. Text #1c1917 and #44403c on #ffffff
 * (about 17:1 and 10:1), the link and button #4c1d95 (about 10:1); in the dark, #fafaf9 and #d6d3d1 on #1c1917, the
 * link and button #ddd6fe, all at least 7:1 (WCAG 1.4.6). A 3px focus outline (2.4.13), 44px targets (2.5.5), lines
 * under 80 characters with a line height of 1.6 (1.4.8), and nothing that moves.
 */
const CSS = `
:root { color-scheme: light dark; }
body { margin: 0; background: #ffffff; color: #1c1917; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 1.0625rem; line-height: 1.6; }
main { box-sizing: border-box; max-width: 36rem; margin: 0 auto; padding: 4rem 1rem; }
h1 { font-size: 1.75rem; line-height: 1.25; margin: 0 0 1rem; }
p { margin: 0 0 1rem; color: #44403c; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 1rem; margin-top: 1.5rem; }
button { min-height: 44px; padding: 0.5rem 1.25rem; border: 0; border-radius: 0.75rem; background: #4c1d95; color: #ffffff; font: inherit; font-weight: 600; cursor: pointer; }
a { display: inline-flex; align-items: center; min-height: 44px; color: #4c1d95; font-weight: 600; text-decoration: underline; text-underline-offset: 4px; }
button:focus-visible, a:focus-visible { outline: 3px solid #4c1d95; outline-offset: 3px; }
@media (prefers-color-scheme: dark) {
  body { background: #1c1917; color: #fafaf9; }
  p { color: #d6d3d1; }
  button { background: #ddd6fe; color: #1c1917; }
  a { color: #ddd6fe; }
  button:focus-visible, a:focus-visible { outline-color: #ddd6fe; }
}
@media (forced-colors: active) {
  button { border: 1px solid ButtonText; }
}
`;

/**
 * The page drawn when the site's root layout itself fails (Next.js global-error): it replaces the whole document,
 * so it brings its own html, language, title, styles and words, and leans on nothing from the layout that failed.
 * Said plainly, with a way to try again (this Next.js version's retry()) and a plain link home. Nothing the
 * visitor did caused it, and nothing was charged by the page failing to draw. app/error.tsx is the same page for
 * a failure below the layout.
 */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error && typeof error === "object" && "digest" in error && typeof error.digest === "string" ? error.digest : "";
  useEffect(() => {
    console.error("the site's layout failed to render", digest);
  }, [digest]);

  return (
    <html lang="en-US">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>This page did not load — Marktmorgen</title>
        <style>{CSS}</style>
      </head>
      <body>
        <main id="content">
          <h1>This page did not load</h1>
          <p>Something failed on our side. Nothing you did caused it.</p>
          <p>Try again to reopen the page. If it still does not load, go to the home page and open it from there.</p>
          {digest ? <p>{`Reference: ${digest}`}</p> : null}
          <div className="row">
            <button type="button" onClick={() => retry()}>
              Try again
            </button>
            <a href="/">Go to the home page</a>
          </div>
        </main>
      </body>
    </html>
  );
}
