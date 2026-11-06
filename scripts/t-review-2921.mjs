/** PR #2921: bounded synthetic review; never edits the author's files. */
import { build } from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";

const root = process.cwd();
const snapshot = process.argv[2] ?? "07e820ed0368a1bfb611b99508fe25110fcddd54";
const file = process.argv[3] ?? "t-2921-directory.proof.ts";
if (!/^[a-f0-9]{40}$/.test(snapshot)) throw new Error("An exact snapshot is required");
if (!["t-2921-directory.proof.ts", "directory-index-unknown.test.ts", "directory-index.test.ts"].includes(file)) throw new Error("Only the bounded review suites may run");
const output = mkdtempSync(join(tmpdir(), "t-2921-review-"));
const snapshots = new Set(["lib/directory-index.ts", "lib/affiliate-directory.ts"]);
const nodeSource = (path) => execFileSync("git", ["show", `${snapshot}:${path}`], { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 });
try {
  const bundle = join(output, "review.cjs");
  await build({
    entryPoints: [join(root, "tests", file)], bundle: true, platform: "node", format: "cjs", outfile: bundle,
    alias: testAliases(file, root, join(root, "tests")), logLevel: "error",
    plugins: [{ name: "bounded-review-snapshot", setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, (args) => {
        const path = args.path.slice(root.length + 1);
        if (snapshots.has(path)) return { contents: nodeSource(path), loader: "ts" };
        if (path !== "tests/redis-stub.ts") return undefined;
        const source = readFileSync(args.path, "utf8");
        return { loader: "ts", contents: source + `
const reviewPipeline = store.pipeline.bind(store);
let reviewCommands = 0;
store.pipeline = (async (commands: (string|number)[][]) => {
  if (reviewCommands + commands.length > 5000) throw new Error("Review command ceiling exceeded before execution");
  reviewCommands += commands.length;
  return reviewPipeline(commands);
}) as typeof store.pipeline;
process.on("exit", () => console.log("SYNTHETIC_COMMANDS=" + reviewCommands));
` };
      });
    } }],
  });
  const run = spawnSync(process.execPath, [bundle], { cwd: root, env: testEnvironment(process.env), encoding: "utf8", timeout: 120_000, maxBuffer: 128 * 1024 });
  process.stdout.write(run.stdout ?? "");
  process.stderr.write(run.stderr ?? "");
  if (run.error) throw run.error;
  console.log(`SNAPSHOT=${snapshot} FILE=${file} EXIT=${run.status}`);
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(output, { recursive: true, force: true });
}
