/**
 * AX274 Part A on the page shown when the root layout itself fails (#4691). Without app/global-error.tsx, Next shows its
 * built-in page: no lang (3.1.1), no title of the site's own (2.4.2), no main region, no plain next step and no way back.
 * `global-error` renders its own document, without app/globals.css (Next's docs of this version, error.md, "Global
 * Error"), so the page carries its own <html lang>, <title>, styles and focus ring.
 *
 * Rendered from the real component (no browser), with a thrown error that carries a message and a digest:
 * - the document: <html lang="en-US">, as app/layout.tsx; a <title>; one <main>; one h1 in plain English;
 * - the next steps: a "Try again" button that calls `retry` (this version's prop) and a link to the home page;
 * - 2.5.5: both targets at least 44 x 44 px, in the page's own styles;
 * - 1.4.6: text and both controls at 7:1 or more, in the light and in the dark scheme;
 * - 2.4.7 / 2.4.13: a 3 px focus ring of its own;
 * - nothing of the error on the screen: neither its message nor its digest.
 */
import { existsSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { contrastRatio } from "@/lib/dark-tokens";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("app/global-error.tsx exists");
  const there = existsSync("app/global-error.tsx");
  is("the root layout has an error page of its own", there, true);
  if (!there) return done();

  const { default: GlobalError } = await import("@/app/global-error");
  const { GLOBAL_ERROR_LOOK } = await import("@/lib/global-error-look");
  const error = Object.assign(new Error("secret detail: database password 1234"), { digest: "DIGEST-4691" });
  let retried = 0;
  const html = renderToStaticMarkup(createElement(GlobalError, { error, retry: () => (retried += 1), reset: () => {} }));

  part("The document");
  is("<html lang=\"en-US\">, as app/layout.tsx", /<html[^>]*\blang="en-US"/.test(html), true);
  is("a title of its own", /<title>[^<]+<\/title>/.test(html), true);
  is("one main region", (html.match(/<main\b/g) ?? []).length, 1);
  const h1 = html.match(/<h1\b[^>]*>([^<]+)<\/h1>/g) ?? [];
  is("one h1", h1.length, 1);
  is("the h1 in plain words", /did not load|went wrong/i.test(h1[0] ?? ""), true);

  part("The next steps");
  is("a \"Try again\" button", /<button[^>]*type="button"[^>]*>Try again<\/button>/.test(html), true);
  is("a link to the home page", /<a[^>]*href="\/"[^>]*>[^<]*[Hh]ome[^<]*<\/a>/.test(html), true);
  is("the button's handler is not drawn into the markup", retried, 0);

  part("Nothing of the error on the screen");
  is("not its message", html.includes("secret detail") || html.includes("1234"), false);
  is("not its digest", html.includes("DIGEST-4691"), false);

  part("2.5.5: 44 x 44 px targets, in the page's own styles");
  const style = (html.match(/<style>([\s\S]*?)<\/style>/) ?? [])[1] ?? "";
  is("the page carries its own styles", style.length > 0, true);
  const rule = (selector: string) => (style.match(new RegExp(`${selector.replace(/[.[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`)) ?? [])[1] ?? "";
  const action = rule(".ge-action");
  is("each control is at least 44 px tall", /min-height:\s*44px/.test(action), true);
  is("and at least 44 px wide", /min-width:\s*44px/.test(action), true);
  is("both controls carry that class", (html.match(/class="ge-action[^"]*"/g) ?? []).length, 2);

  part("2.4.7 / 2.4.13: a 3 px focus ring of its own");
  is("a 3 px outline on :focus-visible", /:focus-visible\s*\{[^}]*outline:\s*3px solid/.test(style), true);

  part("1.4.6: 7:1 or more, in the light and the dark scheme");
  for (const scheme of ["light", "dark"] as const) {
    const c = GLOBAL_ERROR_LOOK[scheme];
    const pairs: [string, string, string][] = [
      ["text on the page", c.text, c.page],
      ["muted text on the page", c.muted, c.page],
      ["the primary button's words", c.primaryText, c.primary],
      ["the link's words on the page", c.link, c.page],
    ];
    const low = pairs.filter(([, fg, bg]) => contrastRatio(fg, bg) < 7).map(([what, fg, bg]) => `${what}: ${contrastRatio(fg, bg).toFixed(2)}`);
    is(`${scheme}: no pair under 7:1`, low, []);
    is(`${scheme}: the focus ring at 3:1 or more on the page`, contrastRatio(c.focus, c.page) >= 3, true);
    is(`${scheme}: its colors are the ones the page draws`, [c.text, c.page, c.primary, c.focus].every((hex) => style.toLowerCase().includes(hex.toLowerCase())), true);
  }
  is("the dark colors apply under prefers-color-scheme: dark", /@media \(prefers-color-scheme: dark\)/.test(style), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
