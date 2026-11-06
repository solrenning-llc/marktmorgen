/**
 * The page behind an Outreach stop link (app/outreach/stop/[token]/page.tsx)
 * never tells the business "This link is not one we know" because the link
 * could not be read just now (nothing false shown to a person). That would
 * also take away the buttons that stop the emails. A link that truly is not
 * there still says so; a read that fails says it could not be read just now.
 */
import { renderToStaticMarkup } from "react-dom/server";
import OutreachStopPage from "@/app/outreach/stop/[token]/page";
import { linkKey } from "@/lib/outreach";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = typeof redis.pipeline;
type Commands = Parameters<Pipeline>[0];

const UNKNOWN = "This link is not one we know";
const UNREAD = "could not be read just now";
const TOKEN = "a".repeat(32);

async function page(token = TOKEN): Promise<string> {
  return renderToStaticMarkup(await OutreachStopPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve({}) }));
}

async function failing<T>(work: () => Promise<T>): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => {
    if (commands.some((command) => String(command[1] ?? "").startsWith("nl:outreach:"))) throw new Error("connection reset");
    return original.call(redis, commands);
  }) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  redis.clear();
  part("Confirmed absence stays honest");
  const unknown = await page();
  is("a link that is not there: not one we know", [unknown.includes(UNKNOWN), unknown.includes(UNREAD)], [true, false]);

  part("Healthy control");
  await redis.pipeline([["SET", linkKey(TOKEN), JSON.stringify({ s: "s1", id: "p1", d: "example.com", n: "Harbor Kitchen" })]]);
  const healthy = await page();
  is("the store and the stop buttons", [healthy.includes("Stop emails from Harbor Kitchen"), healthy.includes(UNKNOWN), healthy.includes(UNREAD)], [true, false, false]);

  part("A read that fails is never 'not one we know'");
  const failed = await failing(() => page());
  is("not 'not one we know'", failed.includes(UNKNOWN), false);
  is("said as not read just now", failed.includes(UNREAD), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
