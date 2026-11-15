/**
 * 772 [SA4]: no new code path may start reading a store's whole catalog. Each
 * such read grows with the catalog (one listing GET per product outside the
 * first page, measured in tests/catalog-whole-read-load.test.ts), so a ceiling
 * above MAX_PRODUCTS is only possible once these reads are paged or indexed
 * (docs/sa4-catalog-study-2026-11-15.md, unit 2). Until then this list is the
 * whole inventory, each with why it reads everything. A new call fails here
 * and has to be either bounded (a page, a slice, an index) or added below with
 * its reason and its price in the cost registry.
 *
 * What counts as a whole-catalog read, found in lib/, app/ and components/:
 *   readAllListings(…)                          every product
 *   readListings / readListingsMeasured / readListingsExact (…) with one argument (no ids: every product)
 *   readKind / readKindExact (store, kind)      every product of one kind
 *   a reader given visibleIds(…), productIds(…) or idsOfKind(…) whole (no .slice on the same line)
 * Source text only: nothing is run, nothing is read from a database.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { done, is, part } from "./check";

/** The tests run from the repository root (tests/test-runner.mjs). */
const ROOT = process.cwd();

/** Every file that reads the whole catalog today, how many times, and why. Keep the reason honest: it is the review's record. */
const KNOWN: Record<string, { reads: number; why: string }> = {
  "lib/catalog.ts": { reads: 4, why: "the readers themselves: readAllListings, readKind, readKindExact and searchStore (a visitor's search; priced by #4144/#4172)" },
  "lib/store-sitemap.ts": { reads: 1, why: "the store's sitemap lists every visible product" },
  "lib/auto-marks.ts": { reads: 1, why: "automatic marks look at every product beside the store's broadcasts" },
  "lib/store.ts": { reads: 3, why: "a stock change and a product removal look for every product that sells or bundles it (soldWithOthers, bundle holders)" },
  "lib/plan-closing.ts": { reads: 1, why: "a closing plan reads every product once, from a daily job" },
  "lib/closed-store-data.ts": { reads: 1, why: "a closed store's data file holds every product" },
  "lib/data-recount.ts": { reads: 1, why: "the recount job weighs every product, store by store with a cursor" },
  "lib/imports.ts": { reads: 1, why: "an import matches members to every product by id and title" },
  "lib/store-export.ts": { reads: 2, why: "the export holds every product, priced by measuring first" },
  "lib/person-erasure.ts": { reads: 1, why: "a person's erasure reads every course, to delete their progress in each" },
  "lib/store-copy.ts": { reads: 1, why: "a store copy copies every product" },
  "lib/calls.ts": { reads: 1, why: "the weekly sessions read every call product" },
  "lib/demo-seed.ts": { reads: 4, why: "the demo store finds its seeded products by title; a demo store holds a handful" },
  "app/api/store/product/route.ts": { reads: 1, why: "saving a product finds which products the change silences" },
  "app/api/store/file/route.ts": { reads: 1, why: "a file's access checks every course" },
  "app/api/store/vault/route.ts": { reads: 1, why: "the vault's access checks every course" },
  "app/api/store/stream/route.ts": { reads: 1, why: "a stream's access checks every course" },
  "app/api/store/stream/captions/route.ts": { reads: 1, why: "captions' access checks every course" },
  "app/api/store/community/manage/route.ts": { reads: 1, why: "community management lists every course" },
  "app/api/store/calendar/[token]/route.ts": { reads: 1, why: "the booking calendar feed reads every call (CALENDAR_BUILD_SHAPE prices it at MAX_PRODUCTS)" },
  "app/studio/page.tsx": { reads: 2, why: "the studio home reads the call and recurring products" },
  "app/studio/students/page.tsx": { reads: 1, why: "the students page lists every course" },
  "app/studio/calendar/page.tsx": { reads: 1, why: "the studio calendar reads every call" },
  "app/studio/bundles/page.tsx": { reads: 1, why: "the bundles page lists every bundle" },
  "app/studio/reviews/page.tsx": { reads: 1, why: "the reviews page names the products of the reviews shown (the ids filtered to those reviews)" },
  "app/api/store/automation-draft/route.ts": { reads: 1, why: "a workflow draft reads the store's visible products, bounded: productIds(store) filtered, then .slice(0, MAX_DRAFT_PRODUCTS); listed because the line pattern stops at the filter's \"))\" and does not see the .slice (added when origin/main was merged in, 15/11/2026)" },
};

