/**
 * One Next production build per workflow run, reused by that run's browser jobs.
 *
 *   node scripts/ci-next-artifact.mjs pack
 *     After `node scripts/ci-build.mjs`: writes next-build.tar.gz with .next (without
 *     .next/cache, which only speeds up a later build) and next-build-source.json, the
 *     exact git tree, Node major version, platform and architecture it was built from.
 *
 *   node scripts/ci-next-artifact.mjs unpack <next-build.tar.gz>
 *     Puts that build in place of a local one. Refuses (the job fails, nothing is rebuilt
 *     or skipped) when a .next is already there, when an archive entry is outside .next,
 *     when the record is missing, or when the tree, Node major, platform or architecture
 *     differ from this checkout and runner: a browser job only ever starts the build of
 *     the very commit it tests, made on the same kind of machine.
 *
 * Both run in the current directory (a job's working-directory), like ci-build.mjs.
 * The build itself is unchanged: scripts/ci-build.mjs, with its type check and route types.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ARCHIVE = "next-build.tar.gz";
export const RECORD = "next-build-source.json";
const FORMAT = 1;

/** The record of what a build was made from, in this directory, on this runner. */
export function sourceRecord(cwd, node = process.versions.node, platform = process.platform, arch = process.arch) {
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd, encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tree)) throw new Error("Unreadable git tree of this checkout");
  return { format: FORMAT, tree, nodeMajor: Number(node.split(".")[0]), platform, arch };
}

/** Problems that keep a packed build from being used here; empty when it may be used. */
export function recordProblems(packed, here) {
  if (!packed || typeof packed !== "object") return ["missing build record"];
  const problems = [];
  for (const key of ["format", "tree", "nodeMajor", "platform", "arch"]) {
    if (packed[key] !== here[key]) problems.push(`${key}: built with ${JSON.stringify(packed[key])}, here ${JSON.stringify(here[key])}`);
  }
  return problems;
}

/** Entries of the archive that may be extracted: .next/… and the record, nothing else. */
export function entryProblems(entries) {
  if (!entries.includes(RECORD)) return ["the archive has no " + RECORD];
  if (!entries.some((entry) => entry === ".next/BUILD_ID")) return ["the archive has no .next/BUILD_ID"];
  const allowed = (entry) => (entry === RECORD || entry === ".next/" || entry.startsWith(".next/"))
    && !entry.split("/").includes("..") && !entry.includes("\\");
  return entries.filter((entry) => !allowed(entry));
}

function pack(cwd) {
  if (!existsSync(join(cwd, ".next/BUILD_ID"))) throw new Error("No finished build in .next to pack");
  writeFileSync(join(cwd, RECORD), JSON.stringify(sourceRecord(cwd)) + "\n");
  rmSync(join(cwd, ARCHIVE), { force: true });
  // GNU tar keeps Turbopack's relative symbolic links in .next as links.
  execFileSync("tar", ["-czf", ARCHIVE, "--exclude=.next/cache", ".next", RECORD], { cwd, stdio: "inherit" });
  rmSync(join(cwd, RECORD));
  console.log(`Packed ${ARCHIVE}: ${statSync(join(cwd, ARCHIVE)).size} bytes`);
}

function unpack(cwd, archive) {
  if (!archive || !existsSync(archive)) throw new Error("The shared build archive is missing");
  if (existsSync(join(cwd, ".next"))) throw new Error("A .next is already here; refuse to mix two builds");
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 256_000_000 }).split("\n").filter(Boolean);
  const bad = entryProblems(entries);
  if (bad.length) throw new Error("Refused archive entries: " + bad.slice(0, 5).join(", "));
  const staging = mkdtempSync(join(cwd, ".next-unpack-"));
  try {
    execFileSync("tar", ["-xzf", resolve(archive), "-C", staging], { stdio: "inherit" });
    const packed = JSON.parse(readFileSync(join(staging, RECORD), "utf8"));
    const problems = recordProblems(packed, sourceRecord(cwd));
    if (problems.length) throw new Error("The shared build is not of this checkout or runner: " + problems.join("; "));
    renameSync(join(staging, ".next"), join(cwd, ".next"));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  if (!existsSync(join(cwd, ".next/BUILD_ID"))) throw new Error("Unpacked build has no BUILD_ID");
  console.log(`Using the build of tree ${sourceRecord(cwd).tree} from ${archive}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, archive] = process.argv.slice(2);
  if (command === "pack") pack(process.cwd());
  else if (command === "unpack") unpack(process.cwd(), archive);
  else throw new Error("usage: ci-next-artifact.mjs pack | unpack <archive>");
}
