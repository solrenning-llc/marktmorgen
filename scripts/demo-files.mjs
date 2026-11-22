// Writes lib/demo-file.ts: the demo store's sample PDFs, redrawn and tagged
// by lib/demo-file-build.ts from the ReportLab sources in
// lib/demo-file-source.ts (AX274 Part A, item 5). Run after changing either:
//   node scripts/demo-files.mjs
// tests/ax-pdf-demo-files.test.ts fails while lib/demo-file.ts is not exactly
// this output. It reads and writes only files in this repository.
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "demo-files-"));
try {
  const bundle = join(out, "build.cjs");
  await build({
    stdin: {
      contents: 'export { demoFileModule as demoFileSource } from "@/lib/demo-file-build";',
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    alias: { "@": root },
  });
  const { demoFileSource } = createRequire(import.meta.url)(bundle);
  writeFileSync(join(root, "lib", "demo-file.ts"), await demoFileSource());
  console.log("wrote lib/demo-file.ts");
} finally {
  rmSync(out, { recursive: true, force: true });
}
