/**
 * The line a stamped PDF carries along the bottom of every page
 * (lib/pdf-stamp.ts prints it). On its own, with no PDF library, so a page
 * that only shows the line, such as the feature page's card, reads it from
 * here. Browser-safe.
 */
export function stampLine(email: string, reference: string, at: Date = new Date()): string {
  const day = at.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const order = reference.replace(/^(cs|pi)_(test|live)?_?/, "").slice(-6).toUpperCase();
  return `Sold to ${email} on ${day} · order …${order} · for personal use`;
}
