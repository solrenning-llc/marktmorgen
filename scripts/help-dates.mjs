/**
 * Reads, once, from the repository's own history, when each help answer was
 * first written and when its current words first appeared (564 [HC1],
 * complement of 30 October 2026, 09h56), and writes lib/help-dates.ts.
 *
 *   created  the day of the first commit in this history whose diff adds the
 *            answer's question, in lib/ or app/ (the help center lived in
 *            app/help/page.tsx before lib/help-content.ts);
 *   updated  the day of the latest commit that added any of the answer's
 *            current lines, as they are written in lib/help-content.ts,
 *            leaving out the commit that only moved the help center into
 *            that file; never before created.
 *
 * Needs the whole history of main (git fetch --unshallow origin main). Run
 * from the repository root: node scripts/help-dates.mjs. Dates are the
 * commits' own, as UTC days whatever the machine's time zone (git runs with
 * TZ=UTC), never typed by hand. After this first run, the dates are kept by
 * hand with each change, held by tests/help-dates.test.ts.
 *
 * A line is searched whole (git log -S with the entire trimmed line), so a
 * change in the tail of a long line is found (review of #4209: a 120-character
 * prefix missed 24 later changes). And an answer's words can come from another
 * file (a price interpolated from lib/plan.ts), which no line search sees
 * (Codex N1, MEDIUM, #4209): so the answers are also evaluated at every commit
 * that touches lib/help-content.ts or a file it imports, read straight from
 * the history, and a commit whose evaluated words differ from its parent's
 * dates the answer. A commit that cannot be built (a branch's half-done
 * step) is skipped, and the next one is compared with its nearest ancestor
 * that builds: a change is then dated by a later commit, never an earlier
 * one. Past BROKEN_WALK such ancestors the run stops: an unknown is never
 * read as unchanged. tests/help-dates-script.test.ts checks
 * all of it on synthetic repositories.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, posix } from "node:path";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

/** git in `cwd`, its dates always read as UTC days. */
export const gitIn = (cwd) => (args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, TZ: "UTC" } }).trim();

/** The UTC day of the earliest commit whose diff adds or removes `text` in `paths`, or undefined. */
export function firstDay(git, text, paths) {
  return git(["log", "HEAD", "--reverse", "--format=%ad", "--date=format-local:%Y-%m-%d", "-S", text, "--", ...paths]).split("\n").filter(Boolean)[0];
}

/** The UTC day of the latest commit whose diff adds or removes the whole `line` in `paths`, leaving out the commit `skip`. */
export function lastDayOfLine(git, line, paths, skip = "") {
  const rows = git(["log", "HEAD", "--format=%H %ad", "--date=format-local:%Y-%m-%d", "-S", line, "--", ...paths]).split("\n").filter(Boolean);
  return rows.find((row) => !skip || !row.startsWith(skip))?.split(" ")[1];
}

/**
 * The entry esbuild bundles: every answer, read through the @ alias, never the
 * machine's own path (which on Windows puts backslashes in the string; Codex
 * N1, LOW, #4209).
 */
export function helpEntry() {
  return `import { HELP_SECTIONS, answerId } from "@/lib/help-content";\nconsole.log(JSON.stringify(HELP_SECTIONS.flatMap((s) => s.items.map((i) => ({ id: answerId(i.q), q: i.q, a: i.a })))));\n`;
}

/** What an answer says, as one short hash: its question and its paragraphs. */
export const digestOf = (answer) => createHash("sha256").update([answer.q, ...answer.a].join("\n")).digest("hex").slice(0, 12);

/** Blobs of the repository by `<commit>:<path>`, through one `git cat-file --batch`; null when there is none. */
function blobReader(cwd) {
  const child = spawn("git", ["cat-file", "--batch"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
  let buf = Buffer.alloc(0);
  const waiting = [];
  child.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (waiting.length) {
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      const header = buf.subarray(0, nl).toString("utf8");
      if (/ (missing|ambiguous)$/.test(header)) {
        buf = buf.subarray(nl + 1);
        waiting.shift()(null);
        continue;
      }
      const [, type, size] = header.split(" ");
      const n = Number(size);
      if (buf.length < nl + 1 + n + 1) return;
      const body = buf.subarray(nl + 1, nl + 1 + n);
      buf = buf.subarray(nl + 2 + n);
      waiting.shift()(type === "blob" ? body.toString("utf8") : null);
    }
  });
  return {
    read: (spec) => new Promise((resolve) => {
      waiting.push(resolve);
      child.stdin.write(`${spec}\n`);
    }),
    close: () => child.stdin.end(),
  };
}

