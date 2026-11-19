/**
 * Codex N1's MEDIUM on #2843 (a24df09202): a picture claimed for a page whose write then failed stayed that page's
 * for good. claimNewPictures writes `picture → page` before the page is written; a page write refused or thrown left
 * the claim, the page never showed the picture, so a later save without it never let it go: the file stayed held by
 * a page that does not show it, and no other page could take it.
 *
 * Now a save whose page was not kept lets go of what it just claimed, but only after reading the page as it is: a
 * claimed picture the page does not show goes back on the door, checked; one the page shows (a write that landed and
 * then answered with an error) stays the page's, so nothing a page shows is ever let go of. A page that does not read
 * keeps every claim. The real routes; only the file store is in memory (tests/failure-cleanup-world.ts).
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, imageFolder, setProductPage, setSitePages, storeForEmail } from "@/lib/store";
import { MAX_PICTURES } from "@/lib/sales-page";
import { store as redis } from "./redis-stub";
import { files } from "./failure-cleanup-world";
import { done, is, part } from "./check";
import { POST as door } from "@/app/api/store/image/upload/route";
import { POST as pageRoute } from "@/app/api/store/page/route";
import { POST as sitePage } from "@/app/api/store/site-page/route";

const OWNER = "page.orphans@example.com";
const ORIGIN = "https://marktmorgen.com";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);

const post = (path: string, session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });
const status = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];

/** The next write of a page record (SET nl:product:page:…) fails: before it reaches Redis, or after it landed. */
function failNextPageWrite(landed: boolean): () => void {
  const original = redis.pipeline;
  let done = false;
  redis.pipeline = async (commands: (string | number)[][]) => {
    // The page's own write: a plain SET, or, since Codex N1's lot 60 on #2843, the one script that writes the page and
    // its new pictures' owner together (PAGE_WITH_CLAIMS). What is checked below is unchanged.
    if (!done && commands.some((c) => (c[0] === "SET" && String(c[1]).startsWith("nl:product:page:")) || (c[0] === "EVAL" && String(c[3]).startsWith("nl:product:page:")))) {
      done = true;
      if (landed) await original.call(redis, commands);
      throw new Error("stand-in: the page write's answer was lost");
    }
    return original.call(redis, commands);
  };
  return () => { redis.pipeline = original; };
}

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  await claimHandle(OWNER, "pageorphans", "Page Orphans", "");
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Guide", "", "19", null);
  if (!made.ok) throw new Error("setup");
  const id = made.product.id;
  if (!(await setProductPage(OWNER, id, true)).ok) throw new Error("setup");
  if (!(await setSitePages(OWNER, [{ id: "pagepage02", slug: "about", title: "About", nav: true, target: "", from: -1 }])).ok) throw new Error("setup");
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
    blocks: paths.length ? [{ id: `${block.slice(0, 7)}0`, kind: "pictures", heading: "", items: paths.slice(0, MAX_PICTURES).map((path) => ({ path, width: 1200, height: 800, alt: "A page", caption: "" })) }] : [],
  });
  const owner = async (path: string) => (await redis.pipeline([["HGET", `nl:product:pics:${statsId}`, path]]))[0];

  part("A product's page whose write failed before Redis: its new picture is let go of");
  {
    const picture = await upload({ productId: id });
    const undo = failNextPageWrite(false);
    let first: unknown;
    try {
      first = await status(await pageRoute(post("/api/store/page", session, { id, page: pictures("orph001", [picture]) })));
    } finally {
      undo();
    }
    is("the save with the picture failed", first, [500, "server_error"]);
    is("the picture is nobody's: the page never showed it", await owner(picture), null);
    is("a later save without it saves", await status(await pageRoute(post("/api/store/page", session, { id, page: pictures("orph002", []) }))), [200, "ok"]);
    is("and the same picture can be put on a page again, from the door", await status(await pageRoute(post("/api/store/page", session, { id, page: pictures("orph003", [picture]) }))), [200, "ok"]);
    is("now it is the page's", await owner(picture), id);
  }

  part("A product's page whose write landed and then answered an error: the page shows it, so it stays the page's");
  {
    const picture = await upload({ productId: id });
    const undo = failNextPageWrite(true);
    try {
      await pageRoute(post("/api/store/page", session, { id, page: pictures("orph004", [picture]) }));
    } finally {
      undo();
    }
    is("the picture the kept page shows is never let go of", await owner(picture), id);
  }

  part("A store page whose write failed before Redis: its new picture is let go of");
  {
    const picture = await upload({ pageId: "pagepage02" });
    const undo = failNextPageWrite(false);
    let first: unknown;
    try {
      first = await status(await sitePage(post("/api/store/site-page", session, { action: "save", id: "pagepage02", page: pictures("orph005", [picture]) })));
    } finally {
      undo();
    }
    is("the save with the picture failed", first, [500, "server_error"]);
    is("the picture is nobody's", await owner(picture), null);
    is("and it can be put on the page again, from the door", await status(await sitePage(post("/api/store/site-page", session, { action: "save", id: "pagepage02", page: pictures("orph006", [picture]) }))), [200, "ok"]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
