/**
 * A post's date as the blog shows it ("Oct 27, 2026"), read at noon UTC so it is the same day everywhere.
 * On its own, outside lib/blog.ts, so the blog's browser filter (components/blog-browser.tsx) formats a
 * date without carrying every post's text and what that file imports (tests/blog-browser-bundle.test.ts).
 */
export function formatPostDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
