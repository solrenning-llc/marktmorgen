/** Load immutable Git sources virtually; no product checkout or bundle file. */
import { build } from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const source = "5c07315505e1d53ee6401021601cd688fa98ecda";
const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
const read = path => git(["show", `${source}:${path}`]);
const names = new Set(git(["ls-tree", "-r", "--name-only", source]).trim().split("\n"));
const own = new Set(["tests/q-store-api-e-h-upload.proof.ts", "tests/q-store-api-e-h-upload-world.ts"]);
const { testAliases, testEnvironment } = await import(`data:text/javascript;base64,${Buffer.from(read("tests/test-config.mjs")).toString("base64")}`);
const aliases = testAliases("upload-budget-routes.test.ts", root, join(root, "tests"));
aliases["@/lib/studio-route"] = join(root, "tests/q-store-api-e-h-upload-world.ts");
const aliasKeys = Object.keys(aliases).sort((a, b) => b.length - a.length);
const plugin = { name: "frozen-git-source", setup(ctx) {
  ctx.onResolve({ filter: /.*/ }, async args => {
    if (args.pluginData?.defaultResolution) return;
    let path = args.path;
    const alias = aliasKeys.find(key => path === key || path.startsWith(key + "/"));
    if (alias) path = aliases[alias] + path.slice(alias.length);
    else if (path.startsWith(".") && args.namespace === "frozen") path = resolve(root, dirname(args.importer), path);
    if (path.startsWith(root + sep)) {
      const candidate = relative(root, path).split(sep).join("/");
      const exact = [candidate, ...[".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"].map(suffix => candidate + suffix)].find(name => own.has(name) || names.has(name));
      if (!exact) throw new Error(`Frozen source does not contain ${candidate}`);
      return { path: exact, namespace: "frozen" };
    }
    return ctx.resolve(path, { resolveDir: root, kind: args.kind, pluginData: { defaultResolution: true } });
  });
  ctx.onLoad({ filter: /.*/, namespace: "frozen" }, args => ({ contents: own.has(args.path) ? readFileSync(join(root, args.path), "utf8") : read(args.path), loader: ({ ".tsx": "tsx", ".ts": "ts", ".json": "json" })[extname(args.path)] ?? "js", resolveDir: root }));
} };
const bundle = await build({ entryPoints: [join(root, "tests/q-store-api-e-h-upload.proof.ts")], bundle: true, write: false, platform: "node", format: "cjs", logLevel: "error", plugins: [plugin], tsconfigRaw: { compilerOptions: { target: "ES2022", jsx: "react-jsx", jsxImportSource: "@/lib/content-jsx" } } });
const run = spawnSync(process.execPath, ["-"], { cwd: root, input: bundle.outputFiles[0].text, encoding: "utf8", timeout: 120000, maxBuffer: 128 * 1024, env: testEnvironment(process.env) });
const logBytes = Buffer.byteLength(run.stdout ?? "") + Buffer.byteLength(run.stderr ?? "");
if (logBytes > 256 * 1024) throw new Error("Combined output exceeds the reserved log budget");
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");
if (run.error) { console.error(run.error.message); process.exitCode = 2; }
else process.exitCode = run.status ?? 2;
