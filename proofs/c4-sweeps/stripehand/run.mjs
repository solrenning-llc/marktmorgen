// usage: node run.mjs <proof.ts>  — bundles a proof against the read-only worktree at origin/main, with the tests' aliases.
import { build } from "/home/user/marktmorgen/node_modules/esbuild/lib/main.js";
import { spawnSync } from "node:child_process";
import { join, basename } from "node:path";
const root = "/home/user/marktmorgen/.claude/worktrees/sh", here = join(root, "tests");
const { testAliases, testEnvironment } = await import(join(here, "test-config.mjs"));
const file = process.argv[2];
const out = join(process.cwd(), "out", basename(file) + ".cjs");
await build({ entryPoints: [join(process.cwd(), file)], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "error", nodePaths: ["/home/user/marktmorgen/node_modules"], alias: testAliases(basename(file).replace(".proof.ts", ".test.ts"), root, here) });
const r = spawnSync(process.execPath, [out], { encoding: "utf8", env: testEnvironment(process.env), cwd: root });
process.stdout.write(r.stdout); if (r.status !== 0) process.stdout.write(r.stderr.slice(0, 3000));
process.exit(r.status ?? 1);
