/**
 * Every scheduled job says how long it may run (Claude 7's cron hunt). A route under app/api/cron without
 * `export const maxDuration` runs on whatever the platform's default is that day, so its own budget and its lock's
 * time are not checked against anything. Each job declares it, within Vercel's 300 s, and its lock (claimMark) is
 * kept at least that long, so a run killed at its limit never leaves another run to start while it is still working.
 *
 * courses is the one job still without it: #3344 (Courses drip run: bounded, resumes where it stopped) declares it.
 * The exception fails here once courses declares it, so it is taken off then.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const CRON = join(root, "app/api/cron");
const PENDING: Record<string, string> = { courses: "#3344 declares it" };

const jobs = readdirSync(CRON, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({ name: entry.name, text: readFileSync(join(CRON, entry.name, "route.ts"), "utf8") }));

test("every scheduled job declares its maxDuration, within Vercel's 300 s", () => {
  assert.ok(jobs.length >= 19, "the scheduled jobs are read");
  const missing = jobs.filter(({ name, text }) => !/^export const maxDuration = \d+;$/m.test(text) && !(name in PENDING)).map(({ name }) => name);
  assert.deepEqual(missing, []);
  const over = jobs.filter(({ text }) => Number(/^export const maxDuration = (\d+);$/m.exec(text)?.[1] ?? 0) > 300).map(({ name }) => name);
  assert.deepEqual(over, []);
  const stale = Object.keys(PENDING).filter((name) => /^export const maxDuration = \d+;$/m.test(jobs.find((job) => job.name === name)?.text ?? ""));
  assert.deepEqual(stale, [], "a pending job now declares it: take it off PENDING");
});

test("a job's lock, written as a number, is kept at least its maxDuration", () => {
  const short = jobs.flatMap(({ name, text }) => {
    const limit = Number(/^export const maxDuration = (\d+);$/m.exec(text)?.[1] ?? 0);
    const ttl = /claimMark\("nl:[^"]*lock[^"]*", (\d[\d_]*)/.exec(text)?.[1];
    return limit && ttl && Number(ttl.replace(/_/g, "")) < limit ? [`${name}: lock ${ttl} s < maxDuration ${limit} s`] : [];
  });
  assert.deepEqual(short, []);
});
