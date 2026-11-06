/** Exact-snapshot, bounded review of #3012. No author file is changed. */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";
const root = process.cwd(), snapshot = process.argv[2] ?? "1ee4aa36d230268a395384c6fc66a21b74fbee3d";
const file = process.argv[3] ?? "cf2-move-pages.test.ts";
if (!/^[a-f0-9]{40}$/.test(snapshot)) throw Error("Exact snapshot required");
if (!["cf2-move-pages.test.ts", "feature-mechanisms.test.ts", "clickfunnels-import.test.ts", "t-3012-migration-guides.proof.ts"].includes(file)) throw Error("Unadmitted suite");
const out = mkdtempSync(join(tmpdir(), "t-3012-review-"));
const changed = new Set(["lib/migration-guides.ts", "lib/feature-pages.ts", "lib/feature-mechanisms.ts", "tests/cf2-move-pages.test.ts", "tests/feature-mechanisms.test.ts"]);
try {
  const bundle = join(out, "proof.cjs");
  await build({ entryPoints: [join(root, "tests", file)], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "error", alias: testAliases(file, root, join(root, "tests")),
    banner: { js: "globalThis.fetch=async()=>{throw new Error('Provider HTTP forbidden in review');};" },
    plugins: [{ name: "bounded-snapshot", setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, (args) => {
        const path = args.path.slice(root.length + 1);
        if (changed.has(path)) {
          const got = spawnSync("git", ["show", `${snapshot}:${path}`], { encoding: "utf8", maxBuffer: 1024 * 1024 });
          if (got.status !== 0) return { errors: [{ text: `Module absent in exact snapshot: ${path}` }] };
          return { contents: got.stdout, loader: "ts" };
        }
        if (path === "tests/check.ts") return { loader: "ts", contents: readFileSync(args.path, "utf8").replace("checks += 1;", "checks += 1; if(checks>60) throw new Error('Review case ceiling exceeded');") };
        if (path !== "tests/redis-stub.ts") return undefined;
        return { loader: "ts", contents: readFileSync(args.path, "utf8") + `
const reviewPipeline=store.pipeline.bind(store);let reviewCommands=0;
store.pipeline=(async(commands:(string|number)[][])=>{if(reviewCommands+commands.length>5000)throw Error("Review command ceiling exceeded before execution");reviewCommands+=commands.length;return reviewPipeline(commands);}) as typeof store.pipeline;
process.on("exit",()=>console.log("SYNTHETIC_COMMANDS="+reviewCommands));
` };
      });
    } }],
  });
  const run = spawnSync(process.execPath, [bundle], { cwd: root, env: testEnvironment(process.env), encoding: "utf8", timeout: 120_000, maxBuffer: 256 * 1024 });
  process.stdout.write(run.stdout ?? ""); process.stderr.write(run.stderr ?? "");
  if (run.error) throw run.error;
  console.log(`SNAPSHOT=${snapshot} FILE=${file} EXIT=${run.status}`); process.exitCode = run.status ?? 1;
} finally { rmSync(out, { recursive: true, force: true }); }
