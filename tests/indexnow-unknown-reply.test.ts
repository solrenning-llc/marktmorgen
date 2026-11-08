/**
 * IndexNow's "already announced?" read, in its exact shape (CX-123 rule 24).
 *
 * The daily job (lib/indexnow.ts) asks SISMEMBER for each sitemap address and
 * posts the ones not announced before to api.indexnow.org. It read each reply
 * as `Number(x) !== 1`, so an unknown reply (null, a string, an object) was
 * taken as "never announced" and the address was posted again, against the
 * protocol's ask not to resend. Only 0 (not a member) or 1 (a member), one for
 * each address, is an answer; anything else is an unavailable run that sends
 * nothing and remembers nothing, tried again the next day.
 */
import { store as redis } from "./redis-stub";
import { announceNewPages, sitemapUrls } from "@/lib/indexnow";
import { done, is, part } from "./check";

type Pipe = typeof redis.pipeline;
const real: Pipe = redis.pipeline.bind(redis);
const setPipe = (pipe: Pipe) => {
  (redis as unknown as { pipeline: Pipe }).pipeline = pipe;
};

function engine() {
  const sent: string[][] = [];
  const send = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push((JSON.parse(String(init?.body)) as { urlList: string[] }).urlList);
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  return { sent, send };
}

/** The SISMEMBER replies replaced by `shape(real replies)`; every other command as it is. */
function withMembers(shape: (replies: unknown[]) => unknown): void {
  setPipe((async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    return (commands.every((c) => c[0] === "SISMEMBER") ? shape(replies) : replies) as never;
  }) as Pipe);
}

async function main() {
  const urls = sitemapUrls();
  is("the sitemap has more than one address to read", urls.length > 1, true);

  part("Healthy and confirmed-empty controls");
  redis.clear();
  const first = engine();
  is("nothing announced yet (each reply 0): every address is sent once", [await announceNewPages(first.send), first.sent.flat().length], [{ ok: true, announced: urls.length }, urls.length]);
  const again = engine();
  is("all announced (each reply 1): nothing is sent", [await announceNewPages(again.send), again.sent.length], [{ ok: true, announced: 0 }, 0]);
  redis.clear();
  await redis.pipeline([["SADD", "nl:indexnow:sent", ...urls.slice(1)]]);
  const one = engine();
  is("one address new: only it is sent", [await announceNewPages(one.send), one.sent.flat()], [{ ok: true, announced: 1 }, [urls[0]]]);

  part("An unknown reply sends nothing");
  const shapes: [string, (replies: unknown[]) => unknown][] = [
    ["a null for one address", (r) => r.map((v, i) => (i === 0 ? null : v))],
    ["the string \"1\" for one address", (r) => r.map((v, i) => (i === 0 ? "1" : v))],
    ["the string \"0\" for one address", (r) => r.map((v, i) => (i === 0 ? "0" : v))],
    ["an object for one address", (r) => r.map((v, i) => (i === 0 ? {} : v))],
    ["true for one address", (r) => r.map((v, i) => (i === 0 ? true : v))],
    ["a 2 for one address", (r) => r.map((v, i) => (i === 0 ? 2 : v))],
    ["a list for one address", (r) => r.map((v, i) => (i === 0 ? [1] : v))],
    ["one reply short", (r) => r.slice(1)],
    ["one reply too many", (r) => [...r, 0]],
    ["no list at all", () => null],
    ["an object for the whole answer", () => ({})],
  ];
  for (const [what, shape] of shapes) {
    for (const announced of [false, true]) {
      redis.clear();
      if (announced) await redis.pipeline([["SADD", "nl:indexnow:sent", ...urls]]);
      withMembers(shape);
      const e = engine();
      const out = await announceNewPages(e.send).catch((err: unknown) => `threw ${String(err)}`);
      setPipe(real);
      const [remembered] = await redis.pipeline([["SCARD", "nl:indexnow:sent"]]);
      is(`${what}, ${announced ? "all already announced" : "none announced yet"}: an unavailable run, nothing posted, nothing remembered`, [out, e.sent.length, remembered], [{ ok: false, reason: "unavailable" }, 0, announced ? urls.length : 0]);
    }
  }

  part("The next healthy run carries on");
  redis.clear();
  const after = engine();
  is("the next day every address is sent", [await announceNewPages(after.send), after.sent.flat().length], [{ ok: true, announced: urls.length }, urls.length]);

  done();
}

void main();
