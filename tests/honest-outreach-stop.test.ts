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

/** Runs `work` with every pipeline of two SISMEMBERs (whether the stop already holds) thrown, as a lost connection would be. */
async function stateFailing<T>(work: () => Promise<T>): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => {
    if (commands.length === 2 && commands.every((command) => command[0] === "SISMEMBER")) throw new Error("connection reset");
    return original.call(redis, commands);
  }) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

/** The scopes of the stop forms a page offers, each carrying this link. */
function scopes(html: string, token = TOKEN): string[] {
  const forms = [...html.matchAll(/<form\b[^>]*action="\/api\/outreach\/stop"[^>]*>[\s\S]*?<\/form>/g)].map((m) => m[0]);
  return forms.filter((form) => form.includes(`name="p" value="${token}"`)).map((form) => /name="scope" value="([^"]*)"/.exec(form)?.[1] ?? "").sort();
}

const STOPPED_CLAIMS = ["cannot write to you again", "Nobody here can write to you"];

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

  part("A read that fails never takes the stop buttons away, nor says a stop holds (Codex K2 MEDIUM)");
  is("the link's read failing: both stop buttons stay", scopes(failed), ["all", "store"]);
  is("the link's read failing: no stop is said to hold", STOPPED_CLAIMS.some((claim) => failed.includes(claim)), false);
  const state = await stateFailing(() => page());
  is("the stop state's read failing: said as not read just now", state.includes(UNREAD), true);
  is("the stop state's read failing: both stop buttons stay", scopes(state), ["all", "store"]);
  is("the stop state's read failing: no stop is said to hold", STOPPED_CLAIMS.some((claim) => state.includes(claim)), false);
  is("control: healthy, both stop buttons", scopes(healthy), ["all", "store"]);
  is("control: a link that is not there offers no button", scopes(unknown), []);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
