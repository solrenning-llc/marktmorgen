/**
 * 651 [WG11], unit 1: where a page may show something while it loads, and
 * where it may not. Three things were found trying page-wide skeletons
 * (#2733), and each fails here:
 *
 *   1. A loading.tsx anywhere under app/. Next prefetches every dynamic
 *      route under one from each link on screen ("a dynamic route is
 *      skipped unless it has a loading.js boundary", node_modules/next/dist/
 *      docs/01-app/02-guides/prefetching.md). On a store's pages that is a
 *      read of the store per product link per visit, and in the studio a
 *      request per link, none with a ceiling (AGENTS.md MR: no spending
 *      without one). In WebKit, a reload that cut such a prefetch raised a
 *      page error (tests/e2e/path-board-replies.mjs).
 *
 *   2. A redirect inside a <Suspense> that has already streamed: Next can
 *      only write <meta http-equiv="refresh" content="1;url=…"> with a 200
 *      (node_modules/next/dist/server/app-render/
 *      make-get-server-inserted-html.js), a refresh on a timer (WCAG F41,
 *      2.2.1, 3.2.5). A loading.tsx is such a <Suspense> around the whole
 *      page, which is one more reason for (1).
 *
 *   3. A <Suspense> around the page's <main id="content">. React 19.2 holds
 *      a finished boundary hidden for up to about 300 ms before it shows it
 *      (the reveal script in next/dist/compiled/react-dom/cjs/
 *      react-dom-server.edge.production.js waits $RT+300). Meanwhile the
 *      real <main> stands inside React's hidden holder, so "Skip to the page
 *      content" sometimes leads nowhere and the focus never reaches the
 *      content: the studio matrix (tests/e2e/accessibility-studio-matrix.mjs,
 *      skip-content-focus.mjs) failed on Today once in one run in CI and
 *      once in three locally. A <Suspense> belongs inside the <main>, around
 *      one slow section, as app/studio/deals and app/studio/people already
 *      do, so that the landmark, its heading and the first control are
 *      there from the first byte.
 *
 * (3) is read from the source, as an order: in every page and layout under
 * app/, no <Suspense> stands before the first id="content". The browser
 * matrices remain the proof that the focus arrives.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

/** Every file under a folder whose name matches. */
function files(dir: string, name: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path, name);
    return name.test(entry.name) ? [path] : [];
  });
}

function main(): void {
  part("no loading file anywhere under app/ (1 and 2)");
  is("app/ has no loading.tsx, loading.ts, loading.jsx or loading.js", files("app", /^loading\.(?:tsx|ts|jsx|js|mdx)$/), []);
  is("in particular none under app/[handle]/, a store's own pages", files("app/[handle]", /^loading\.(?:tsx|ts|jsx|js|mdx)$/), []);

  part("no <Suspense> around a page's <main id=\"content\"> (3)");
  const routes = files("app", /^(?:page|layout)\.(?:tsx|jsx)$/);
  is("the pages and layouts under app/ are found", routes.length > 100, true);
  const before = routes.filter((path) => {
    const source = readFileSync(path, "utf8");
    const suspense = source.search(/<Suspense\b/);
    const content = source.search(/\bid=["{]["']?content\b/);
    return suspense >= 0 && content >= 0 && suspense < content;
  });
  is("no page or layout opens a <Suspense> before its id=\"content\"", before, []);
  // A layout's <Suspense> around {children} would put every page's <main> inside it.
  const aroundChildren = routes.filter((path) => /<Suspense\b[^>]*>\s*\{children\}\s*<\/Suspense>/.test(readFileSync(path, "utf8")));
  is("no layout puts {children} inside a <Suspense>", aroundChildren, []);

  part("the pattern already used stays allowed");
  for (const path of ["app/studio/deals/page.tsx", "app/studio/people/page.tsx"]) {
    const source = readFileSync(path, "utf8");
    is(`${path} opens its <Suspense> inside its <main id="content">`, source.search(/\bid="content"/) >= 0 && source.search(/\bid="content"/) < source.search(/<Suspense\b/), true);
  }
  done();
}

main();
