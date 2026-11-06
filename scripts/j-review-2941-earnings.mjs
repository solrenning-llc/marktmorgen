/**
 * PROPOSED / NOT EXECUTED runner. No product source is evaluated by publication.
 * It reads exact Git blobs and compiles write:false in the normal executor.
 */
import { build } from "esbuild";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
const root = process.cwd(), require = createRequire(import.meta.url);
const FINAL = "fd4cd750131b226dbac078923f6cb345a03d1936";
const RED = "859882b0c1bad7de2616cc6167eb5588a64fabc0";
const mode = process.argv[2] ?? "proof", snapshot = mode === "red" ? RED : FINAL;
const read = path => execFileSync("git", ["show", snapshot + ":" + path], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function verified(path) {
  const contents = read(path);
  const sha = createHash("sha1").update("blob " + Buffer.byteLength(contents) + "\0").update(contents).digest("hex");
  const expected = execFileSync("git", ["rev-parse", snapshot + ":" + path], { cwd: root, encoding: "utf8" }).trim();
  if (sha !== expected) throw new Error("Snapshot blob differs: " + path);
  console.log("EXACT_BLOB", path, sha);
  return contents;
}
const author = mode === "author" || mode === "red";
const plugin = { name: "exact-snapshot", setup(b) {
  b.onResolve({ filter: /^@\/lib\/earnings-by-month$/ }, () => ({ path: "lib/earnings-by-month.ts", namespace: "snapshot" }));
  b.onResolve({ filter: /^\.\/check$/, namespace: "snapshot" }, () => ({ path: "tests/check.ts", namespace: "snapshot" }));
  b.onResolve({ filter: /^snapshot:/ }, args => ({ path: args.path.slice(9), namespace: "snapshot" }));
  b.onLoad({ filter: /.*/, namespace: "snapshot" }, args => ({ contents: verified(args.path), loader: "ts", resolveDir: root }));
} };
console.log(JSON.stringify({ snapshot, mode, write: false, noCheckout: true, statusBeforeExecution: "PROPOSED_NOT_EXECUTED" }));
const entry = author ? "snapshot:tests/bx2-earnings.test.ts" : join(root, "tests/j-2941-earnings.proof.ts");
const result = await build({ entryPoints: [entry], plugins: [plugin], bundle: true, platform: "node", format: "cjs", write: false, logLevel: "error" });
const undici = require.resolve("undici");
if (createRequire(require.resolve("@vercel/blob")).resolve("undici") !== undici) throw new Error("SDK dispatcher mismatch");
const guard = "const assert=require('node:assert/strict'),net=require('node:net');let sockets=0;net.Socket.prototype.connect=function(){sockets++;throw new Error('J2941 refuses sockets');};"
+ "const u=require(" + JSON.stringify(undici) + "),a=new u.MockAgent();a.disableNetConnect();u.setGlobalDispatcher(a);globalThis.fetch=async()=>{throw new Error('J2941 refuses HTTP');};"
+ "(async()=>{assert.throws(()=>new net.Socket().connect(443,'unregistered.invalid'),/refuses sockets/);await assert.rejects(()=>u.fetch('https://unregistered.invalid/'),e=>e?.cause?.code==='UND_MOCK_ERR_MOCK_NOT_MATCHED');assert.equal(sockets,1);console.log('NETWORK GUARDS PASS before pure graph');new Function('require','module','exports',process.argv[1])(require,module,exports);})().catch(e=>{console.error(e);process.exitCode=1;});";
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(AWS_|SES_|RESEND_|STRIPE_|PAYPAL_|BLOB_|R2_|S3_)/.test(key)) delete env[key];
const child = spawnSync(process.execPath, ["-e", guard, result.outputFiles[0].text], { cwd: root, env, encoding: "utf8", timeout: 120000 });
if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
