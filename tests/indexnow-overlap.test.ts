/**
 * Issue #4003 (Codex U, scheduled jobs): two daily IndexNow runs at once (a retried invocation, a manual run beside
 * the scheduled one) both read every address as not announced, both posted the same addresses to api.indexnow.org,
 * and both then marked them, against the protocol's ask not to send an address twice.
 *
 * One run at a time, on an exact claim (lib/claim-mark.ts), as the other scheduled jobs: the run holding the claim
 * announces, a run that finds it held sends nothing and says so, and a claim that cannot be read sends nothing either.
 * The claim is let go when the run ends, so the next day's run announces what is new.
 *
 * Redis stub and a mocked engine only; nothing leaves the test.
 */
import { store as redis } from "./redis-stub";
import { announceNewPages, sitemapUrls } from "@/lib/indexnow";
import { done, is, part } from "./check";

type Pipe = typeof redis.pipeline;
const real: Pipe = redis.pipeline.bind(redis);
const setPipe = (pipe: Pipe) => {
  (redis as unknown as { pipeline: Pipe }).pipeline = pipe;
};

async function main() {
  const urls = sitemapUrls();
  is("(setup) the sitemap has addresses to announce", urls.length > 0, true);

  part("Two runs at once announce each address once");
  redis.clear();
  // Both runs' "already announced?" reads are held until each has asked, so both read every address as new.
  let waiting = 0;
  let release: () => void = () => {};
  const bothAsked = new Promise<void>((resolve) => {
    release = resolve;
  });
  setPipe((async (commands: (string | number)[][]) => {
    if (commands.length && commands.every((c) => c[0] === "SISMEMBER")) {
      const replies = await real(commands);
      waiting += 1;
      if (waiting === 2) release();
      await Promise.race([bothAsked, new Promise((resolve) => setTimeout(resolve, 200))]);
      return replies as never;
    }
    return real(commands);
  }) as Pipe);
  const posted: string[] = [];
  const send = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    posted.push(...(JSON.parse(String(init?.body)) as { urlList: string[] }).urlList);
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  const [a, b] = await Promise.all([announceNewPages(send), announceNewPages(send)]);
  setPipe(real);
  is("no address is posted twice", posted.length, new Set(posted).size);
  is("every address is posted once", posted.length, urls.length);
  is("one run announced them all", [a, b].filter((r) => r.ok && r.announced === urls.length).length, 1);
  is("the other ran nothing and says it was busy", [a, b].some((r) => r.ok && r.announced === 0 && "busy" in r && r.busy === true), true);

  part("The claim is let go when the run ends");
  await redis.pipeline([["SREM", "nl:indexnow:sent", urls[0]]]);
  const later: string[] = [];
  const again = await announceNewPages((async (_input: RequestInfo | URL, init?: RequestInit) => {
    later.push(...(JSON.parse(String(init?.body)) as { urlList: string[] }).urlList);
    return new Response(null, { status: 202 });
  }) as typeof fetch);
  is("the next run announces the one new address", [again, later], [{ ok: true, announced: 1 }, [urls[0]]]);

  part("A claim that cannot be read sends nothing");
  await redis.pipeline([["SREM", "nl:indexnow:sent", urls[0]]]);
  setPipe((async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "SET" || c[0] === "GET")) throw new Error("Redis timed out (synthetic)");
    return real(commands);
  }) as Pipe);
  const blind: string[] = [];
  const unknown = await announceNewPages((async (_input: RequestInfo | URL, init?: RequestInit) => {
    blind.push(...(JSON.parse(String(init?.body)) as { urlList: string[] }).urlList);
    return new Response(null, { status: 202 });
  }) as typeof fetch);
  setPipe(real);
  is("an unknown claim is an unavailable run", unknown, { ok: false, reason: "unavailable" });
  is("and nothing is posted", blind.length, 0);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
