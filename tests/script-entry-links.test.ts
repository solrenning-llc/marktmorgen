/**
 * tests/client-bundles.mjs and tooling/screen-reader/setup-owned-reader.mjs run
 * when node was asked to run them, also through a link, and never on an import.
 * Before this they compared argv[1] to the file URL without real paths, so run
 * through a symlink they did nothing and exited 0 (an empty success).
 * Synthetic: temporary links, no network; the reader setup stops at its own
 * environment check before running anything.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { done, is, part } from "./check";

const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
const node = (args: string[]) => {
  const run = spawnSync(process.execPath, args, { encoding: "utf8", env: env as NodeJS.ProcessEnv, cwd: process.cwd() });
  return { status: run.status, out: run.stdout, err: run.stderr };
};
const bundles = join(process.cwd(), "tests", "client-bundles.mjs");
const reader = join(process.cwd(), "tooling", "screen-reader", "setup-owned-reader.mjs");

const dir = mkdtempSync(join(tmpdir(), "entry-links-"));
try {
  part("client bundles check");
  const real = node([bundles]);
  is("real path prints the result (control)", real.out.includes('"failed"'), true);
  const bundlesLink = join(dir, "bundles-link.mjs");
  symlinkSync(bundles, bundlesLink);
  const linked = node([bundlesLink]);
  is("through a link prints the same result", linked.out.includes('"failed"'), true);
  const imported = node(["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(bundles).href)}); console.log("imported");`]);
  is("an import runs nothing (control)", imported.out, "imported\n");

  part("owned reader setup");
  const refused = node([reader]);
  is("real path refuses off the owned runner (control)", refused.err.includes("Owned reader preparation failed"), true);
  is("and exits 1", refused.status, 1);
  const readerLink = join(dir, "reader-link.mjs");
  symlinkSync(reader, readerLink);
  const readerLinked = node([readerLink]);
  is("through a link refuses the same way", readerLinked.err.includes("Owned reader preparation failed"), true);
  is("and exits 1 through the link", readerLinked.status, 1);
  const readerImported = node(["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(reader).href)}); console.log("imported");`]);
  is("an import runs nothing (control)", readerImported.out + readerImported.err, "imported\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
done();
