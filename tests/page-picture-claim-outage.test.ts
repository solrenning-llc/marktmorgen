/**
 * Codex N1's MEDIUM on #2843, second pass (N1-20261119-0815, lot 59): a save that claimed a picture and then lost
 * its page write left the claim for good when the read that was to decide it (letGoUnlessShown) was unavailable too,
 * an outage of more than one command. Once Redis came back, the picture was held by a page that does not show it:
 * no later save of that page let it go, and no other page could take it.
 *
 * Now the claim is written in the same request as the page (writePage): the page and its new pictures' owner land
 * together or not at all. A write lost before Redis leaves nothing claimed; one that landed leaves a page that shows
 * the picture and owns it. Whatever the read after it answers, a picture is never held by a page that does not show
 * it, and one a page shows is never let go of. The real routes; only the file store is in memory.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, imageFolder, setProductPage, setSitePages, storeForEmail } from "@/lib/store";
import { readPageExact } from "@/lib/sales-page-store";
import { picturePaths } from "@/lib/sales-page";
import { store as redis } from "./redis-stub";
import { files } from "./failure-cleanup-world";
import { done, is, part } from "./check";
import { POST as door } from "@/app/api/store/image/upload/route";
import { POST as pageRoute } from "@/app/api/store/page/route";
import { POST as sitePage } from "@/app/api/store/site-page/route";

const OWNER = "page.outage@example.com";
const ORIGIN = "https://marktmorgen.com";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);

const post = (path: string, session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });

/**
 * An outage that starts with the next page write (SET nl:product:page:…): that write lands first or not at all, and
 * every command after it fails too, the read back included, until `end` is called.
 */
function outageFromPageWrite(landed: boolean): { end: () => void } {
  const original = redis.pipeline;
  let down = false;
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (!down && commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:product:page:"))) {
      down = true;
      if (landed) await original.call(redis, commands);
      throw new Error("stand-in: Redis went away during the page write");
    }
    if (down) throw new Error("stand-in: Redis is still away");
    return original.call(redis, commands);
  };
  // A lock this save held is let go of by the run that comes back, or runs out; here it is let go of at once, so the
  // next case is not refused as busy.
  return { end: () => { redis.pipeline = original; for (const key of redis.keys()) if (/lock/.test(key)) redis.run(["DEL", key]); } };
}

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  await claimHandle(OWNER, "pageoutage", "Page Outage", "");
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Guide", "", "19", null);
  if (!made.ok) throw new Error("setup");
  const id = made.product.id;
  if (!(await setProductPage(OWNER, id, true)).ok) throw new Error("setup");
  if (!(await setSitePages(OWNER, [{ id: "pagepage03", slug: "about", title: "About", nav: true, target: "", from: -1 }])).ok) throw new Error("setup");
  const statsId = (await storeForEmail(OWNER))!.statsId as string;
  const session = await openSession(OWNER);
  const folder = await imageFolder(OWNER);
  let n = 0;
  const upload = async (payload: Record<string, string>) => {
    const pathname = `images/${folder}/${(++n).toString(16).padStart(32, "0")}.jpg`;
    const asked = await door(post("/api/store/image/upload", session, { type: "blob.generate-presigned-url", payload: { pathname, clientPayload: JSON.stringify(payload), multipart: false } }));
    if (asked.status !== 200) throw new Error(`door ${asked.status}`);
    files.set(pathname, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
    return pathname;
  };
  const pictures = (block: string, paths: string[]) => ({
    blocks: [{ id: `${block.slice(0, 7)}0`, kind: "pictures", heading: "", items: paths.map((path) => ({ path, width: 1200, height: 800, alt: "A page", caption: "" })) }],
  });
  const owner = async (path: string) => (await redis.pipeline([["HGET", `nl:product:pics:${statsId}`, path]]))[0];
  const shows = async (pageId: string, path: string) => {
    const now = await readPageExact(statsId, pageId);
    return now.page ? picturePaths(now.page).includes(path) : false;
  };

  for (const [where, pageId, save] of [
    ["a product's page", id, (paths: string[], block: string) => pageRoute(post("/api/store/page", session, { id, page: pictures(block, paths) }))],
    ["a store page", "site:pagepage03", (paths: string[], block: string) => sitePage(post("/api/store/site-page", session, { action: "save", id: "pagepage03", page: pictures(block, paths) }))],
  ] as const) {
    const key = pageId.startsWith("site:") ? null : pageId;
    part(`On ${where}: the page write and the read after it both lost (an outage), the write never landed`);
    {
      const picture = await upload(key ? { productId: id } : { pageId: "pagepage03" });
      const outage = outageFromPageWrite(false);
      try {
        await save([picture], "outa001");
      } finally {
        outage.end();
      }
      is("[CORRETO] once Redis is back, the picture is held by no page: the page never showed it", await owner(picture), null);
    }
    part(`On ${where}: the page write landed and then the outage began`);
    {
      const picture = await upload(key ? { productId: id } : { pageId: "pagepage03" });
      const outage = outageFromPageWrite(true);
      try {
        await save([picture], "outa002");
      } finally {
        outage.end();
      }
      const ownedBy = await owner(picture);
      is("the kept page shows the picture", await shows(key ?? String(ownedBy ?? ""), picture), true);
      is("and the picture it shows is held, never let go of", typeof ownedBy === "string" && ownedBy.length > 0, true);
    }
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
