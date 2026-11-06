import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { testAliases, testEnvironment } from "../../tests/test-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const before = process.argv.includes("--before");
const linked = process.argv.includes("--linked");
const author = process.argv.includes("--author");
const after = process.argv.find((arg) => arg.startsWith("--after="))?.slice("--after=".length);
if (linked && (before || author)) throw Error("Run linked tests separately from frozen page comparisons");
const source = before ? execFileSync("git", ["show", "c2e7c793f39f7e9bd6670054fa4977cf42f40f26:app/studio/page.tsx"], { cwd: root, encoding: "utf8" }) : null;
const temp = mkdtempSync(join(tmpdir(), "codex-m-2835-"));
try {
 const files = linked ? readdirSync(join(root, "tests")).sort().filter((file) => file.endsWith(".test.ts") && (!after || file > after) && readFileSync(join(root, "tests", file), "utf8").includes("app/studio/page")) : [author ? "studio-today-trips.test.ts" : "m-2835-read-order.proof.ts"];
 let failed = 0;
 for (const file of files) {
  console.log("GROUP:" + file);
  const out = join(temp, file + ".cjs");
  await build({
    entryPoints: [join(root, "tests", file)],
    bundle: true, platform: "node", format: "cjs", outfile: out,
    alias: testAliases(file === "m-2835-read-order.proof.ts" ? "studio-today-trips.test.ts" : file, root, join(root, "tests")),
    plugins: source === null ? [] : [{ name: "before-page-only", setup(builder) {
      builder.onLoad({ filter: /app\/studio\/page\.tsx$/ }, () => ({ contents: source, loader: "tsx", resolveDir: join(root, "app/studio") }));
    } }],
    logLevel: "error",
  });
  const run = spawnSync(process.execPath, [out], { cwd: root, env: testEnvironment(process.env), encoding: "utf8", timeout: linked ? 60000 : 30000, maxBuffer: 10_000_000 });
  rmSync(out);
  if (!linked || run.status !== 0) { process.stdout.write(run.stdout ?? ""); process.stderr.write(run.stderr ?? ""); }
  else {
    const custom = /(\d+) checks, all passing/.exec(run.stdout);
    const native = /(?:ℹ tests|# tests) (\d+)/.exec(run.stdout);
    console.log(JSON.stringify({ file, status: run.status, checks: custom ? Number(custom[1]) : null, nodeTests: native ? Number(native[1]) : null }));
  }
  if (run.error) throw run.error;
  if (run.status !== 0) failed += 1;
 }
 console.log(JSON.stringify({ groups: files.length, failed }));
 process.exitCode = failed ? 1 : 0;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
