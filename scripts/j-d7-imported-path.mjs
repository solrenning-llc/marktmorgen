import { build } from "esbuild";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const SOURCE = "2bfa8ade8f59555b8d57aa03e554a99092a1285b";
const root = process.cwd(), here = join(root, "tests"), require = createRequire(import.meta.url);
const undici = require.resolve("undici"), blobUndici = createRequire(require.resolve("@vercel/blob")).resolve("undici");
if (undici !== blobUndici) throw new Error("The Blob SDK dispatcher differs; do not run without a verified guard");
const out = mkdtempSync(join(tmpdir(), "j-d7-imported-path-"));
try {
  const bundle = join(out, "proof.cjs");
  // Installed before evaluating ANY application module, including SDKs that ignore global fetch.
  const guard = `const __jD7Network=globalThis.__jD7Network={dispatcherAttempts:0,socketAttempts:0,unexpectedFetch:0};
require('node:net').Socket.prototype.connect=function(){__jD7Network.socketAttempts++;throw new Error('D7 proof forbids network sockets');};
const __jD7Undici=require(${JSON.stringify(undici)}),__jD7Agent=new __jD7Undici.MockAgent();__jD7Agent.disableNetConnect();
const __jD7Dispatch=__jD7Agent.dispatch.bind(__jD7Agent);__jD7Agent.dispatch=(...args)=>{__jD7Network.dispatcherAttempts++;return __jD7Dispatch(...args);};__jD7Undici.setGlobalDispatcher(__jD7Agent);
globalThis.fetch=async()=>{__jD7Network.unexpectedFetch++;throw new Error('D7 blocks startup HTTP');};`;
  const result = await build({ entryPoints: [join(here, "j-d7-imported-path.proof.ts")], bundle: true, metafile: true,
    platform: "node", format: "cjs", outfile: bundle, logLevel: "error", banner: { js: guard },
    alias: testAliases("clickfunnels-import.test.ts", root, here) });
  const tree = new Map(execFileSync("git", ["ls-tree", "-r", "-z", SOURCE], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).map(line => {
    const [header, path] = line.split("\t"); return [path, header.split(" ")[2]];
  }));
  const paths = new Set(["tests/test-config.mjs", "tsconfig.json", ...Object.keys(result.metafile.inputs).map(path => relative(root, resolve(root, path))).filter(path => !path.startsWith("..") && tree.has(path))]);
  for (const path of paths) {
    const bytes = readFileSync(join(root, path));
    const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (hash !== tree.get(path)) throw new Error(`Frozen source differs: ${path}`);
  }
  console.log(JSON.stringify({ frozenSource: SOURCE, verifiedTrackedInputs: paths.size, canonicalAliases: "clickfunnels-import.test.ts", sdkDispatcherMatchesInstalledUndici: true }));
  const env = testEnvironment(process.env);
  for (const key of Object.keys(env)) if (/^(AWS_|SES_|RESEND_|STRIPE_|PAYPAL_|BLOB_|R2_|S3_)/.test(key)) delete env[key];
  env.NIMBUS_DATA_KEY = "tests-only-not-a-real-deployment-secret";
  const child = spawnSync(process.execPath, [bundle], { stdio: "inherit", env, timeout: 120000 });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} finally { rmSync(out, { recursive: true, force: true }); }
