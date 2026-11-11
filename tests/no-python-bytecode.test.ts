/**
 * No compiled Python bytecode is committed (Claude 1 on #3423, LOW): running scripts/test_ci_*.py locally leaves
 * scripts/__pycache__/*.pyc behind, which are build leftovers, go stale on the next edit of their source and are
 * binary noise in main. The tracked files are read from git itself, so an untracked local cache never fails this.
 */
import { execFileSync } from "node:child_process";
import { done, is, part } from "./check";

part("Tracked files");
const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
is("control: git lists this repository's files", tracked.includes("package.json"), true);
const bytecode = tracked.filter((file) => /\.py[co]$/.test(file) || file.split("/").includes("__pycache__"));
is("no .pyc, .pyo or __pycache__ file is tracked", bytecode, []);

done();
