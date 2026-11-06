/**
 * Reproduce scoped E2/E7 types using each snapshot's real repository tsconfig.
 * Usage: node scripts/t-e2-e7-es2017-types.mjs [E2_COMMIT E7_COMMIT]
 * No emit, type cache, compiler-option override, product mutation or network IO.
 * The requested commits must already exist in the local clone.
 */
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 0 && args.length !== 2) {
  throw new Error("Pass both full E2 and E7 commit SHAs, or neither.");
}
if (args.some((sha) => !/^[0-9a-f]{40}$/.test(sha))) {
  throw new Error("Optional snapshot arguments must be full commit SHAs.");
}
const snapshots = [
  { unit: "E2", head: args[0] ?? "149a6fdf0c2808f525601cb5588674ebcf1a1abd", files: ["lib/community-challenge-rules.ts", "tests/community-challenge-rules.test.ts"] },
  { unit: "E7", head: args[1] ?? "ac2c48d5de338c73d5c4d93143af8fa9deb5455c", files: ["lib/course-access-expiry-rules.ts", "tests/course-access-expiry-rules.test.ts"] },
];
const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 });
const flatten = (message) => ts.flattenDiagnosticMessageText(message, "\n");
let errors = 0;
const started = Date.now();
for (const snapshot of snapshots) {
  const sha = git("rev-parse", snapshot.head).trim();
  const configText = git("show", sha + ":tsconfig.json");
  const config = ts.parseConfigFileTextToJson("tsconfig.json", configText);
  if (config.error) throw new Error(flatten(config.error.messageText));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, join(root, "tsconfig.json"));
  if (parsed.errors.length) throw new Error(parsed.errors.map((d) => flatten(d.messageText)).join("\n"));
  if (parsed.options.target !== ts.ScriptTarget.ES2017 || parsed.options.strict !== true
      || parsed.options.noEmit !== true || parsed.options.module !== ts.ModuleKind.ESNext
      || parsed.options.moduleResolution !== ts.ModuleResolutionKind.Bundler) {
    throw new Error("The selected snapshot no longer has the original strict ES2017/ESNext/Bundler/noEmit configuration.");
  }
  const sources = new Map(snapshot.files.map((file) => [join(root, file), git("show", sha + ":" + file)]));
  const host = ts.createCompilerHost(parsed.options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (file) => sources.get(file) ?? readFile(file);
  host.fileExists = (file) => sources.has(file) || fileExists(file);
  host.getSourceFile = (file, version, onError, shouldCreateNew) => sources.has(file)
    ? ts.createSourceFile(file, sources.get(file), version, true)
    : getSourceFile(file, version, onError, shouldCreateNew);
  host.writeFile = () => { throw new Error("The scoped proof must not emit or write a type cache."); };
  // Only the original module and its original test are roots. Every compiler option is unchanged.
  const program = ts.createProgram([...sources.keys()], parsed.options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  errors += diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error).length;
  console.log(JSON.stringify({
    unit: snapshot.unit, head: sha, target: ts.ScriptTarget[parsed.options.target],
    strict: parsed.options.strict, module: ts.ModuleKind[parsed.options.module],
    moduleResolution: ts.ModuleResolutionKind[parsed.options.moduleResolution],
    noEmit: parsed.options.noEmit, lib: parsed.options.lib, files: snapshot.files,
    diagnostics: diagnostics.map((d) => {
      const at = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
      return { code: d.code, file: d.file ? relative(root, d.file.fileName) : null,
        line: at ? at.line + 1 : null, column: at ? at.character + 1 : null, message: flatten(d.messageText) };
    }),
  }));
}
console.log(JSON.stringify({ errors, elapsedMilliseconds: Date.now() - started, emittedFiles: 0 }));
process.exitCode = errors ? 1 : 0;
