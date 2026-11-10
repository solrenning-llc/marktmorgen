/**
 * A store page as a file and back (582 [KB3], unit 3; added 10 November
 * 2026), through the real route with the creator's own session: "export"
 * gives the page's title, blocks and style without its pictures, read
 * exactly; "import" makes a new page from such a file, kept back from
 * visitors and out of the menu, held to the rules a saved page is (a changed
 * or foreign file is refused whole), with the products, forms and calls this
 * store does not have left out and counted; nothing is added when it is
 * refused, when the store has its most pages, or when its forms cannot be read.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, imageFolder, setSitePages, storeForEmail } from "@/lib/store";
import { readPageExact, writePage } from "@/lib/sales-page-store";
import { emptyBlock, parsePage, type PageBlock } from "@/lib/sales-page";
import { writeForm } from "@/lib/form-store";
import { parseForm } from "@/lib/forms";
import { MAX_SITE_PAGES, type SitePage, siteKey } from "@/lib/site-page-rules";
import { PAGE_FILE_FORMAT, PAGE_FILE_VERSION, importedEntry, pageFileName, readPageFile } from "@/lib/site-page-file";
import { EXPORT_HELP, IMPORT_HELP, exportDoneWords, importDoneWords } from "@/components/site-pages-editor";
import { POST as sitePage } from "@/app/api/store/site-page/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "page-file@example.com";
const ORIGIN = "https://marktmorgen.com";
const SITE = "bbbbbbbbbb";

type Answer = { ok?: boolean; error?: string; id?: string; pages?: SitePage[]; pictures?: number; file?: Record<string, unknown>; left?: { pictures: number; refs: number; reviewPicks: number } };

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "pagefile", "Page file", "");
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Bread course", "", "19", null);
  if (!made.ok) throw new Error("setup");
  const product = made.product.id;
  const shop = (await storeForEmail(OWNER))!;
  const statsId = shop.statsId!;
  const form = parseForm({ id: "formhere01", name: "Questions", fields: [{ id: "q00001", type: "short", label: "Your name", required: true }] })!;
  await writeForm(statsId, form);
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` };
  const post = async (body: unknown) => {
    const response = await sitePage(new NextRequest(`${ORIGIN}/api/store/site-page`, { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, data: (await response.json()) as Answer };
  };
  const folder = await imageFolder(OWNER);
  const picture = { path: `images/${folder}/${"1".padStart(32, "0")}.jpg`, width: 1200, height: 800, alt: "Bread", caption: "" };
  const hero = { ...(emptyBlock("hero") as Extract<PageBlock, { kind: "hero" }>), headline: "Bake bread", media: "none" as const };
  const text = { ...(emptyBlock("text") as Extract<PageBlock, { kind: "text" }>), heading: "Why", body: "It is good." };
  const pictures = { ...(emptyBlock("pictures") as Extract<PageBlock, { kind: "pictures" }>), heading: "Loaves", items: [picture] };
  const productBlock = { ...(emptyBlock("product") as Extract<PageBlock, { kind: "product" }>), product };
  const formBlock = { ...(emptyBlock("form") as Extract<PageBlock, { kind: "form" }>), form: form.id };
  const original = parsePage({ blocks: [hero, text, pictures, productBlock, formBlock], seoTitle: "Bake bread with Pia", style: "plain" });
  if (!(await setSitePages(OWNER, [{ id: SITE, slug: "bread", title: "Bake bread", nav: true, target: "", from: 0 }])).ok) throw new Error("setup");
  await writePage(statsId, siteKey(SITE), original, shop);

  part("Export");
  const exported = await post({ action: "export", id: SITE });
  const file = exported.data.file!;
  is("the page as a file: format, version, title, blocks in order, style", [exported.status, file.format, file.version, file.title, (file.blocks as PageBlock[]).map((b) => b.kind), file.style], [200, PAGE_FILE_FORMAT, PAGE_FILE_VERSION, "Bake bread", ["hero", "text", "pictures", "product", "form"], "plain"]);
  is("without its pictures, counted, and without its search title", [JSON.stringify(file).includes(picture.path), exported.data.pictures, "seoTitle" in file], [false, 1, false]);
  is("named by the page's address", pageFileName({ slug: "bread" }), "bread.page.json");
  is("a page that is not there", (await post({ action: "export", id: "zzzzzzzzzz" })).status, 404);

  part("Import, in the same store");
  const brought = await post({ action: "import", file });
  const entry = brought.data.pages?.find((p) => p.id === brought.data.id);
  is("a new page after the others, from the file's title, out of the menu, not out", entry && [brought.status, brought.data.pages?.length, entry.title, entry.slug, entry.nav, entry.from], [200, 2, "Bake bread", "bake-bread", false, -1]);
  const kept = (await readPageExact(statsId, siteKey(brought.data.id ?? ""))).page;
  is("kept back, the same blocks in order, this store's product and form kept", kept && [kept.hidden, kept.blocks.map((b) => b.kind), kept.blocks.find((b) => b.kind === "product")?.kind === "product" && (kept.blocks.find((b) => b.kind === "product") as { product: string }).product, (kept.blocks.find((b) => b.kind === "form") as { form: string } | undefined)?.form], [true, ["hero", "text", "pictures", "product", "form"], product, form.id]);
  is("nothing left out but what the file never held", brought.data.left, { pictures: 0, refs: 0, reviewPicks: 0 });
  is("the original untouched", JSON.stringify((await readPageExact(statsId, siteKey(SITE))).page) === JSON.stringify(original), true);

  part("Import, of another store's page");
  const foreign = { ...file, blocks: (file.blocks as PageBlock[]).map((b) => (b.kind === "product" ? { ...b, product: "notmine001" } : b.kind === "form" ? { ...b, form: "notmine002" } : b)) };
  const other = await post({ action: "import", file: foreign });
  const otherPage = (await readPageExact(statsId, siteKey(other.data.id ?? ""))).page;
  is("what this store does not have is left out and counted", [other.status, other.data.left?.refs, otherPage?.blocks.some((b) => (b.kind === "product" && (b as { product: string }).product === "notmine001") || (b.kind === "form" && (b as { form: string }).form === "notmine002"))], [200, 2, false]);
  is("the address is numbered when taken", other.data.pages?.find((p) => p.id === other.data.id)?.slug, "bake-bread-2");

  part("Refused, and nothing added");
  const count = async () => (await storeForEmail(OWNER))!.sitePages.length;
  const before = await count();
  const changed = { ...file, blocks: [...(file.blocks as PageBlock[]), { id: "zzzzzzzz", kind: "nonsense" }] };
  is("not one of these files, or changed so its blocks would not be kept", [(await post({ action: "import", file: { format: "other", version: 1, blocks: [] } })).data.error, (await post({ action: "import", file: { ...file, version: 2 } })).data.error, (await post({ action: "import", file: changed })).data.error, (await post({ action: "import", file: "text" })).data.error, await count()], ["file", "file", "file", "file", before]);
  is("the reader alone: a good file reads; one whose picture is not a picture of a store is refused whole", [readPageFile(file).ok, readPageFile({ ...file, blocks: [{ ...pictures, items: [{ ...picture, path: "https://elsewhere.example/x.jpg" }] }] }).ok], [true, false]);
  const longHeading = { ...file, blocks: (file.blocks as PageBlock[]).map((b) => (b.kind === "text" ? { ...b, heading: "x".repeat(5_000) } : b)) };
  const longBody = { ...file, blocks: (file.blocks as PageBlock[]).map((b) => (b.kind === "text" ? { ...b, body: "y".repeat(100_000) } : b)) };
  is("a file edited so a block would be kept cut short is refused whole, never kept shortened (review of #3538)", [(await post({ action: "import", file: longHeading })).data.error, readPageFile(longBody).ok, await count()], ["file", false, before]);
  const pipeline = redis.pipeline;
  redis.pipeline = async (commands) => (commands.some((c) => c[0] === "HEXISTS") ? [] : pipeline.call(redis, commands));
  let unread: Awaited<ReturnType<typeof post>>;
  try {
    unread = await post({ action: "import", file });
  } finally {
    redis.pipeline = pipeline;
  }
  is("forms nobody could read never decide a form is not this store's", [unread.status, unread.data.error, await count()], [503, "forms_unread", before]);
  // No room for the blocks: refused before the page is listed, the list exactly as it was (review of #3538).
  const listBefore = JSON.stringify((await storeForEmail(OWNER))!.sitePages);
  redis.pipeline = async (commands) => (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).includes("marktmorgen:store-data:v1") ? [[0, 999_999_999]] : pipeline.call(redis, commands));
  let full: Awaited<ReturnType<typeof post>>;
  try {
    full = await post({ action: "import", file });
  } finally {
    redis.pipeline = pipeline;
  }
  is("no room for the blocks: nothing listed, nothing kept", [full.status, full.data.error, JSON.stringify((await storeForEmail(OWNER))!.sitePages) === listBefore], [409, "copy_full", true]);
  const now = (await storeForEmail(OWNER))!.sitePages;
  await setSitePages(OWNER, [...now, ...Array.from({ length: MAX_SITE_PAGES - now.length }, (_, n) => ({ id: `f${String(n).padStart(9, "0")}`, slug: `filler-${n}`, title: `Filler ${n}`, nav: false, target: "", from: -1 }))]);
  is("a store with its most pages takes none", [(await post({ action: "import", file })).data.error, await count()], ["too_many", MAX_SITE_PAGES]);
  is("an untitled file gets a title of its own", importedEntry("", [], "cccccccccc")?.title, "Page from a file");

  part("In the studio");
  is("said before: what the file holds and leaves out", [EXPORT_HELP, IMPORT_HELP], [
    "Download as a file: this page's title and blocks, as last saved, to keep or to bring into another of your stores. Pictures are not in the file.",
    "A page you downloaded from a store here. It comes in hidden from visitors and out of the menu. Pictures, and the products and forms this store does not have, are left out.",
  ]);
  is("and after, what was left out", [exportDoneWords(0), exportDoneWords(2), importDoneWords({ pictures: 0, refs: 0, reviewPicks: 0 }), importDoneWords({ pictures: 1, refs: 2, reviewPicks: 3 })], [
    "Page downloaded.",
    "Page downloaded. Its 2 pictures are not in the file.",
    "Page brought in and opened, hidden from visitors.",
    "Page brought in and opened, hidden from visitors. Left out: a picture, 2 products, forms or calls this store does not have, the reviews picked to show first.",
  ]);
  const editor = readFileSync("components/site-pages-editor.tsx", "utf8").replace(/\s+/g, " ");
  is("the file box has a visible label and its help; the download button has its own", [editor.includes('<span className="block">Or bring in a page from a file</span>'), editor.includes('aria-describedby="site-page-file-help"'), editor.includes('aria-describedby="site-page-export-help" onClick={() => void download()}> Download as a file </button>')], [true, true, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