/** How many ancestors in a row that do not build are walked past before the run stops. */
export const BROKEN_WALK = 200;

const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", ".json", "/index.ts", "/index.tsx", "/index.js"];
const LOADERS = { ".ts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".json": "json" };

/**
 * The answers as commit `sha` wrote them, every file read from that commit:
 * a map from answer id to its digest, and the repository files it read. Null
 * when that commit has no lib/help-content.ts; it throws when it has one that
 * cannot be evaluated.
 */
async function answersAt(build, blobs, root, sha) {
  if ((await blobs.read(`${sha}:lib/help-content.ts`)) === null) return null;
  const texts = new Map();
  const find = async (path) => {
    for (const ext of EXTENSIONS) {
      const candidate = posix.normalize(path + ext);
      if (texts.has(candidate)) return candidate;
      const text = await blobs.read(`${sha}:${candidate}`);
      if (text !== null) {
        texts.set(candidate, text);
        return candidate;
      }
    }
    return null;
  };
  const tree = {
    name: "git-tree",
    setup(b) {
      const resolved = async (path, from) => {
        const hit = await find(path);
        return hit ? { path: hit, namespace: "git" } : { errors: [{ text: `${from} not in ${sha}` }] };
      };
      b.onResolve({ filter: /^@\// }, (args) => resolved(args.path.slice(2), args.path));
      b.onResolve({ filter: /^\.\.?\//, namespace: "git" }, (args) => resolved(posix.join(posix.dirname(args.importer), args.path), args.path));
      b.onLoad({ filter: /.*/, namespace: "git" }, (args) => ({
        contents: texts.get(args.path),
        loader: LOADERS[posix.extname(args.path)] ?? "ts",
        resolveDir: root,
      }));
    },
  };
  const bundled = await build({ stdin: { contents: helpEntry(), resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent", plugins: [tree] });
  let printed = "";
  const loaded = { exports: {} };
  const console = { ...globalThis.console, log: (text) => (printed = text) };
  runInThisContext(`(function (require, module, exports, console) {\n${bundled.outputFiles[0].text}\n})`)(createRequire(join(root, "package.json")), loaded, loaded.exports, console);
  const digests = new Map(JSON.parse(printed).map((answer) => [answer.id, digestOf(answer)]));
  return { digests, files: [...texts.keys()] };
}

/**
 * For each answer id, the UTC day of the latest non-merge commit whose
 * evaluated words for it differ from its parent's. Every commit touching
 * lib/help-content.ts or any file it imported at any commit read (until no
 * new file turns up) is evaluated with its parent. A commit or a parent that
 * has lib/help-content.ts and cannot be evaluated throws.
 */
export async function evaluatedDays(git, root, ids) {
  const { build } = await import("esbuild");
  const blobs = blobReader(root);
  const cache = new Map();
  // Each commit's answers, null when it has no help center, or { broken } when it has one that does not build.
  const at = async (sha) => {
    if (!cache.has(sha)) {
      try {
        cache.set(sha, await answersAt(build, blobs, root, sha));
      } catch (error) {
        cache.set(sha, { broken: error instanceof Error ? error.message : String(error) });
      }
    }
    return cache.get(sha);
  };
  // The nearest ancestor (first parents) whose answers build, or null when the help center did not exist yet.
  const builtBefore = async (parent) => {
    for (let sha = parent, steps = 0; sha; steps += 1) {
      const answers = await at(sha);
      if (!answers?.broken) return answers;
      if (steps >= BROKEN_WALK) throw new Error(`No commit that builds within ${BROKEN_WALK} before ${parent}: ${answers.broken}`);
      sha = git(["rev-list", "--parents", "-n", "1", sha]).split(" ")[1] ?? "";
    }
    return null;
  };
  const head = await at(git(["rev-parse", "HEAD"]));
  if (head?.broken) throw new Error(`The answers at HEAD could not be evaluated: ${head.broken}`);
  const days = {};
  const paths = new Set(["lib/help-content.ts", ...(head?.files ?? [])]);
  const done = new Set();
  try {
    for (let fresh = [...paths]; fresh.length > 0; ) {
      const rows = git(["log", "HEAD", "--no-merges", "--format=%H %P|%ad", "--date=format-local:%Y-%m-%d", "--", ...fresh]).split("\n").filter(Boolean);
      fresh = [];
      for (const row of rows) {
        const [shas, day] = row.split("|");
        const [sha, parent] = shas.split(" ");
        if (done.has(sha)) continue;
        done.add(sha);
        const now = await at(sha);
        // No help center yet, or a step that does not build: its words reached nobody; the next commit is compared past it.
        if (!now || now.broken) continue;
        for (const file of now.files) if (!paths.has(file)) {
          paths.add(file);
          fresh.push(file);
        }
        const before = parent ? await builtBefore(parent) : null;
        // No help center in the parent: this commit made lib/help-content.ts (or moved it there), dated as created.
        if (!before) continue;
        for (const id of ids) {
          const words = now.digests.get(id);
          if (words !== undefined && words !== before.digests.get(id) && !(days[id] >= day)) days[id] = day;
        }
      }
    }
  } finally {
    blobs.close();
  }
  return days;
}

async function main() {
const { build } = await import("esbuild");

const root = process.cwd();
const out = mkdtempSync(join(tmpdir(), "help-dates-"));
try {
  const entry = join(out, "entry.ts");
  writeFileSync(entry, helpEntry());
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile: join(out, "entry.cjs"), logLevel: "error", alias: { "@": root } });
  const answers = JSON.parse(execFileSync(process.execPath, [join(out, "entry.cjs")], { encoding: "utf8", maxBuffer: 64 << 20 }));
  const source = readFileSync(join(root, "lib/help-content.ts"), "utf8");
  const git = gitIn(root);
  if (git(["rev-parse", "--is-shallow-repository"]) === "true") throw new Error("The history is shallow: run git fetch --unshallow origin main first.");
  const rows = {};
  const moved = git(["log", "HEAD", "--diff-filter=A", "--format=%H", "--", "lib/help-content.ts"]).split("\n").at(-1);
  // The file's question lines, in order: one per answer, the same order HELP_SECTIONS reads them.
  const lines = source.split("\n");
  const qAt = lines.map((line, i) => (/^\s*q: /.test(line) ? i : -1)).filter((i) => i >= 0);
  if (qAt.length !== answers.length) throw new Error(`${qAt.length} question lines for ${answers.length} answers`);
  // Words that come from other files change with no line of lib/help-content.ts moving: read from the answers themselves.
  const evaluated = await evaluatedDays(git, root, answers.map((answer) => answer.id));
  answers.forEach((answer, n) => {
    const from = qAt[n];
    const to = lines.findIndex((line, i) => i > from && /^\s{6}\},?$/.test(line));
    const block = lines.slice(from + 1, to).map((l) => l.trim()).filter((l) => l.length > 20 && !/^a: \[$|^\],?$/.test(l));
    const literal = lines[from].trim().match(/^q: "(.*)",$/)?.[1];
    const created = [answer.q, ...(literal ? [literal] : [])].map((text) => firstDay(git, text, ["lib", "app"])).filter(Boolean).sort()[0];
    if (!created) throw new Error(`No commit adds the question of ${answer.id}`);
    // The commit that moved the help center out of app/help/page.tsx changed no words: it is never an answer's last change.
    const lineDays = block.map((line) => lastDayOfLine(git, line, ["lib/help-content.ts", "app/help/page.tsx"], moved)).filter(Boolean);
    const updated = [created, ...lineDays, ...(evaluated[answer.id] ? [evaluated[answer.id]] : [])].sort().at(-1);
    rows[answer.id] = { created, updated, digest: digestOf(answer) };
    process.stderr.write(".");
  });
  const out_lines = Object.entries(rows).map(([id, r]) => `  ${JSON.stringify(id)}: { created: "${r.created}", updated: "${r.updated}", digest: "${r.digest}" },`);
  writeFileSync(join(root, "lib/help-dates.ts"), `/**
 * When each help answer was first written and when what it says last changed
 * (564 [HC1]), keyed by answerId. First read from the repository's history by
 * scripts/help-dates.mjs on 12 November 2026; kept by hand since, with each
 * change to an answer. \`digest\` is the answer's words as they were dated:
 * tests/help-dates.test.ts fails when the words change and the digest does
 * not, so whoever changes an answer decides: what it says changed (set
 * \`updated\` to that day) or only a comma or a link (keep the date). Both put
 * the new digest. Dates are YYYY-MM-DD, UTC.
 */
export type HelpDates = { created: string; updated: string; digest: string };

export const HELP_DATES: Readonly<Record<string, HelpDates>> = {
${out_lines.join("\n")}
};
`);
  process.stderr.write(`\n${Object.keys(rows).length} answers dated\n`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
