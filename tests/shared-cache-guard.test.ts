/**
 * Nothing private is kept by a shared cache (Claude 7's cache hunt). A guard over the source, not a fix: it holds on
 * main and fails the day it stops holding.
 *
 *   - No Next.js data cache anywhere in app/ or lib/: no "use cache", unstable_cache, `export const revalidate`,
 *     `dynamic = "force-static"`, fetch with `cache: "force-cache"` or `next: { revalidate }`. Pages and route
 *     handlers read the store, the session and the checkout's price and stock afresh on every request (the store
 *     pages' React cache() is per request only); one of these would keep a page, a store's data or a price across
 *     requests and viewers.
 *   - A Cache-Control a CDN may keep (public with max-age, s-maxage or immutable) is written only by the files below,
 *     each read for what it serves. Any other file that starts writing one fails here and is read first.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// The compiled test runs from a temporary folder; the runner starts it from the repository's root.
const root = process.cwd();
assert.ok(statSync(join(root, "app")).isDirectory() && statSync(join(root, "lib")).isDirectory(), "run from the repository's root");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}
const files = [...sources("app"), ...sources("lib")].map((path) => ({ path: relative(root, join(root, path)), text: readFileSync(join(root, path), "utf8") }));

/**
 * The files that may write a Cache-Control a CDN keeps, and why each is safe to share. Read before adding one.
 */
const SHARED_CACHE_FILES: Record<string, string> = {
  "app/api/image/[folder]/[file]/route.ts": "public pictures, content-addressed",
  "app/api/photo/[id]/route.ts": "public pictures, content-addressed",
  "lib/picture-pace.ts": "redirect to a content-addressed picture",
  "lib/picture-r2.ts": "stored pictures, content-addressed",
  "app/api/store/community/chat/new/route.ts": "a few seconds, keyed by the community and its HMAC pass, no cookie read",
  "app/api/store/podcast/feed/[token]/route.ts": "one buyer's feed under its secret token, FEED_SHARED_SECONDS by design; each episode is authorized again",
  "app/l/[code]/route.ts": "a short link's redirect, keyed by its code",
  "app/llms.txt/route.ts": "public site text",
  "app/[handle]/store-sitemap/route.ts": "a store's public sitemap",
  "app/[handle]/store-robots/route.ts": "a store's public robots.txt",
  "app/[handle]/blog/feed.xml/route.ts": "a store's public blog feed",
  "app/[handle]/app-icon/[size]/route.tsx": "a store's public icon",
  "app/[handle]/manifest.webmanifest/route.ts": "a store's public app manifest",
  "app/[handle]/certificate/[id]/pdf/route.ts": "only the public sample; drafts are private, no-store",
};

const DATA_CACHE = [
  /^\s*["']use cache["']/m,
  /\bunstable_cache\b/,
  /\bexport\s+const\s+revalidate\s*=/,
  /\bdynamic\s*=\s*["']force-static["']/,
  /\bcache\s*:\s*["']force-cache["']/,
  /\bnext\s*:\s*\{[^}]*\brevalidate\b/,
];
const SHARED_HEADER = /\bpublic\s*,\s*(?:max-age|s-maxage|immutable)|\bs-maxage\s*=/;

test("no Next.js data cache in app/ or lib/", () => {
  const found = files.flatMap(({ path, text }) => DATA_CACHE.filter((pattern) => pattern.test(text)).map((pattern) => `${path}: ${pattern}`));
  assert.deepEqual(found, []);
});

test("a Cache-Control a CDN keeps is written only by the files read for it", () => {
  const writing = files.filter(({ text }) => SHARED_HEADER.test(text)).map(({ path }) => path).sort();
  assert.deepEqual(writing.filter((path) => !(path in SHARED_CACHE_FILES)), [], "a new file writes a shared Cache-Control: read it, then list it");
  assert.deepEqual(Object.keys(SHARED_CACHE_FILES).filter((path) => !writing.includes(path)), [], "a listed file no longer writes one: take it off the list");
});
