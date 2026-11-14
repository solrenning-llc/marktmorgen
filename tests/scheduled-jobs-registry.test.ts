/**
 * Every scheduled job in vercel.json has a line in tests/plan-cost-registry.ts
 * (SCHEDULED_JOBS): its schedule, the most time one run may take, what bounds
 * one run's commands and calls, and the sources that hold those bounds. A job
 * that spends on a provider for every store, student or member it walks is a
 * company cost bounded by its schedule and its run's ceiling (MR item 2); one
 * added without saying so fails here, as a counter or an email site does in
 * tests/plan-cost-registry.test.ts.
 *
 *   - every cron path has exactly one line, with the same schedule;
 *   - the line's time ceiling is the route's own maxDuration, or null when the
 *     route sets none (the platform's default, unverified: unknown, never zero);
 *   - each source file exists and holds every name the line cites.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEDULED_JOBS } from "./plan-cost-registry";
import { done, is, part } from "./check";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");
const crons = (JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] }).crons;

part("every scheduled job has exactly one line, with its schedule");
for (const cron of crons) {
  const lines = SCHEDULED_JOBS.filter((job) => job.path === cron.path);
  is(`${cron.path} has one line`, lines.length, 1);
  if (lines.length === 1) is(`${cron.path} keeps its schedule`, lines[0].schedule, cron.schedule);
}
for (const job of SCHEDULED_JOBS) is(`${job.path} is a job in vercel.json`, crons.some((cron) => cron.path === job.path), true);

part("each line's time ceiling is the route's own maxDuration, or null when it sets none");
for (const job of SCHEDULED_JOBS) {
  const file = `app${job.path}/route.ts`;
  is(`${file} is there`, existsSync(join(root, file)), true);
  if (!existsSync(join(root, file))) continue;
  const declared = /export const maxDuration = (\d+);/.exec(read(file));
  is(`${job.path}: the ceiling is the route's`, job.maxSeconds, declared ? Number(declared[1]) : null);
  is(`${job.path}: says what bounds one run`, job.bound.trim().length > 40, true);
  if (job.maxSeconds === null) is(`${job.path}: a missing ceiling is said to be unknown`, /unknown, never zero/.test(job.bound), true);
}

part("each source holds what its line cites");
for (const job of SCHEDULED_JOBS) {
  is(`${job.path} cites at least one source`, job.sources.length > 0, true);
  for (const source of job.sources) {
    const there = existsSync(join(root, source.file));
    is(`${job.path}: ${source.file} is there`, there, true);
    if (!there) continue;
    const text = read(source.file);
    for (const name of source.names) is(`${job.path}: ${source.file} holds ${name}`, text.includes(name), true);
  }
}

done();
