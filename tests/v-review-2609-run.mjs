import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? ".");
const files = process.argv.slice(3);
if (!files.length) files.push("v-review-2609-checkout-controls.test.ts");
const { testAliases, testEnvironment } = await import(pathToFileURL(join(root, "tests/test-config.mjs")).href);
let failed = false;
for (const file of files) {
  const bundle = join(root, "tests", file + ".cjs");
  const result = await build({ entryPoints: [join(root, "tests", file)], bundle: true, platform: "node", format: "cjs", outfile: bundle, write: false, logLevel: "error", alias: testAliases(file, root, join(root, "tests")) });
  const child = spawnSync(process.execPath, ["-e", "const fs=require('node:fs'),Module=require('node:module'),path=require('node:path');const file=process.env.V_REVIEW_BUNDLE;const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(0,'utf8'),file);"], { input: result.outputFiles[0].contents, stdio: ["pipe", "inherit", "inherit"], env: { ...testEnvironment(process.env), V_REVIEW_BUNDLE: bundle } });
  if (child.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