const READERS = "(?:readListings|readListingsMeasured|readListingsExact|readListingsExactMeasured|readProducts)";
const PATTERNS: RegExp[] = [
  /\breadAllListings\(/g,
  new RegExp(`\\b(?:readListings|readListingsMeasured|readListingsExact)\\(\\s*[A-Za-z_$][\\w$.]*\\s*\\)`, "g"),
  /\breadKind(?:Exact)?\(\s*[A-Za-z_$][\w$.]*\s*,/g,
  new RegExp(`\\b${READERS}\\(\\s*[A-Za-z_$][\\w$.]*\\s*,\\s*(?:visibleIds|productIds|idsOfKind)\\(`, "g"),
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/** Whole-catalog reads in one file's text: matches of the patterns, a bounded one (a .slice on the same line) left out. */
function wholeReads(text: string): number {
  let reads = 0;
  for (const line of text.split("\n")) {
    if (/^\s*(\*|\/\/)/.test(line)) continue;
    if (/^export (async )?function (readAllListings|readKind|readKindExact|readListings|readListingsMeasured|readListingsExact)\b/.test(line.trim())) continue;
    for (const pattern of PATTERNS) {
      for (const match of line.matchAll(pattern)) {
        const rest = line.slice((match.index ?? 0) + match[0].length);
        if (/^[^;]*\.slice\(/.test(rest.split(")).")[0] ?? "")) continue;
        reads += 1;
      }
    }
  }
  return reads;
}

function main(): void {
  const base = ROOT;
  const found: Record<string, number> = {};
  for (const top of ["lib", "app", "components"]) {
    for (const path of sources(join(base, top))) {
      const reads = wholeReads(readFileSync(path, "utf8"));
      if (reads > 0) found[relative(base, path).split("\\").join("/")] = reads;
    }
  }

  part("The patterns find what they should, and skip what is bounded");
  is("readAllListings", wholeReads("const all = await readAllListings(store);"), 1);
  is("readListings with no ids", wholeReads("const all = await readListings(store);"), 1);
  is("readKind of one kind", wholeReads('const calls = await readKind(store, "call");'), 1);
  is("every visible id", wholeReads("await readListings(store, visibleIds(store));"), 1);
  is("a slice of them is bounded", wholeReads("await readListings(store, visibleIds(store).slice(0, 24));"), 0);
  is("one product is not the catalog", wholeReads("await readListings(store, [id]);"), 0);
  is("an unrelated readKind is not a catalog read", wholeReads("const kind = readKind(note.kind);"), 0);

  part("No new whole-catalog read");
  const unknown = Object.keys(found).filter((file) => !(file in KNOWN));
  is("every file that reads the whole catalog is in the inventory, with its reason", unknown, []);
  const grown = Object.entries(found).filter(([file, reads]) => file in KNOWN && reads > KNOWN[file].reads).map(([file, reads]) => `${file}: ${reads} > ${KNOWN[file].reads}`);
  is("no file reads the whole catalog more times than the inventory says", grown, []);
  const stale = Object.keys(KNOWN).filter((file) => !(file in found)).concat(Object.entries(found).filter(([file, reads]) => file in KNOWN && reads < KNOWN[file].reads).map(([file]) => file));
  is("an entry no longer true is taken out or lowered (the inventory stays exact)", stale, []);
  done();
}

main();
