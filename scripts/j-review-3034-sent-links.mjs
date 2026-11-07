/** Local review only: no source rewrite, no provider, no CI. */
import { build } from "esbuild";
import { resolve, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";

const root = resolve(import.meta.dirname, ".."), here = join(root, "tests");
const author = process.argv.includes("--author");
const out = mkdtempSync(join(tmpdir(), "j-review-3034-"));
const world = join(here, "j-review-3034-sent-links-world.ts");
const blocked = `
const net = require('node:net');
net.Socket.prototype.connect = function() { throw new Error('REVIEW_SOCKET_BLOCKED'); };
for (const protocol of ['node:http', 'node:https']) {
  const mod = require(protocol);
  mod.request = mod.get = function() { throw new Error('REVIEW_HTTP_BLOCKED'); };
}
globalThis.fetch = async function() { throw new Error('REVIEW_FETCH_BLOCKED'); };
`;
const aliases = testAliases("f2-sent-links.test.ts", root, here);
if (!author) {
  aliases["@/lib/store-request"] = world;
  aliases["@/lib/broadcasts"] = world;
  aliases["@/lib/store"] = world;
}
const bundle = join(out, "sent-links.cjs");
await build({ entryPoints: [join(here, author ? "f2-sent-links.test.ts" : "j-review-3034-sent-links.proof.ts")], bundle: true, platform: "node", format: "cjs", outfile: bundle, alias: aliases, banner: { js: blocked }, logLevel: "error" });
const result = spawnSync(process.execPath, author ? [bundle] : ["--test", "--test-concurrency=1", bundle], { cwd: root, env: testEnvironment(process.env), encoding: "utf8", timeout: 120_000, maxBuffer: 262_144 });
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
