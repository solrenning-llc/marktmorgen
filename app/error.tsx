"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Something failed on our side while drawing a page. Said plainly, with a way
 * to try again; nothing the visitor did caused it, and nothing was charged by
 * the page failing to draw.
 */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("a page failed to render", error.digest ?? "");
  }, [error]);

  return (
    <main id="content" className="flex min-h-screen items-center bg-paper px-4 py-20 text-ink">
      {/* A client error boundary cannot export metadata: React's <title> names the tab and the page for what it is (WCAG 2.4.2). */}
      <title>This page did not load — Marktmorgen</title>
      <div className="card mx-auto w-full max-w-lg p-7 sm:p-9">
        <p className="eyebrow">Something went wrong</p>
        <h1 className="t-h3 mt-3">This page did not load</h1>
        <p className="mt-3 text-ink-soft">
          Try again to reopen the page. If it still does not load, return to the home page and open it from there.
        </p>
        {error.digest ? <p className="mt-3 text-sm text-ink-mute">{`Reference: ${error.digest}`}</p> : null}
        <div className="mt-7 flex flex-wrap items-center gap-4">
          <button type="button" className="btn btn-primary" onClick={() => reset()}>
            Try again
          </button>
          <Link href="/" className="btn btn-secondary">
            Home page
          </Link>
        </div>
      </div>
    </main>
  );
}
