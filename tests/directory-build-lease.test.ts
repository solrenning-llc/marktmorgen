/**
 * Codex N1 on #2921 (N1-20261119-1124, MEDIUM): the directory's build mark (nl:dir:build) was the plain word
 * "building" with no owner. A build that outlived its 60-second hold deleted the next build's mark when it finished,
 * so a third build could start, or overwrote it with "failed" when it failed, so the page read "unavailable" for ten
 * minutes while that next build was healthy. Each build now holds its own "building:<token>": it publishes its page
 * and lets the mark go, or marks it failed, only while the mark is still its own. A late build answers its page but
 * keeps nothing and touches no other build's mark. Synthetic only: the in-memory Redis.
 */
import { DIRECTORY_BUILD, DIRECTORY_CACHE } from "@/lib/directory-index";
import { readDirectoryPage } from "@/lib/affiliate-directory";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 })) as typeof fetch;

const original = redis.pipeline.bind(redis);
const NEXT = "building:0123456789abcdef01234567";
/** While the first build reads the listed stores, its hold runs out and another build takes the mark. */
let takeOver: null | "healthy" | "failing" = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (takeOver && commands.some((c) => c[0] === "SSCAN")) {
    const how = takeOver;
    takeOver = null;
    await original([["SET", DIRECTORY_BUILD, NEXT, "EX", 60]]);
    if (how === "failing") return [42];
  }
  return original(commands);
}) as typeof redis.pipeline;

const get = async (key: string) => (await original([["GET", key]]))[0];

async function main(): Promise<void> {
  part("A build's own mark");
  {
    redis.clear();
    takeOver = null;
    const page = await readDirectoryPage();
    is("a healthy build answers its page", Array.isArray(page.rows), true);
    is("and keeps it", typeof (await get(DIRECTORY_CACHE)), "string");
    is("and lets its own mark go", await get(DIRECTORY_BUILD), null);
  }

  part("A build that outlived its hold, healthy");
  {
    redis.clear();
    takeOver = "healthy";
    const page = await readDirectoryPage();
    is("it still answers its page", Array.isArray(page.rows), true);
    is("the next build's mark is kept", await get(DIRECTORY_BUILD), NEXT);
    is("the late build keeps no page over the next build's", await get(DIRECTORY_CACHE), null);
  }

  part("A build that outlived its hold, failing");
  {
    redis.clear();
    takeOver = "failing";
    await readDirectoryPage().catch(() => null);
    is("the next build's mark is not turned into \"failed\"", await get(DIRECTORY_BUILD), NEXT);
  }

  part("A failed build of its own still holds the next ones for ten minutes");
  {
    redis.clear();
    let first = true;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (first && commands.some((c) => c[0] === "SSCAN")) {
        first = false;
        return [42];
      }
      return original(commands);
    }) as typeof redis.pipeline;
    await readDirectoryPage().catch(() => null);
    is("its mark reads failed", await get(DIRECTORY_BUILD), "failed");
  }
  done();
}

void main();
