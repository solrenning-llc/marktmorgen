/** Storage admission must disclose the enforced allowance and preserve bought access.
 * Profitability is assessed by the all-cost/all-tax release policy, not this test. */
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Pricing } from "@/components/home-parts";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { STORAGE_BRAKE_BYTES, storageWords } from "@/lib/storage-quota";

const GB = 1024 * 1024 * 1024;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

test("the current storage allowance is a finite whole byte count", () => {
  assert.ok(Number.isSafeInteger(STORAGE_BRAKE_BYTES) && STORAGE_BRAKE_BYTES > 0);
});

test("pricing discloses stored capacity rather than promising monthly delivery bandwidth", () => {
  const text=renderToStaticMarkup(createElement(Pricing)).replace(/<[^>]*>/g," ").replace(/\s+/g," ");
  assert.ok(text.includes(`Up to ${storageWords(STORAGE_BRAKE_BYTES)} of stored files and videos.`));
  assert.match(text,/Uploads pause when there is no room left/);
  assert.doesNotMatch(text,/200 GB of downloads a month|nothing is cut off if you pass it/);
});

test("only an upload is ever refused by it, never a download", () => {
  const callers = walk(join(process.cwd(), "app"))
    .concat(walk(join(process.cwd(), "lib")))
    .map((file) => relative(process.cwd(), file).replaceAll("\\", "/"))
    .filter((f) => !f.endsWith("lib/storage-quota.ts"))
    .filter((f) => /storageUsed/.test(readFileSync(f, "utf8")));

  assert.deepEqual(
    callers.map((f) => f.replace(process.cwd() + "/", "")),
    // The three doors an upload goes through (into the host's file store, to the video service for a lesson's video,
    // lib/stream.ts, and into the R2 file store, lib/vault.ts) measure through lib/image-space.ts since the owner's
    // decision 8 (9 November 2026), which adds the store's pictures (rule 23: the two routes moved from this list to
    // the check below; lib/vault-storage.ts keeps its default measure, which the vault route replaces).
    // And the two places a store whose plan has ended is measured against
    // the room of a store with no plan: the daily job that gives what it
    // keeps a date (lib/plan-closing.ts), and the studio, which shows its
    // owner that date. Neither is a door a buyer comes through, and neither counts pictures (closing never deletes them).
    ["app/studio/page.tsx", "lib/image-space.ts", "lib/plan-closing.ts", "lib/vault-storage.ts"],
    "what a store keeps is measured where an upload is let in, and for a store whose plan has ended. No download is ever refused by it.",
  );
  for (const door of ["app/api/store/file/route.ts", "app/api/store/stream/route.ts", "app/api/store/vault/route.ts"]) {
    assert.match(readFileSync(door, "utf8"), /await spaceUsed\(ref, /, `${door} measures files, videos and pictures together`);
  }
});

test("the figures read as figures", () => {
  assert.equal(storageWords(STORAGE_BRAKE_BYTES), "5 GB");
  assert.equal(storageWords(1.5 * 1024 * GB), "1.5 TB");
  assert.equal(storageWords(2.5 * GB), "2.5 GB");
  assert.equal(storageWords(40 * GB), "40 GB");
  assert.equal(storageWords(900 * 1024 * 1024), "900 MB");
});

test("the creator is told what to do about it, in the studio", () => {
  for (const file of ["components/product-editor.tsx", "components/course-editor.tsx"]) {
    const src = readFileSync(join(process.cwd(), file), "utf8");
    assert.match(src, /storage_full:/, `${file} should say what a full store means and what to do`);
    assert.match(
      src,
      /storage_full:[^\n]*nothing already bought is affected/,
      "and should say plainly that nobody's purchase is touched",
    );
  }
});

test("every brake that acts on its own is shown before it acts", () => {
  // Section 5 of the Terms promises each limit is one you can see while you
  // use the Services, and that none is discovered by being enforced against
  // you. Both brakes were built and drawn nowhere, which made that sentence
  // untrue the day it was written. It is a promise about the studio, so the
  // studio is where it is checked.
  const studio = readFileSync(join(process.cwd(), "app/studio/page.tsx"), "utf8");
  assert.match(
    studio,
    /STORAGE_BRAKE_BYTES/,
    "the storage brake must be visible in the studio: the Terms say no limit is found by hitting it",
  );
  assert.match(
    studio,
    /FREE_PAUSE_ABOVE_BYTES/,
    "and so must the point where free downloads pause",
  );

  const terms = readFileSync(join(process.cwd(), "app/terms/page.tsx"), "utf8");
  assert.match(
    terms,
    /None of them is hidden in this document and then discovered by being\s*\n?\s*enforced against you/,
    "and the clause that makes this a promise has to still be there",
  );
});
