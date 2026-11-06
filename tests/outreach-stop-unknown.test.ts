/**
 * CX-123 rule 24 on the page behind an Outreach email's stop link
 * (app/outreach/stop/[token]/page.tsx, readStopLink in lib/outreach.ts): the
 * link's record read in an unknown shape, or a read that failed, is unknown,
 * never "This link is not one we know". The business is told the link could
 * not be checked just now, and still how else to stop the emails.
 */
import { renderToStaticMarkup } from "react-dom/server";
import OutreachStopPage from "@/app/outreach/stop/[token]/page";
import { linkKey, readStopLink, stopFromLink } from "@/lib/outreach";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const TOKEN = "a".repeat(32);
const MISSING = "b".repeat(32);
/** The GET of a stop link answered with `reply`; every other command as kept. */
function linkAnswers(reply: unknown): void {
  redis.pipeline = (async (batch: Command[]) => {
    if (batch.length === 1 && batch[0][0] === "GET" && String(batch[0][1]).startsWith("nl:outreach:stoplink:")) return reply;
    return real(batch);
  }) as typeof redis.pipeline;
}
const restore = () => {
  redis.pipeline = real as typeof redis.pipeline;
};

async function outcome(read: () => Promise<unknown>): Promise<string> {
  try {
    const got = await read();
    return got === null ? "none" : got === false ? "false" : "read";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`;
  }
}

async function page(token: string): Promise<string> {
  return renderToStaticMarkup(await OutreachStopPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve({}) }));
}

async function main(): Promise<void> {
  redis.clear();
  await real([["SET", linkKey(TOKEN), JSON.stringify({ s: "s1", id: "p1", d: "example.com", n: "Ada's store" })]]);
  is("a link as kept is read", (await readStopLink(TOKEN))?.domain, "example.com");
  is("a link nobody has is none", await outcome(() => readStopLink(MISSING)), "none");

  part("The link's record in an unknown shape is unknown, never 'not one we know'");
  const shapes: [string, unknown][] = [
    ["a cut-short pipeline", []],
    ["a number", [7]],
    ["an object", [{ s: "s1" }]],
    ["a list", [["x"]]],
    ["not a list at all", { 0: null }],
  ];
  for (const [name, reply] of shapes) {
    linkAnswers(reply);
    is(`${name}: readStopLink is unknown`, await outcome(() => readStopLink(TOKEN)), "unknown");
    is(`${name}: stopFromLink is unknown, never 'no such link'`, await outcome(() => stopFromLink(TOKEN, false)), "unknown");
    restore();
  }

  part("The page says it could not check the link");
  const unchecked = "We could not check this link just now";
  const unknownLink = "This link is not one we know";
  linkAnswers([7]);
  let html = await page(TOKEN);
  is("an unknown record: the page says so", [html.includes(unchecked), html.includes(unknownLink)], [true, false]);
  restore();
  redis.pipeline = (async () => {
    throw new Error("Redis request failed with status 503");
  }) as typeof redis.pipeline;
  html = await page(TOKEN);
  is("Redis down: the page says so", [html.includes(unchecked), html.includes(unknownLink)], [true, false]);
  is("Redis down: it still says how else to stop the emails", html.includes("reply to the email"), true);
  restore();
  html = await page(MISSING);
  is("a link nobody has: not one we know", [html.includes(unchecked), html.includes(unknownLink)], [false, true]);
  html = await page(TOKEN);
  is("a link as kept: the stop buttons", [html.includes(unchecked), html.includes("Stop emails from Ada&#x27;s store")], [false, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
