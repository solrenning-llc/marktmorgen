/**
 * Every call the code makes to Vercel Blob is accounted for (MR external-cost audit, Claude 5, C4-20261106-2740-C56-162).
 *
 * The same idea as EMAIL_SITES (tests/plan-cost-registry.test.ts): a file that imports the Blob SDK, or lib/blob that
 * wraps it, is listed here with each operation it calls and what pays for it:
 *   - `line`: a cost line of tests/plan-cost-registry.ts that prices this operation, with every try the SDK may send;
 *   - `free`: the official source that says the operation costs nothing, with the date it was read;
 *   - `notInProduction`: a call that cannot run in production, with the exact code that closes it, checked here;
 *   - `open`: a cost no line prices yet, named by the audit item that will price it.
 * So no new Blob call can be added without a decision, and the open ones are written down, never taken as zero.
 * Closing an open one means pricing it in a line (or proving it free) and moving its entry here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { COST_LINES } from "./plan-cost-registry";

type Paid = { line: string } | { free: string } | { notInProduction: string } | { open: string };

/** Vercel Blob's pricing page, read on 6 November 2026 (Codex Z, channel 16h59): "Delete operations are free". */
const DELETE_IS_FREE = { free: "vercel.com/docs/vercel-blob/usage-and-pricing, 'Delete operations are free', read 6 November 2026" };
/** handleUploadPresigned signs the door's URL in our own function; it sends nothing to Blob by itself. */
const SIGNS_LOCALLY = { free: "@vercel/blob/client handleUploadPresigned signs locally; the token it needs is the issueSignedToken entry" };
/** The browser's PUT through a door to a studio picture: priced as a put with every try by picture-uploads / picture-thumbnails. */
const STUDIO_PICTURE_PUT = { line: "picture-uploads" };

/** issueSignedToken is a request to Blob with the SDK's tries, its price not on the pricing page (audit item 9): never zero. */
const TOKEN_OPEN = { open: "audit 9: issueSignedToken (/signed-token) priced nowhere; counted as an Advanced Operation with every try until a source says otherwise" };

