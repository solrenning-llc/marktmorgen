// Review measurement: Redis commands of one file replace on /api/store/file/attach (many products, so listings past the head).
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, storeFolder } from "@/lib/store";
import { fileFolder } from "@/lib/product-file";
import { store as redis } from "./redis-stub";
import { files } from "./failure-cleanup-world";
import { POST as fileAttach } from "@/app/api/store/file/attach/route";
const OWNER = "count@example.com";
const post = (session: string, body: unknown) => new NextRequest("https://marktmorgen.com/api/store/file/attach", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });
async function main() {
  redis.clear(); files.clear();
  await claimHandle(OWNER, "countshop", "Count", ""); await ensureStatsId(OWNER);
  const ids: string[] = [];
  for (let i = 0; i < 60; i++) { const m = await addProduct(OWNER, `P${i}`, "", "19", null); if (m.ok) ids.push(m.product.id); }
  const session = await openSession(OWNER);
  for (const id of [ids[0], ids[59]]) {
    const folder = fileFolder(await storeFolder(OWNER), id);
    const one = `${folder}${"a".repeat(20)}.pdf`, two = `${folder}${"b".repeat(20)}.pdf`;
    files.set(one, { bytes: new Uint8Array([37, 80, 68, 70]), contentType: "application/pdf" });
    files.set(two, { bytes: new Uint8Array([37, 80, 68, 70]), contentType: "application/pdf" });
    const r1 = await fileAttach(post(session, { id, pathname: one, name: "a.pdf" }));
    const real = redis.pipeline.bind(redis); let n = 0;
    redis.pipeline = (async (c: (string | number)[][]) => { n += c.length; return real(c); }) as typeof redis.pipeline;
    const r2 = await fileAttach(post(session, { id, pathname: two, name: "b.pdf" }));
    redis.pipeline = real;
    console.log(`product #${ids.indexOf(id)}: attach ${r1.status}, replace ${r2.status}, replace commands ${n}, old deleted ${!files.has(one)}`);
  }
  console.log("done");
}
main().catch((e) => { console.error(e); process.exit(1); });
