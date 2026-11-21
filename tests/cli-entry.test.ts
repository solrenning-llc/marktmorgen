/**
 * cli/marktmorgen.mjs runs its command when it is the program node was asked
 * to run, wherever it sits and whatever its link is called, and only then.
 * Before this, a path with a space or a percent sign (or a Windows path, or a
 * link not named "marktmorgen") ran nothing and exited 0: an agent read an
 * empty success. Synthetic: copies of the file in temporary folders, no key,
 * no server; every command here stops before any request.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { done, is, part } from "./check";

const source = join(process.cwd(), "cli", "marktmorgen.mjs");
const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
const node = (args: string[]) => {
  const run = spawnSync(process.execPath, args, { encoding: "utf8", env: env as NodeJS.ProcessEnv });
  return { status: run.status, out: run.stdout, err: run.stderr };
};

const dir = mkdtempSync(join(tmpdir(), "cli-entry-"));
try {
  const places: [string, string][] = [
    ["a folder with a space", join(dir, "dir with space")],
    ["a folder with a percent sign", join(dir, "100% folder")],
    ["a folder with non-ASCII letters", join(dir, "açaí")],
    ["a plain folder (control)", join(dir, "plain")],
  ];
  for (const [name, folder] of places) {
    part(name);
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "marktmorgen.mjs");
    copyFileSync(source, file);
    const help = node([file, "help"]);
    is("help prints the help text", help.out.startsWith("marktmorgen: your Marktmorgen store from the command line."), true);
    is("help exits 0", help.status, 0);
    const keyless = node([file, "list_products"]);
    is("a tool without a key exits 2, not 0", keyless.status, 2);
    is("and says to set the key", keyless.err.includes("Set MARKTMORGEN_API_KEY"), true);
  }

  part("a link with another name");
  const link = join(dir, "mm");
  symlinkSync(join(dir, "dir with space", "marktmorgen.mjs"), link);
  const linked = node([link, "list_products"]);
  is("runs through the link: exits 2 without a key", linked.status, 2);

  part("imported, not run (control)");
  const imported = node(["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(join(dir, "dir with space", "marktmorgen.mjs")).href)}); console.log("imported");`]);
  is("importing it runs no command", imported.out, "imported\n");
  is("and writes nothing to stderr", imported.err, "");
  is("and exits 0", imported.status, 0);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
done();
