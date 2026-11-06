/** Opt-in synthetic evidence; node proofs/t/blog-readers.mjs [source checkout]. */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const evidence = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = resolve(process.argv[2] ?? evidence);
const here = join(source, "tests");
const { testAliases, testEnvironment } = await import(pathToFileURL(join(here, "test-config.mjs")));
const out = mkdtempSync(join(tmpdir(), "t-blog-evidence-"));
let failed = 0;
try {
  for (const name of ["t-store-blog-count-unknown.proof.ts", "t-store-blog-reader-unknown.proof.ts"]) {
    const bundle = join(out, `${name}.cjs`);
    await build({ stdin: { contents: readFileSync(join(evidence, "tests", name), "utf8"), resolveDir: here, sourcefile: name, loader: "ts" }, bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "error", alias: testAliases(name, source, here) });
    console.log(`FILE ${name}; SOURCE ${source}`);
    const result = spawnSync(process.execPath, [bundle], { cwd: source, env: testEnvironment(process.env), stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) failed += 1;
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
