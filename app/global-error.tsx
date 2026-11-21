"use client";

import Link from "next/link";
import { useEffect } from "react";
import { GLOBAL_ERROR_STYLE } from "@/lib/global-error-look";

/**
 * Shown when the root layout itself fails (app/error.tsx only catches what is below it). It replaces the whole
 * document and gets none of app/globals.css (Next's docs of this version, error.md, "Global Error"), so it brings its
 * own lang, title, styles and focus ring (#4691; tests/global-error-page.test.ts). Said plainly, with a way to try
 * again and a way home. Nothing of the error is drawn: its digest goes to the console only, as app/error.tsx does.
 */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    const digest = error instanceof Error && "digest" in error ? String((error as { digest?: unknown }).digest ?? "") : "";
    console.error("the root layout failed to render", digest);
  }, [error]);

  return (
    <html lang="en-US">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>This page did not load — Marktmorgen</title>
        <style>{GLOBAL_ERROR_STYLE}</style>
      </head>
      <body>
        <main id="content">
          <div className="ge-card">
            <p className="ge-muted">Something went wrong on our side</p>
            <h1>This page did not load</h1>
            <p>Try again to reopen the page. If it still does not load, go to the home page and open it from there. Nothing you did caused this.</p>
            <div className="ge-steps">
              <button type="button" className="ge-action ge-primary" onClick={() => retry()}>
                Try again
              </button>
              <Link href="/" className="ge-action ge-link">
                Go to the home page
              </Link>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
