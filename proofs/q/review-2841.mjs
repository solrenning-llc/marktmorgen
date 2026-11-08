/** Run with: TMPDIR=/dev/shm node proofs/q/review-2841.mjs [canonical-test.test.ts ...] */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testAliases, testEnvironment } from "../../tests/test-config.mjs";
const root = resolve(import.meta.dirname, "../.."), here = join(root, "tests");
const files = process.argv.slice(2); if (!files.length) files.push("q-2841-empty.proof.ts");
let failed = 0;
for (const file of files) {
  const dir = mkdtempSync(join(tmpdir(), "q2841-")), bundle = join(dir, "proof.cjs");
  try {
    const alias = testAliases(file, root, here);
    const plugins = [];
    if (file === "q-2841-empty.proof.ts") {
      const world = join(here, file);
      const mocks = new Set([...["catalog", "studio-route", "reviews", "review-ai-summary", "customer-voice", "buyer-orders", "purchase-email", "ai", "mail", "store-blog"].map(x => "@/lib/" + x), ...["studio-header", "studio-store-pin", "ai-assist", "review-studio", "review-qr", "review-themes", "review-ai-summaries", "blog-editor"].map(x => "@/components/" + x), "next/headers", "next/navigation"]);
      plugins.push({ name: "explicit-page-boundaries", setup(builder) { builder.onResolve({ filter: /.*/ }, args => /app\/studio\/(blog|reviews)\/page\.tsx$/.test(args.importer) && mocks.has(args.path) ? { path: world } : undefined); } });
    }
    await build({ entryPoints: [join(here, file)], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "error", alias, plugins });
    const args = process.env.Q2841_NAME_PATTERN ? ["--test-name-pattern", process.env.Q2841_NAME_PATTERN, bundle] : [bundle];
    const result = spawnSync(process.execPath, args, { cwd: root, env: testEnvironment(process.env), encoding: "utf8" });
    console.log(`=== ${file} (exit ${result.status}) ===\n${result.stdout}`); if (result.stderr) console.error(result.stderr); if (result.status !== 0) failed++;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
process.exitCode = failed ? 1 : 0;