export const BLOB_SITES: Record<string, Record<string, Paid>> = {
  // Studio pictures: the door, its checks and its attach (#2803 picture-uploads, #2801 picture-thumbnails).
  "app/api/store/image/upload/route.ts": { head: { line: "picture-uploads" }, issueSignedToken: TOKEN_OPEN, handleUploadPresigned: SIGNS_LOCALLY },
  "app/api/store/image/route.ts": { head: { line: "picture-uploads" }, del: DELETE_IS_FREE },
  "lib/uploaded-image.ts": { head: { line: "picture-uploads" }, get: { line: "picture-uploads" } },
  "lib/picture-door.ts": { head: { line: "picture-uploads" }, del: DELETE_IS_FREE },
  "components/product-image-editor.tsx": { uploadPresigned: STUDIO_PICTURE_PUT },
  "components/link-picture.tsx": { uploadPresigned: STUDIO_PICTURE_PUT },
  "components/page-editor.tsx": { uploadPresigned: STUDIO_PICTURE_PUT },
  "app/api/store/link-image/route.ts": { del: DELETE_IS_FREE },
  "app/api/store/links/route.ts": { del: DELETE_IS_FREE },
  "app/api/store/page/route.ts": { del: DELETE_IS_FREE },
  "app/api/store/site-page/route.ts": { del: DELETE_IS_FREE },
  // A page's pictures checked on every save (tests/page-picture-check-cost.test.ts on claude5/page-picture-check-cost).
  "lib/picture-check.ts": { head: { open: "audit 1: a page save checks its new pictures again on every save" }, get: { open: "audit 1: a page save checks its new pictures again on every save" } },

  // Pictures served to visitors and to link previews on a CDN miss.
  "app/api/image/[folder]/[file]/route.ts": { get: { open: "audit 4: a public picture read from Blob on a CDN miss, no store figure taken" } },
  "app/[handle]/p/[product]/opengraph-image.tsx": { get: { open: "audit 4: the link preview reads the product picture from Blob, no store figure taken" } },
  "app/api/store/ai/route.ts": { get: { open: "audit 10: the picture read for its alt text; the AI call is priced by line ai, the Blob read is not" } },
  "lib/picture-r2-copy.ts": { get: { open: "audit 10: the picture copy to R2 (off today) reads the picture from Blob" } },

  // Community pictures and students' files: storage is priced, the operations are not (audit 7).
  "app/api/store/community/upload/route.ts": { issueSignedToken: TOKEN_OPEN, handleUploadPresigned: SIGNS_LOCALLY },
  "components/community-composer.tsx": { uploadPresigned: { open: "audit 7: a community picture's put, every try" } },
  "lib/community-files.ts": { head: { open: "audit 7: a community picture's checks" }, get: { open: "audit 7: a community picture's checks" }, del: DELETE_IS_FREE },
  "app/api/store/community/image/route.ts": { get: { line: "public-requests" } },
  "app/api/store/course/task/upload/route.ts": { issueSignedToken: TOKEN_OPEN, handleUploadPresigned: SIGNS_LOCALLY },
  "components/lesson-task.tsx": { uploadPresigned: { open: "audit 7: a student's file put, every try" } },

  // A buyer's review photo and an email's picture: Blob puts no line prices (audit 2 and 8).
  "lib/review-photo.ts": { put: { open: "audit 2: a buyer's review photo put, every try, and its storage" }, del: DELETE_IS_FREE },
  "lib/mail-pictures.ts": { put: { open: "audit 8: an email's picture put, every try" } },

  // Files sold before the vault (R2), and the measure of what a store keeps (audit 5 and 6).
  "lib/file-store.ts": {
    head: { open: "audit 6: legacy sold files in Blob" },
    get: { open: "audit 6: legacy sold files in Blob, read whole; free-delivery prices R2 delivery only" },
    put: { open: "audit 6: legacy sold files in Blob" },
    issueSignedToken: TOKEN_OPEN,
    presignUrl: SIGNS_LOCALLY,
    list: { open: "audit 5: storageUsed lists stores/<folder> page by page, every try" },
    del: DELETE_IS_FREE,
  },
  "lib/serve-file.ts": { get: { open: "audit 6: legacy sold files in Blob, read whole" } },
  "app/api/store/file/download/route.ts": { get: { open: "audit 6: legacy sold files in Blob, read whole" } },
  "app/api/store/file/route.ts": {
    issueSignedToken: { notInProduction: 'process.env.VERCEL_ENV === "production") throw new Error("files_unavailable")' },
    handleUploadPresigned: SIGNS_LOCALLY,
  },
  // Its fallback to Blob goes through the door above, which production closes.
  "lib/sold-file-upload.ts": { uploadPresigned: { notInProduction: 'handleUploadUrl: "/api/store/file"' } },
  "lib/takedown.ts": { del: DELETE_IS_FREE },
  "lib/demo-seed.ts": { put: { open: "audit 10: the demo store's seed pictures, a company cost not in the fixed costs" }, del: DELETE_IS_FREE },
};

const root = process.cwd();
const BLOB_IMPORT = /import\s+(?:\*\s+as\s+(\w+)|\{([^}]*)\})\s+from\s+"(@\/lib\/blob|@vercel\/blob(?:\/client)?)"/g;
const NOT_CALLS = new Set(["BlobNotFoundError", "HandleUploadPresignedBody", "type"]);

function codeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...codeFiles(path));
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(relative(root, path));
  }
  return out;
}

/** What one file calls from Blob: the names it imports, or for a namespace import the `ns.name(` it uses; undefined when it does not import Blob. */
export function blobCallsIn(file: string, source: string): Set<string> | undefined {
  let ops: Set<string> | undefined;
  for (const m of source.matchAll(BLOB_IMPORT)) {
    ops ??= new Set<string>();
    if (m[1] && m[3] === "@/lib/blob") for (const use of source.matchAll(new RegExp(`\\b${m[1]}\\.(\\w+)\\(`, "g"))) ops.add(use[1]);
    else if (m[1]) ops.add("*");
    for (const part of (m[2] ?? "").split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name && !NOT_CALLS.has(name) && !part.trim().startsWith("type ")) ops.add(name);
    }
  }
  return ops;
}

function blobCalls(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  // lib/blob.ts is the wrapper itself: what it is asked to do is listed at each of its callers.
  for (const file of ["app", "lib", "components", "scripts"].flatMap((dir) => codeFiles(join(root, dir))).filter((f) => f !== "lib/blob.ts")) {
    const ops = blobCallsIn(file, readFileSync(join(root, file), "utf8"));
    if (ops) found.set(file, ops);
  }
  return found;
}

