import { build } from "esbuild";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const SOURCE = "5c07315505e1d53ee6401021601cd688fa98ecda";
const root = process.cwd(), here = join(root, "tests"), require = createRequire(import.meta.url);
const undici = require.resolve("undici"), sdkUndici = createRequire(require.resolve("@vercel/blob")).resolve("undici");
if (undici !== sdkUndici) throw new Error("SDK dispatcher is not the guarded Undici instance; stop");
const out = mkdtempSync(join(tmpdir(), "j-client-fetch-"));
try {
  const bundle = join(out, "proof.cjs");
  const guard = `const __jClientNetwork=globalThis.__jClientNetwork={dispatcherAttempts:0,socketAttempts:0,unexpectedFetch:0};
require('node:net').Socket.prototype.connect=function(){__jClientNetwork.socketAttempts++;throw new Error('Client proof forbids network sockets');};
const __jClientUndici=require(${JSON.stringify(undici)}),__jClientAgent=new __jClientUndici.MockAgent();__jClientAgent.disableNetConnect();
const __jClientDispatch=__jClientAgent.dispatch.bind(__jClientAgent);__jClientAgent.dispatch=(...args)=>{__jClientNetwork.dispatcherAttempts++;return __jClientDispatch(...args);};__jClientUndici.setGlobalDispatcher(__jClientAgent);
globalThis.fetch=async()=>{__jClientNetwork.unexpectedFetch++;throw new Error('Client proof blocks startup HTTP');};`;
  const result = await build({ entryPoints: [join(here, "j-client-fetch.proof.tsx")], bundle: true, metafile: true,
    platform: "node", format: "cjs", outfile: bundle, logLevel: "error", banner: { js: guard },
    alias: testAliases("course-template-studio.test.ts", root, here) });
  const tree = new Map(execFileSync("git", ["ls-tree", "-r", "-z", SOURCE], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).map(line => {
    const [header, path] = line.split("\t"); return [path, header.split(" ")[2]];
  }));
  const paths = new Set(["tests/test-config.mjs", "tsconfig.json", ...Object.keys(result.metafile.inputs).map(path => relative(root, resolve(root, path))).filter(path => !path.startsWith("..") && tree.has(path))]);
  for (const path of paths) {
    const bytes = readFileSync(join(root, path));
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (sha !== tree.get(path)) throw new Error(`Frozen source differs: ${path}`);
  }
  console.log(JSON.stringify({ frozenSource: SOURCE, verifiedTrackedInputs: paths.size, canonicalAliases: "course-template-studio.test.ts", noProductAliasOrSourceTransform: true, SDKDispatcherGuarded: true }));
  const env = testEnvironment(process.env);
  for (const key of Object.keys(env)) if (/^(AWS_|SES_|RESEND_|STRIPE_|PAYPAL_|BLOB_|R2_|S3_)/.test(key)) delete env[key];
  env.NIMBUS_DATA_KEY = "tests-only-not-a-real-deployment-secret";
  const child = spawnSync(process.execPath, [bundle], { stdio: "inherit", env, timeout: 120000 });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 2;
} finally { rmSync(out, { recursive: true, force: true }); }
