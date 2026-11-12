/**
 * The unit tests a documentation-only change can affect (scripts/ci_documentation_scope.py, docs=true).
 *
 * Markdown is never imported by code (tests/run.mjs bundles with esbuild and no loader for it) and the
 * app reads no Markdown at run time: in lib/, app/ and components/ only the files in RUNTIME_FILE_READERS
 * touch the file system, and none of them names a .md file (tests/documentation-readers.test.ts holds
 * both). So a test can read a Markdown file only through the file system or a child process, itself or
 * through a helper outside lib/, app/ and components/. This picks, as a superset:
 *   - every tests/*.test.ts whose own source can touch the file system or a child process (FILE_ACCESS);
 *   - every tests/*.test.ts that names, as a module path, a helper that can, directly or through another
 *     helper it names (fixpoint over every tracked source file outside lib/, app/ and components/).
 * Naming is read by file name without extension in a quoted path ("./x", "../scripts/x.mjs"), so an
 * import, a require or a dynamic import of a literal path is always seen; a name match that is not an
 * import only adds a test. Everything else in a documentation-only change (builds, browsers, Redis, screen
 * readers, CodeQL, the dependency audit) reads no Markdown.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

export const FILE_ACCESS = /node:fs|["']fs["']|fs\/promises|child_process|readFileSync|readdirSync|readFile\(|opendir|execSync|spawnSync|execFileSync|createReadStream|\bglob\b/;
const SOURCE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const TEST = /^tests\/[^/]+\.test\.ts$/;
export const RUNTIME = ["lib/", "app/", "components/"];
/** Reviewed: lib/certificate-pdf.ts reads its three fonts from lib/fonts/; funnel-share-panel.tsx has a
 * browser function named readFile for a file the person picks. Neither reads anything else. */
export const RUNTIME_FILE_READERS = ["components/funnel-share-panel.tsx", "lib/certificate-pdf.ts"];

const stem = (file) => posix.basename(file).replace(SOURCE, "");
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function naming(stems) {
  if (!stems.size) return null;
  const names = [...stems].sort((a, b) => b.length - a.length).map(escape).join("|");
  return new RegExp(`["'/](?:${names})(?:\\.[mc]?[jt]sx?)?["']`);
}

/**
 * @param {string[]} files tracked paths, POSIX separators
 * @param {(file: string) => string} read
 * @returns {string[]} the selected tests/*.test.ts paths, sorted
 */
export function documentationReaders(files, read) {
  const sources = files.filter((f) => SOURCE.test(f) && !f.startsWith("node_modules/"));
  const tests = sources.filter((f) => TEST.test(f)).sort();
  const helpers = sources.filter((f) => !TEST.test(f) && !RUNTIME.some((dir) => f.startsWith(dir)));
  const text = new Map(sources.map((f) => [f, read(f)]));
  const capable = new Set(helpers.filter((f) => FILE_ACCESS.test(text.get(f))));
  for (let grew = true; grew;) {
    grew = false;
    const pattern = naming(new Set([...capable].map(stem)));
    if (!pattern) break;
    for (const f of helpers) {
      if (!capable.has(f) && pattern.test(text.get(f))) { capable.add(f); grew = true; }
    }
  }
  const pattern = naming(new Set([...capable].map(stem)));
  return tests.filter((t) => FILE_ACCESS.test(text.get(t)) || (pattern !== null && pattern.test(text.get(t))));
}

export function trackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8").split("\0").filter(Boolean);
}

/** The selected test file names (as tests/run.mjs lists them) for the repository at root. */
export function documentationReaderNames(root) {
  return documentationReaders(trackedFiles(root), (f) => readFileSync(join(root, f), "utf8"))
    .map((f) => posix.basename(f));
}
