/**
 * A page of ours never prints a store address on marktmorgen.com that does
 * not exist.
 *
 * Search engines read addresses written as plain text, not only links. The
 * API reference (/developers) showed a sample product at
 * https://marktmorgen.com/@harbor/p/k3j9x2p1ab, a store that was never made:
 * Google read it there, crawled it and reported it as "Not found (404)"
 * (Search Console, last crawl 14 Nov 2026; issue GSC404-20261120-1832).
 *
 * So, in every page and route under app/ (comments aside), a store address
 * on our domain names only the demo store (lib/house-store.ts), which is
 * kept made on every deployment. A sample needs another address: a reserved
 * documentation domain such as example.com (RFC 2606), which is what a
 * store with its own domain is given back anyway (lib/purchase-email.ts,
 * storeBase).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { HOUSE_HANDLE } from "@/lib/house-store";
import { done, is, part } from "./check";

const root = join(process.cwd(), "app");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx|md|mdx|txt)$/.test(name) ? [path] : [];
  });
}

/** The lines that are not comments: what a page can actually show or send. */
function spoken(text: string): string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line));
}

part("no store address on our domain but the demo store's");
const found: string[] = [];
for (const file of files(root)) {
  for (const line of spoken(readFileSync(file, "utf8"))) {
    for (const match of line.matchAll(/https?:\/\/(?:www\.)?marktmorgen\.com\/(?:@|%40)([A-Za-z0-9_-]+)/gi)) {
      if (match[1].toLowerCase() !== HOUSE_HANDLE) found.push(`${relative(process.cwd(), file)}: ${match[0]}`);
    }
  }
}
is("every store address written in app/ is one that exists", found, []);

part("the API reference's sample product is on a documentation domain");
const developers = readFileSync(join(root, "developers", "page.tsx"), "utf8");
is("the sample product's page is on example.com", developers.includes('"url": "https://shop.example.com/p/k3j9x2p1ab"'), true);
is("the invented store's address is gone", developers.includes("marktmorgen.com/@harbor"), false);

done();
