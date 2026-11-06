/** Evidence runner: Git source is read-only; no checkout, generated bundle or external request is needed. */
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve, posix } from "node:path";
const root = resolve(import.meta.dirname, "../.."), snapshot = "5c07315505e1d53ee6401021601cd688fa98ecda";
const repo = process.env.Q_PAUSE_REPO ?? "/workspace/scratch/2ffb4e28e019/audit-main";
const dependencyRoot = process.env.Q_PAUSE_DEPENDENCIES ?? "/dev/shm/q-review-2724/node_modules";
const { build } = createRequire(resolve(dependencyRoot, "esbuild/package.json"))("esbuild");
const world = resolve(root, "tests/q-store-api-i-m-pause.proof.ts");
const tracked = new Set(execFileSync("git", ["-C", repo, "ls-tree", "--name-only", "-r", snapshot], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }).trim().split("\n"));
const routeMocks = new Set(["@/lib/store", "@/lib/metered-limits", "@/lib/membership-manage", "@/lib/request-guard", "@/lib/request-origin", "@/lib/leave-flow"]);
const helperMocks = new Set(["@/lib/membership-manage", "@/lib/membership-access", "@/lib/catalog", "@/lib/email", "@/lib/purchase-email", "@/lib/buyer-words"]);
const locate = path => [path, path + ".ts", path + ".tsx", path + "/index.ts"].find(candidate => tracked.has(candidate));
const result = await build({ entryPoints: [world], bundle: true, platform: "node", format: "cjs", write: false, logLevel: "error", plugins: [{
  name: "read-only-git-snapshot-and-explicit-boundaries", setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      if ((args.importer === "app/api/store/manage/pause/route.ts" && routeMocks.has(args.path)) || (args.importer === "lib/membership-pause.ts" && helperMocks.has(args.path))) return { path: world };
      let path;
      if (args.path.startsWith("@/")) path = args.path.slice(2);
      else if (args.path.startsWith(".") && args.namespace === "snapshot") path = posix.normalize(posix.join(posix.dirname(args.importer), args.path));
      else if (args.path.startsWith(".") && args.importer === world) path = posix.normalize(posix.join("tests", args.path));
      if (path) { const found = locate(path); if (!found) throw new Error(`Missing frozen source: ${path}`); return { path: found, namespace: "snapshot" }; }
    });
    builder.onLoad({ filter: /.*/, namespace: "snapshot" }, args => ({ contents: execFileSync("git", ["-C", repo, "show", `${snapshot}:${args.path}`], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }), loader: args.path.endsWith(".tsx") ? "tsx" : "ts" }));
  },
}] });
const execution = spawnSync(process.execPath, ["--input-type=commonjs", "--test-concurrency=1"], {
  input: result.outputFiles[0].text, cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 256 * 1024,
  env: { ...process.env, STRIPE_SECRET_KEY: "sk_test_q_pause_synthetic_only", STRIPE_CONNECT_API_BASE: "", STRIPE_DEMO_ACCOUNT_ID: "acct_fixtureDemo" },
});
console.log(execution.stdout); if (execution.stderr) console.error(execution.stderr);
if (execution.error) console.error(execution.error.message);
process.exitCode = execution.status ?? 1;
