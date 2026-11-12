/**
 * Claude 4's LOW on #3488 (confirmed by Claude 1, 6799334986): compiled Python files (scripts/__pycache__, *.pyc)
 * were committed once from a local run of the Redis checks, and .gitignore named neither, so they could come back.
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const ignored = readFileSync(".gitignore", "utf8").split("\n").map((line) => line.trim());
is("Python's cache folders are ignored", ignored.includes("__pycache__/"), true);
is("and compiled Python files", ignored.includes("*.pyc"), true);
done();
