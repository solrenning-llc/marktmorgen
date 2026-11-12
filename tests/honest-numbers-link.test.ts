/**
 * A shared numbers link (app/numbers/[id]/page.tsx, lib/numbers-links.ts)
 * never tells the person it was shared with "This link has ended" or
 * "Opened too many times today" because a read failed or came back in an
 * unknown shape (rule 24; nothing false shown to a person). A link that is
 * truly not there still ends; a count past the day's openings still stops it.
 */
import { renderToStaticMarkup } from "react-dom/server";
import NumbersLinkPage from "@/app/numbers/[id]/page";
import { NextRequest } from "next/server";
import { POST as passwordForm } from "@/app/api/numbers-link/route";
import { OPENS_PER_DAY, countOpen, indexLink, linkStore, makeLink } from "@/lib/numbers-links";
import { addNumbersLink, claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = typeof redis.pipeline;
type Commands = Parameters<Pipeline>[0];

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const ENDED = "This link has ended";
const UNREAD = "could not be read just now";

async function page(id: string): Promise<string> {
  return renderToStaticMarkup(await NumbersLinkPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }));
}

/** Runs `work` with every pipeline whose first command is `command` on a key starting `prefix` answered by `answer`. */
async function answering<T>(command: string, prefix: string, answer: (commands: Commands) => unknown[], work: () => Promise<T>): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => (commands[0]?.[0] === command && String(commands[0]?.[1] ?? "").startsWith(prefix) ? answer(commands) : original.call(redis, commands))) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

async function outcome(work: () => Promise<unknown>): Promise<unknown> {
  try {
    return await work();
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown reply" : "other error";
  }
}

async function main(): Promise<void> {
  redis.clear();
  const now = Date.now();
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStoreId("owner@example.com");
  await ensureStatsId("owner@example.com");
  const made = makeLink({ label: "Acme sponsorship", password: "harbor-2026", days: 30, money: false }, now);
  if (!made.ok) throw new Error("no link");
  await addNumbersLink("owner@example.com", made.link, now);
  const store = (await storeForEmail("owner@example.com"))!;
  await indexLink(store.sid, made.link, now);
  const id = made.link.id;

  part("Healthy control and confirmed absence");
  is("its id finds its store", await linkStore(id), store.sid);
  is("an id nobody made finds nothing", await linkStore("z".repeat(id.length)), null);
  is("the first opening counts", await countOpen(id, now), true);
  const opens = `nl:nlink:opens:${id}:${new Date(now).toISOString().slice(0, 10)}`;
  await redis.pipeline([["SET", opens, String(OPENS_PER_DAY)]]);
  is("past the day's openings: stopped", await countOpen(id, now), false);
  await redis.pipeline([["DEL", opens]]);

  part("An unknown index reply is never 'no such link'");
  for (const [name, reply] of [["a number", [5]], ["an empty text", [""]], ["an object", [{}]], ["no reply", []]] as const) {
    is(`${name}: refused as unknown`, await answering("GET", "nl:nlink:", () => [...reply], () => outcome(() => linkStore(id))), "unknown reply");
  }

  part("An unknown count is never 'opened too many times'");
  for (const [name, reply] of [["text", ["7", 1]], ["not a number", ["x", 1]], ["a negative", [-1, 1]], ["no reply", []]] as const) {
    is(`${name}: refused as unknown`, await answering("INCR", "nl:nlink:opens:", () => [...reply], () => outcome(() => countOpen(id, now))), "unknown reply");
  }

  part("The page says it could not read, never that the link ended");
  const failed = await answering("GET", "nl:nlink:", () => { throw new Error("connection reset"); }, () => outcome(() => page(id)));
  is("a failed read: not ended, said as not read just now", [String(failed).includes(ENDED), String(failed).includes(UNREAD)], [false, true]);
  const odd = await answering("GET", "nl:nlink:", () => [7], () => outcome(() => page(id)));
  is("an unknown reply: not ended, said as not read just now", [String(odd).includes(ENDED), String(odd).includes(UNREAD)], [false, true]);
  const gone = await page("z".repeat(id.length));
  is("a link nobody made: ended", [gone.includes(ENDED), gone.includes(UNREAD)], [true, false]);

  part("The password form says it could not check, never sends to an ended link or crashes");
  const tryPassword = async (linkId: string, password: string) => {
    try {
      const response = await passwordForm(
        new NextRequest("https://marktmorgen.com/api/numbers-link", {
          method: "POST",
          headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.7" },
          body: new URLSearchParams({ id: linkId, password }),
        }),
      );
      return { status: response.status, cookie: response.headers.has("set-cookie"), body: response.status === 303 ? "" : await response.text() };
    } catch (error) {
      return { status: "crashed", cookie: false, body: String(error) };
    }
  };
  is("healthy: the right password opens it", await tryPassword(id, "harbor-2026"), { status: 303, cookie: true, body: "" });
  is("a link nobody made: back to the page that says it ended", await tryPassword("z".repeat(id.length), "harbor-2026"), { status: 303, cookie: false, body: "" });
  const formOdd = await answering("GET", "nl:nlink:", () => [7], () => tryPassword(id, "harbor-2026"));
  // Back to the page's own notice (?unread=1, tests/numbers-link-busy.test.ts), never a bare text/plain 503 (Claude 5 on #2971).
  is("an unknown reply: not checked just now, and no cookie", [formOdd.status, formOdd.cookie], [303, false]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