test("every file that calls Blob is listed, with exactly the operations it calls", () => {
  const found = blobCalls();
  const unlisted = [...found.keys()].filter((file) => !Object.hasOwn(BLOB_SITES, file));
  assert.deepEqual(unlisted, [], "add each file that calls Blob to BLOB_SITES, with what pays for each operation");
  for (const [file, ops] of Object.entries(BLOB_SITES)) {
    assert.ok(found.has(file), `${file} no longer calls Blob: remove it from BLOB_SITES`);
    assert.deepEqual([...found.get(file)!].sort(), Object.keys(ops).sort(), `${file}: the operations it calls`);
  }
});

test("an import of Blob is seen in either quote style and through a relative path (L1 of the Claude 4 team on #2837)", () => {
  const seen = (file: string, source: string) => [...(blobCallsIn(file, source) ?? [])].sort();
  // The cases the review proved blind, each a put the guard must see.
  assert.deepEqual(seen("lib/takedown.ts", `import { put } from "./blob";\nput("a", "b");`), ["put"], "a relative ./blob from lib/");
  assert.deepEqual(seen("lib/takedown.ts", `import { put } from '@/lib/blob';\nput("a", "b");`), ["put"], "@/lib/blob in single quotes");
  assert.deepEqual(seen("lib/mail/x.ts", `import { head as h } from "../blob";`), ["head"], "../blob from a folder of lib/");
  assert.deepEqual(seen("app/api/x/route.ts", `import { del } from '../../../lib/blob';`), ["del"], "a relative path up to lib/blob");
  assert.deepEqual(seen("lib/x.ts", `import * as blob from './blob';\nblob.list({});`), ["list"], "a namespace import through ./blob");
  assert.deepEqual(seen("lib/x.ts", `import { upload } from '@vercel/blob/client';`), ["upload"], "the SDK in single quotes");
  assert.deepEqual(seen("lib/x.ts", `import {\n  put,\n  type PutBlobResult,\n} from "@vercel/blob";`), ["put"], "a multi-line import, its type left out");
  // Forms whose names the guard cannot read are never read as "calls nothing" (rule 24): they show as "*", so the file must be listed.
  assert.deepEqual(seen("lib/x.ts", `const { put } = await import("./blob");`), ["*"], "a dynamic import");
  assert.deepEqual(seen("lib/x.ts", `export { put } from '@/lib/blob';`), ["*"], "a re-export");
  assert.deepEqual(seen("lib/x.ts", `export * from "@vercel/blob";`), ["*"], "a re-export of everything");
  // What is not Blob stays out.
  assert.equal(blobCallsIn("lib/x.ts", `import { a } from "./blob-cache";\nimport { b } from '@/lib/blobs';`), undefined, "a module whose name only starts with blob");
  assert.equal(blobCallsIn("components/x.tsx", `import { c } from "./blob";`), undefined, "./blob outside lib/ is another module");
  assert.equal(blobCallsIn("lib/x.ts", `import type { PutBlobResult } from "@vercel/blob";`), undefined, "a type-only import calls nothing");
  assert.equal(blobCallsIn("lib/x.ts", `// we used to import { put } from "@/lib/blob" here`), undefined, "an import named in a comment");
});

test("each priced operation names a line that exists, and each closed one shows its closing code", () => {
  const ids = new Set(COST_LINES.map((line) => line.id));
  for (const [file, ops] of Object.entries(BLOB_SITES)) {
    for (const [op, paid] of Object.entries(ops)) {
      if ("line" in paid) assert.ok(ids.has(paid.line), `${file} ${op}: no line ${paid.line}`);
      if ("free" in paid) assert.ok(op === "del" || op === "handleUploadPresigned" || op === "presignUrl", `${file} ${op}: only a delete or a local signing is free`);
      if ("notInProduction" in paid) assert.ok(readFileSync(join(root, file), "utf8").includes(paid.notInProduction), `${file} ${op}: its closing code is gone`);
    }
  }
});

test("the open Blob costs are exactly the ones the audit names, so none is added or forgotten in silence", () => {
  const open = Object.entries(BLOB_SITES).flatMap(([file, ops]) => Object.entries(ops).filter(([, paid]) => "open" in paid).map(([op, paid]) => `${(paid as { open: string }).open.split(":")[0]} ${file} ${op}`));
  console.log(`open Blob costs (${open.length}):\n  ${open.sort().join("\n  ")}`);
  // Rule 23: this list only shrinks, as each audit unit prices its operations; a new entry needs Claude 4's decision.
  assert.equal(open.length, 23);
});
