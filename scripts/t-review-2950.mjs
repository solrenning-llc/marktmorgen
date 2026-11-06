/** Independent, bounded synthetic review of #2950. No author files are edited. */
import { build } from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";

const root = process.cwd();
const snapshot = process.argv[2] ?? "91a0494521ca7c3e42f24674d8bfa67cee44dacf";
const file = process.argv[3] ?? "program-numbers-unknown.test.ts";
if (!/^[a-f0-9]{40}$/.test(snapshot)) throw Error("An exact snapshot is required");
if (!["program-numbers-unknown.test.ts", "affiliate-directory.test.ts", "t-2950-program-numbers.proof.ts"].includes(file)) throw Error("Unadmitted test file");
const out = mkdtempSync(join(tmpdir(), "t-2950-review-"));
const source = (path) => execFileSync("git", ["show", `${snapshot}:${path}`], { encoding: "utf8", maxBuffer: 1024 * 1024 });
try {
  const bundle = join(out, "test.cjs");
  await build({
    entryPoints: [join(root, "tests", file)], bundle: true, platform: "node", format: "cjs", outfile: bundle,
    alias: testAliases(file, root, join(root, "tests")), logLevel: "error",
    plugins: [{ name: "bounded-exact-snapshot", setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, (args) => {
        const path = args.path.slice(root.length + 1);
        if (path === "lib/affiliates.ts") return { contents: source(path), loader: "ts" };
        if (path === "tests/program-numbers-unknown.test.ts") return { contents: source(path), loader: "ts" };
        if (path !== "tests/redis-stub.ts") return undefined;
        return { loader: "ts", contents: readFileSync(args.path, "utf8") + `
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
  rmSync(out, { recursive: true, force: true });
}
