/** Opt-in proof: source checkout stays byte-intact; no global alias changes. */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const evidence = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = resolve(process.argv[2] ?? evidence);
const require = createRequire(join(source, "package.json"));
const { build } = require("esbuild");
const { testAliases, testEnvironment } = await import(pathToFileURL(join(source, "tests/test-config.mjs")));
const out = mkdtempSync(join(tmpdir(), "t-own-page-"));
try {
  const file = "t-own-page-unknown.proof.ts";
  const bundle = join(out, "proof.cjs");
  await build({
    stdin: { contents: readFileSync(join(evidence, "tests", file), "utf8"), resolveDir: join(source, "tests"), sourcefile: file, loader: "ts" },
    bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "error",
    alias: { ...testAliases(file, source, join(source, "tests")), "next/headers": join(source, "tests/security/next-headers.ts") },
    plugins: [{ name: "explicit-next-navigation-boundary", setup(builder) {
      builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "next/navigation", namespace: "t-page-boundary" }));
      builder.onLoad({ filter: /.*/, namespace: "t-page-boundary" }, () => ({ contents: 'export function notFound(){throw new Error("SYNTHETIC_NOT_FOUND")} export function redirect(){throw new Error("SYNTHETIC_REDIRECT")} export function useRouter(){throw new Error("UNUSED_CLIENT_ROUTER")} export function usePathname(){return "/"} export function useSearchParams(){return new URLSearchParams()}', loader: "js" }));
    } }],
  });
  const run = spawnSync(process.execPath, [bundle], { cwd: source, stdio: "inherit", env: testEnvironment(process.env) });
  process.exitCode = run.status ?? 1;
} finally { rmSync(out, { recursive: true, force: true }); }
