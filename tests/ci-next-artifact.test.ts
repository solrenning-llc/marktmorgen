/**
 * The production build runs once per workflow run (scripts/ci-next-artifact.mjs) and the
 * browser jobs start that one build. These checks hold what makes that safe: a browser job
 * starts only a build of its own exact git tree, Node major, platform and architecture,
 * never a mix of two builds and never an archive entry outside .next; every job that starts
 * .next waits for the build job and downloads it right before it is used; the build itself is
 * still the same scripts/ci-build.mjs; and the browser jobs that run beside the build (buyer and
 * signup actions) never start this .next at all.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { is, part, done } from "./check";

const SCRIPT = resolve("scripts/ci-next-artifact.mjs");
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=ci", "-c", "user.email=ci@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tool = (cwd: string, ...args: string[]) => {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { code: run.status, out: (run.stdout ?? "") + (run.stderr ?? "") };
};
const tarList = (archive: string) => execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n").filter(Boolean);

const work = mkdtempSync(join(tmpdir(), "ci-next-artifact-"));
try {
  part("pack: the build and the record of the tree it was made from, without the build cache");
  const built = join(work, "built");
  mkdirSync(built);
  git(built, "init", "-q");
  writeFileSync(join(built, "page.txt"), "one\n");
  git(built, "add", "page.txt");
  git(built, "commit", "-q", "-m", "one");
  mkdirSync(join(built, ".next/server"), { recursive: true });
  mkdirSync(join(built, ".next/cache"), { recursive: true });
  mkdirSync(join(built, ".next/node_modules"), { recursive: true });
  writeFileSync(join(built, ".next/BUILD_ID"), "synthetic-build\n");
  writeFileSync(join(built, ".next/server/page.js"), "module.exports = 1;\n");
  writeFileSync(join(built, ".next/cache/only-for-a-later-build"), "x");
  symlinkSync("../../node_modules/sharp", join(built, ".next/node_modules/sharp-0000"));
  const packed = tool(built, "pack");
  const archive = join(built, "next-build.tar.gz");
  is("pack succeeds", packed.code, 0);
  const entries = tarList(archive);
  is("the archive holds .next and the record", [entries.includes(".next/BUILD_ID"), entries.includes(".next/server/page.js"),
    entries.includes("next-build-source.json")], [true, true, true]);
  is("the build cache is left out", entries.some((entry) => entry.startsWith(".next/cache")), false);
  is("the record is not left in the checkout", existsSync(join(built, "next-build-source.json")), false);

  const noBuild = join(work, "no-build");
  mkdirSync(noBuild);
  git(noBuild, "init", "-q");
  is("pack refuses a directory without a finished build", tool(noBuild, "pack").code === 0, false);

  part("unpack: only into a clean checkout of the very same tree");
  const same = join(work, "same");
  git(work, "clone", "-q", built, same);
  const used = tool(same, "unpack", archive);
  is("the same tree takes the build", used.code, 0);
  is("with its files", readFileSync(join(same, ".next/BUILD_ID"), "utf8"), "synthetic-build\n");
  is("relative links stay links to the checkout's own dependencies",
    [lstatSync(join(same, ".next/node_modules/sharp-0000")).isSymbolicLink(), readlinkSync(join(same, ".next/node_modules/sharp-0000"))],
    [true, "../../node_modules/sharp"]);
  is("no record and no staging folder are left", [existsSync(join(same, "next-build-source.json")),
    execFileSync("ls", ["-A", same], { encoding: "utf8" }).includes(".next-unpack-")], [false, false]);
  const twice = tool(same, "unpack", archive);
  is("a second build is never mixed into an existing .next", [twice.code === 0, /already here/.test(twice.out)], [false, true]);

  const other = join(work, "other");
  git(work, "clone", "-q", built, other);
  writeFileSync(join(other, "page.txt"), "two\n");
  git(other, "commit", "-q", "-am", "two");
  const refused = tool(other, "unpack", archive);
  is("another tree refuses the build", [refused.code === 0, /tree: built with/.test(refused.out)], [false, true]);
  is("and keeps no .next and no staging folder", [existsSync(join(other, ".next")),
    execFileSync("ls", ["-A", other], { encoding: "utf8" }).includes(".next-unpack-")], [false, false]);

  is("a missing archive fails", tool(join(work, "same"), "unpack", join(work, "absent.tar.gz")).code === 0, false);

  part("unpack: the record and the entries are checked before anything is used");
  const forge = (name: string, record: Record<string, unknown> | null, extra: string[] = []) => {
    const folder = join(work, name);
    mkdirSync(join(folder, ".next"), { recursive: true });
    writeFileSync(join(folder, ".next/BUILD_ID"), "forged\n");
    const files = [".next"];
    if (record) {
      writeFileSync(join(folder, "next-build-source.json"), JSON.stringify(record));
      files.push("next-build-source.json");
    }
    for (const file of extra) {
      writeFileSync(join(folder, file), "x");
      files.push(file);
    }
    execFileSync("tar", ["-czf", join(work, name + ".tar.gz"), ...files], { cwd: folder });
    return join(work, name + ".tar.gz");
  };
  const here = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { sourceRecord } from ${JSON.stringify(SCRIPT)}; console.log(JSON.stringify(sourceRecord(${JSON.stringify(same)})))`],
  { encoding: "utf8" }));
  is("the record names the tree, Node major, platform and architecture", Object.keys(here).sort(),
    ["arch", "format", "nodeMajor", "platform", "tree"]);
  const fresh = (name: string) => {
    const folder = join(work, name);
    git(work, "clone", "-q", built, folder);
    return folder;
  };
  for (const [what, record] of [
    ["another Node major", { ...here, nodeMajor: here.nodeMajor + 1 }],
    ["another platform", { ...here, platform: "win32" }],
    ["another architecture", { ...here, arch: "arm64-not-this" }],
    ["another record format", { ...here, format: 2 }],
  ] as [string, Record<string, unknown>][]) {
    const folder = fresh("target-" + what.replace(/\W+/g, "-"));
    const result = tool(folder, "unpack", forge("forged-" + what.replace(/\W+/g, "-"), record));
    is(`${what} refuses the build`, [result.code === 0, existsSync(join(folder, ".next"))], [false, false]);
  }
  const unrecorded = fresh("target-unrecorded");
  is("an archive without a record is refused", tool(unrecorded, "unpack", forge("unrecorded", null)).code === 0, false);
  const outside = fresh("target-outside");
  const stray = tool(outside, "unpack", forge("outside", here, ["package.json"]));
  is("an entry outside .next is refused before extraction",
    [stray.code === 0, existsSync(join(outside, ".next")), /Refused archive entries: package\.json/.test(stray.out)], [false, false, true]);
} finally {
  rmSync(work, { recursive: true, force: true });
}

part("workflows: one build job per run; every job that starts .next waits for it and checks it");
const read = (name: string) => readFileSync(`.github/workflows/${name}.yml`, "utf8");
/** Top-level jobs of a workflow: {job id: its text}. */
function jobs(text: string): Record<string, string> {
  const body = text.split("\njobs:\n")[1] ?? "";
  const out: Record<string, string> = {};
  for (const chunk of body.split(/^(?=  [a-z][a-z0-9-]*:\n)/m)) {
    const id = /^ {2}([a-z][a-z0-9-]*):\n/.exec(chunk)?.[1];
    if (id) out[id] = chunk;
  }
  return out;
}
const SHARED: Record<string, string[]> = {
  "accessibility-product-actions": ["product-actions"],
  "accessibility-public-matrix": ["public-matrix"],
  "accessibility-studio-matrix": ["studio-matrix"],
  "product-checks": ["mobile-render", "cross-browser"],
};
const BESIDE: Record<string, string> = {
  "accessibility-buyer-actions": "buyer-actions",
  "accessibility-signup-actions": "signup-actions",
};
const DOWNLOAD = "uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2\n";
const UPLOAD = "uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2\n";
for (const name of [...Object.keys(SHARED), ...Object.keys(BESIDE)]) {
  const all = jobs(read(name));
  const build = all.build ?? "";
  const shared = name in SHARED;
  is(`${name}: one build job, named for the workflow, gated only by the scope`, [
    build.includes(`    name: Next build (${name})\n`), build.includes("    needs: documentation-scope\n"),
    build.includes("    if: ${{ !cancelled() && needs.documentation-scope.outputs.full != 'false' }}\n"),
  ], [true, true, true]);
  is(`${name}: the build job runs the unchanged build, in the browser jobs' image`, [
    build.split("node scripts/ci-build.mjs").length - 1, build.includes("      image: mcr.microsoft.com/playwright:v1.56.1-noble\n"),
    build.includes("--user pwuser"), build.includes('node-version: "24"'),
  ], [1, true, true, true]);
  is(`${name}: the build is shared only where a job starts it`, [
    build.includes("run: node scripts/ci-next-artifact.mjs pack\n"), build.includes(UPLOAD),
    build.includes("          name: next-build\n") && build.includes("          retention-days: 1\n") && build.includes("          if-no-files-found: error\n"),
  ], [shared, shared, shared]);
  is(`${name}: the final check reads the build job`, /\n {4}needs: \[build, /.test(all["all-checks"] ?? ""), true);
  const others = Object.entries(all).filter(([id]) => !["build", "all-checks", "documentation-scope"].includes(id));
  for (const [id, body] of others) {
    if (name === "product-checks" && id === "verify") {
      is(`${name}/verify keeps its own named production build and route types`,
        body.includes("      - name: Production build and route types\n        run: node scripts/ci-build.mjs\n"), true);
      continue;
    }
    is(`${name}/${id}: never builds again`, body.includes("ci-build.mjs"), false);
    const starts = (SHARED[name] ?? []).includes(id);
    if (!starts) continue;
    is(`${name}/${id}: waits for the build and runs only when it succeeded`, [
      body.includes("    needs: [build, documentation-scope]\n"),
      body.includes("    if: ${{ !cancelled() && needs.documentation-scope.outputs.full != 'false' && needs.build.result == 'success' }}\n"),
    ], [true, true]);
    const steps = body.split(/^ {6}- /m);
    const download = steps.findIndex((step) => step.includes(DOWNLOAD));
    const unpack = steps.findIndex((step) => step.includes("run: node scripts/ci-next-artifact.mjs unpack \"$RUNNER_TEMP/next-build/next-build.tar.gz\"\n"));
    const npm = steps.findIndex((step) => step.startsWith("run: npm ci\n"));
    const browser = steps.findIndex((step, index) => index > unpack && /run: node tests\/e2e\//.test(step));
    is(`${name}/${id}: installs, downloads, checks the tree, then starts the build`,
      [npm > 0, download === unpack - 1, unpack > npm, browser > unpack, steps[download]?.includes("          name: next-build\n")],
      [true, true, true, true, true]);
  }
  if (!shared) {
    const test = readFileSync(`tests/e2e/${name}.mjs`, "utf8");
    is(`${name}: its browser job serves its own disposable build, never this .next, so it may run beside the build job`, [
      /join\(reviewedApp\.root,"node_modules\/next\/dist\/bin\/next"\),"start"/.test(test), /\{cwd:reviewedApp\.root,/.test(test),
      all[BESIDE[name]]?.includes("    needs: documentation-scope\n"),
    ], [true, true, true]);
  }
}

part("macOS and Windows readers keep their own build: a Linux .next is never started there");
const readers = jobs(read("accessibility-real-readers"));
is("real readers: no build job, each runner builds", [readers.build === undefined, readers["entry-pilot"]?.includes("      - run: node scripts/ci-build.mjs\n")], [true, true]);

done();
