/** Review #2900: canonical test aliases/environment; --before substitutes only page bytes in the bundle. */
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { testAliases, testEnvironment } from "../../tests/test-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const here = join(root, "tests");
const before = process.argv.includes("--before");
const target = join(root, "app/studio/page.tsx");
const originalBytes = readFileSync(target);
const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const sourceBlob = execFileSync("git", ["hash-object", target], { cwd: root, encoding: "utf8" }).trim();
const replacement = before ? execFileSync("git", ["show", "a4b34673bb8415a49ab77a633adad531449eac51:app/studio/page.tsx"], { cwd: root, maxBuffer: 1024 * 1024 }) : null;
const temporary = mkdtempSync("/dev/shm/m-2900-bundle-");
const started = Date.now();
const LOG_CAP = 128 * 1024;
const TIME_CAP_MS = 120_000;
let child;
try {
  const bundle = join(temporary, "proof.cjs");
  await build({
    entryPoints: [join(here, "m-2900-write-order.proof.ts")], bundle: true, platform: "node", format: "cjs", outfile: bundle,
    logLevel: "error", alias: testAliases("studio-today-trips.test.ts", root, here),
    plugins: replacement ? [{ name: "a4-page-only", setup(builder) {
      builder.onLoad({ filter: /[/\\]app[/\\]studio[/\\]page\.tsx$/ }, args => args.path === target ? { contents: replacement.toString("utf8"), loader: "tsx", resolveDir: dirname(target) } : undefined);
    } }] : [],
  });
  console.log("M_2900_MODE:" + JSON.stringify({ sourceHead, sourceBlob, page: before ? "before-a4-page-only" : "current" }));
  const remaining = TIME_CAP_MS - (Date.now() - started);
  if (remaining <= 0) throw new Error("Review wall-time cap reached during compilation");
  const status = await new Promise((resolveStatus, reject) => {
    child = spawn(process.execPath, [bundle], { cwd: root, env: testEnvironment(process.env), stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0;
    let limit;
    const timer = setTimeout(() => { limit = "wall-time"; child.kill("SIGKILL"); }, remaining);
    const forward = destination => chunk => {
      bytes += chunk.length;
      if (bytes > LOG_CAP) { limit = "log-size"; child.kill("SIGKILL"); return; }
      destination.write(chunk);
    };
    child.stdout.on("data", forward(process.stdout));
    child.stderr.on("data", forward(process.stderr));
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); if (limit) reject(new Error(`Review ${limit} cap reached`)); else resolveStatus(code ?? 1); });
  });
  process.exitCode = Number(status);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  rmSync(temporary, { recursive: true, force: true });
  if (!readFileSync(target).equals(originalBytes)) throw new Error("Source page bytes changed during the proof");
}
