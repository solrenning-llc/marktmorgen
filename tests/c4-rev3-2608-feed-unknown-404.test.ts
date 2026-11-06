/**
 * Review proof (#2608, rule 24): a GET of a feed grant whose reply comes back
 * in another shape (here an extra element) is read as "no such grant", and the
 * podcast app is told 404 "No such feed." though the grant exists. Unknown
 * should be a 503 (retry), not absent.
 */
import { NextRequest } from "next/server";
import { tokenKey } from "@/lib/podcast-access";
import { GET } from "@/app/api/store/podcast/feed/[token]/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  const token = "a".repeat(48);
  await redis.pipeline([["SET", tokenKey(token), JSON.stringify({ s: "b".repeat(32), h: "synthetic", p: "c".repeat(32), e: "l@example.invalid" })]]);
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (c: (string | number)[][]) => {
    const r = await real(c);
    return c.length === 1 && c[0][0] === "GET" && c[0][1] === tokenKey(token) ? [...r, null] : r;
  }) as typeof redis.pipeline;
  part("grant exists; its GET reply is in another shape");
  const res = await GET(new NextRequest(`https://marktmorgen.com/api/store/podcast/feed/${token}.xml`), { params: Promise.resolve({ token: `${token}.xml` }) });
  is("an unknown read is not answered 404 'No such feed.'", [res.status, await res.text()].join(" ") === "404 No such feed.", false);
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
