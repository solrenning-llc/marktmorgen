import { renderToStaticMarkup } from "react-dom/server";
import TransparencyPage from "@/app/transparency/page";
import { transparencyCounts } from "@/lib/transparency";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

type Pipeline = typeof redis.pipeline;
type Commands = Parameters<Pipeline>[0];
const NOW = Date.UTC(2026, 10, 3);
const UNREAD = "could not be read just now";

async function answering<T>(command: string, answer: (commands: Commands) => unknown[], work: () => Promise<T>): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => (
    commands[0]?.[0] === command ? answer(commands) : original.call(redis, commands)
  )) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

async function outcome(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "returned";
  } catch (error) {
    if (error instanceof UnknownReplyError) return "unknown reply";
    return error instanceof Error ? `${error.name}: ${error.message}` : "other error";
  }
}

async function pageOutcome(): Promise<string> {
  try {
    const rendered = renderToStaticMarkup(await TransparencyPage());
    return rendered.includes(UNREAD) ? "unread" : "no unread message";
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : "other error";
  }
}

let checks = 0;
let failures = 0;
function equal(name: string, actual: unknown, expected: unknown): void {
  checks += 1;
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    failures += 1;
    console.error(`FAIL ${name}: expected ${right}, received ${left}`);
  } else {
    console.log(`PASS ${name}`);
  }
}

async function main(): Promise<void> {
  redis.clear();

  equal(
    "a semantically impossible start day is unknown",
    await answering("GET", () => ["2026-99-99"], () => outcome(() => transparencyCounts(NOW))),
    "unknown reply",
  );
  equal(
    "the public page turns an impossible day into the honest unread message",
    await answering("GET", () => ["2026-99-99"], pageOutcome),
    "unread",
  );
  equal(
    "a start day in a future year is unknown",
    await answering("GET", () => ["9999-01-01"], () => outcome(() => transparencyCounts(NOW))),
    "unknown reply",
  );
  equal(
    "an unrecognized field cannot silently become all-zero known counts",
    await answering("GET", () => ["2026-11-03"], () => answering(
      "HGETALL",
      commands => commands.map(() => ["notice:copyrigh", "4"]),
      () => outcome(() => transparencyCounts(NOW)),
    )),
    "unknown reply",
  );
  equal(
    "a duplicate field cannot silently use its last value",
    await answering("GET", () => ["2026-11-03"], () => answering(
      "HGETALL",
      commands => commands.map(() => ["notice:copyright", "1", "notice:copyright", "2"]),
      () => outcome(() => transparencyCounts(NOW)),
    )),
    "unknown reply",
  );

  equal(
    "a rejected start day can pass the page unread assertion",
    await answering("GET", () => [7], pageOutcome),
    "unread",
  );
  equal(
    "confirmed absence remains confirmed absence",
    await answering("GET", () => [null], () => transparencyCounts(NOW)),
    { since: null, years: [] },
  );
  equal(
    "a valid day and empty year hash remain healthy zero counts",
    await answering("GET", () => ["2026-11-03"], () => answering("HGETALL", commands => commands.map(() => []), () => transparencyCounts(NOW))),
    {
      since: "2026-11-03",
      years: [{
        year: "2026",
        notices: { copyright: 0, other: 0 },
        acted: { copyright: 0, other: 0 },
        steps: { link: 0, product: 0, kit: 0, store: 0 },
      }],
    },
  );

  console.log(`${checks} checks / ${failures} failures`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
