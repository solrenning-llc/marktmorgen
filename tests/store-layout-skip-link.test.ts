/**
 * 310 [AX2]: every buyer route in a creator store gets one native skip link
 * from the shared store layout, before the route's own content.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { done, is, part } from "./check";

const root = join("app", "[handle]");
const layout = readFileSync(join(root, "layout.tsx"), "utf8");

const filesBelow = (folder: string): string[] =>
  readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? filesBelow(path) : entry.name.endsWith(".tsx") ? [path] : [];
  });

part("The store boundary owns the buyer's first route to content");
is("the store layout imports the shared native link", /import \{ SkipLink \} from ["']@\/components\/skip-link["'];/.test(layout), true);
is("the store layout renders exactly one link", (layout.match(/<SkipLink \/>/g) ?? []).length, 1);
is("the link is before the nested buyer page", layout.indexOf("<SkipLink />") >= 0 && layout.indexOf("<SkipLink />") < layout.indexOf("{children}"), true);
is("a non-store fallback keeps its own global skip link instead", /\{store\s*\?\s*<SkipLink \/>\s*:\s*null\}/.test(layout), true);

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
