/**
 * 310 [AX2]: every buyer route in a creator store gets one native skip link
 * from the shared store layout, before the route's own content.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { done, is, part } from "./check";

const root = join("app", "[handle]");
const layout = readFileSync(join(root, "layout.tsx"), "utf8");
const storeNotFound = readFileSync(join(root, "not-found.tsx"), "utf8");
const siteNotFound = readFileSync(join("app", "not-found.tsx"), "utf8");
const siteNav = readFileSync(join("components", "site-nav.tsx"), "utf8");

const filesBelow = (folder: string): string[] =>
  readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? filesBelow(path) : entry.name.endsWith(".tsx") ? [path] : [];
  });

part("The store boundary owns the buyer's first route to content");
is("the store layout imports the shared native link", /import \{ SkipLink \} from ["']@\/components\/skip-link["'];/.test(layout), true);
// The store's own words and lang ride on it (lib/buyer-words/skip.ts, tests/store-layout-language.test.ts).
is("the store layout renders exactly one link", (layout.match(/<SkipLink\b[^>]*\/>/g) ?? []).length, 1);
is("the link is before the nested buyer page", layout.indexOf("<SkipLink") >= 0 && layout.indexOf("<SkipLink") < layout.indexOf("{children}"), true);
is("only an active resolved store receives the store-layout link", /\{store\s*&&\s*!store\.suspended\s*\?\s*<SkipLink\b[^>]*\/>\s*:\s*null\}/.test(layout), true);

part("A suspended store keeps the global fallback's single route instead");
const suspendedUsesSiteNotFound = /if \(!store \|\| store\.suspended\) return <SiteNotFound \/>/.test(storeNotFound);
const siteNotFoundUsesSiteNav = /<SiteNav \/>/.test(siteNotFound);
const siteNavAddsSkip = /href=["']#content["']/.test(siteNav);
is("a suspended store chooses the global not-found page", suspendedUsesSiteNotFound, true);
is("the global not-found page renders the site navigation", siteNotFoundUsesSiteNav, true);
is("the site navigation owns its existing content link", siteNavAddsSkip, true);
is(
  "the composed suspended-store fallback has one content link, not two",
  Number(suspendedUsesSiteNotFound && siteNotFoundUsesSiteNav && siteNavAddsSkip),
  1,
);

part("Nested buyer pages never compete with their shared boundary");
const pages = filesBelow(root).filter((file) => file !== join(root, "layout.tsx"));
const destinations = pages.filter((file) => /<main\b[^>]*\bid=["']content["']/.test(readFileSync(file, "utf8")));
is("the contract covers the full current buyer-route family", destinations.length >= 45, true);
is(
  "no nested buyer page owns a duplicate skip link",
  destinations.filter((file) => /href=["']#content["']/.test(readFileSync(file, "utf8"))).map((file) => relative(root, file)),
  [],
);

done();
