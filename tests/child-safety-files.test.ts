/**
 * The files of a product held for a child-safety report are kept and closed
 * to everyone (C1-20261109-1546-TODOS-70, unit 3b; 18 U.S.C. § 2258A(h)).
 *
 * The hold marks every file the product hands over: its file, its options'
 * files and its picture. Where every file passes, the mark is read: deleting
 * through the host's blob store, the vault or the video service leaves a
 * marked file where it is, whoever asks (a creator's edit, a store closing,
 * an erasure, a plan's end), and handing it out (a signed address, a
 * download, the public picture route) is refused. A mark that cannot be read
 * keeps the file and refuses to hand it out.
 *
 * Synthetic store, placeholder names and paths, in-memory Redis, no blob
 * token: a call that reached the blob SDK fails at once, without the network.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductFile, setProductImage, setProductPage, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { parsePage } from "@/lib/sales-page";
import { readPageExact, writePage } from "@/lib/sales-page-store";
import { POST as aiRoute } from "@/app/api/store/ai/route";
import { ROOM } from "./data-room";
import { copyKey, stampedCopy } from "@/lib/pdf-stamp";
import { previewCopy, previewKey } from "@/lib/pdf-preview";
import { holdReported } from "@/lib/child-safety";
import { HELD_FILE_SECONDS, holdFiles, isFileHeld } from "@/lib/held-files";
import { del } from "@/lib/blob";
import { deleteFile, fileUrl } from "@/lib/file-store";
import { serveFile } from "@/lib/serve-file";
import { dropStream } from "@/lib/stream";
import { GET as imageRoute } from "@/app/api/image/[folder]/[file]/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

delete process.env.BLOB_READ_WRITE_TOKEN;

const FOLDER = "0123456789abcdef01234567";
const HELD_PICTURE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp";
const FREE_PICTURE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp";
const STREAM_FOLDER = "0123456789abcdef0123456789abcdef";

const file = (pathname: string) => ({ pathname, name: "placeholder.bin", bytes: 1, contentType: "application/octet-stream", addedAt: "" });
const picture = (name: string) => new Request(`https://marktmorgen.com/api/image/${FOLDER}/${name}`, { headers: { host: "marktmorgen.com" } });
const fails = async (work: () => Promise<unknown>) => work().then(() => "ran", () => "refused");

async function main(): Promise<void> {
  redis.clear();
  const owner = "files@example.com";
  await claimHandle(owner, "filesshop", "Files Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_files", subscriptionId: "sub_files", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const held = await addProduct(owner, "Held Product", "On sale", "19", null);
  const free = await addProduct(owner, "Free Product", "On sale", "19", null);
  if (!held.ok || !free.ok) throw new Error("no products");
  const heldPath = `stores/placeholder/${held.product.id}/held.bin`;
  const freePath = `stores/placeholder/${free.product.id}/free.bin`;
  await setProductFile(owner, held.product.id, file(heldPath));
  await setProductFile(owner, free.product.id, file(freePath));
  await setProductImage(owner, held.product.id, { path: `images/${FOLDER}/${HELD_PICTURE}`, width: 10, height: 10, alt: "", bytes: 1, small: null } as never);

  const PAGE_PICTURE = "cccccccccccccccccccccccccccccccc.webp";
  await setProductPage(owner, held.product.id, true);
  const statsId = (await storeForEmail(owner))!.statsId!;
  // Its second version (the page test, page.variant) shows another picture, only there (Claude 6, review 5831985513).
  const VARIANT_PICTURE = "dddddddddddddddddddddddddddddddd.webp";
  await writePage(statsId, held.product.id, parsePage({
    blocks: [{ id: "blk001", kind: "pictures", heading: "", items: [{ path: `images/${FOLDER}/${PAGE_PICTURE}`, width: 10, height: 10, alt: "", caption: "" }] }],
    variant: { blocks: [{ id: "blk002", kind: "pictures", heading: "", items: [{ path: `images/${FOLDER}/${VARIANT_PICTURE}`, width: 10, height: 10, alt: "", caption: "" }] }] },
  }), ROOM);
  const saved = (await readPageExact(statsId, held.product.id)).page;
  is("the page's second version shows its own picture", saved?.variant?.blocks.some((block) => block.kind === "pictures" && block.items.some((item) => item.path === `images/${FOLDER}/${VARIANT_PICTURE}`)), true);

  part("The hold marks every file the product hands over");
  is("held", await holdReported({ kind: "child_safety", url: `https://marktmorgen.com/@filesshop/p/${held.product.id}` }, (await storeForEmail(owner))!), "held");
  is("its file and its picture are marked; another product's file is not", [await isFileHeld(heldPath), await isFileHeld(`images/${FOLDER}/${HELD_PICTURE}`), await isFileHeld(freePath)], [true, true, false]);
  is("so are the pictures on its sales page", await isFileHeld(`images/${FOLDER}/${PAGE_PICTURE}`), true);
  is("and those shown only on the page's second version", await isFileHeld(`images/${FOLDER}/${VARIANT_PICTURE}`), true);
  const lists = redis.keys().filter((key) => key.startsWith("nl:csa:files:"));
  const list = lists.length === 1 ? (JSON.parse(String(redis.run(["GET", lists[0]]))) as { paths: string[]; more: number }) : null;
  is("where its files are is kept for the owner to find them", [lists.length, list?.paths.includes(heldPath), list?.paths.includes(`images/${FOLDER}/${VARIANT_PICTURE}`), list?.more], [1, true, true, 0]);
  const marks = redis.keys().filter((key) => key.startsWith("nl:csa:file:"));
  is("the marks name no path or store", marks.every((key) => /^nl:csa:file:[0-9a-f]{64}$/.test(key)) && marks.length === 4, true);
  const ttl = Number(redis.run(["TTL", marks[0] ?? ""]));
  is("and they end by themselves after 400 days", ttl > 399 * 86_400 && ttl <= HELD_FILE_SECONDS, true);

  part("Nothing deletes a held file, whoever asks");
  is("the blob store leaves it where it is", await fails(() => del(heldPath)), "ran");
  is("as an address too", await fails(() => del(`https://x.private.blob.vercel-storage.com/${heldPath}`)), "ran");
  is("a free file still goes to the blob store (no token here, so the SDK refuses it)", await fails(() => del(freePath)), "refused");
  is("in a batch, only the free one is sent", await fails(() => del([heldPath, freePath])), "refused");
  is("through the common funnel as well", await fails(() => deleteFile([heldPath])), "ran");
  const vaultHeld = `vault/${STREAM_FOLDER}/abcdefghijkl/held.bin`;
  await holdFiles([vaultHeld]);
  is("the vault leaves a held file too (no vault here, so a free one fails)", [await fails(() => deleteFile([vaultHeld])), await fails(() => deleteFile([`vault/${STREAM_FOLDER}/abcdefghijkl/free.bin`]))], ["ran", "refused"]);
  const video = `stream/${STREAM_FOLDER}/abcdefghijkl/11111111-2222-3333-4444-555555555555`;
  const otherVideo = `stream/${STREAM_FOLDER}/abcdefghijkl/66666666-7777-8888-9999-000000000000`;
  await holdFiles([video]);
  await dropStream(video);
  await dropStream(otherVideo);
  const gone = redis.run(["SMEMBERS", "nl:stream:gone"]) as string[];
  is("the video service keeps a held video, and still removes another", [gone.includes("11111111-2222-3333-4444-555555555555"), gone.includes("66666666-7777-8888-9999-000000000000")], [false, true]);

  part("Nobody gets a held file from Marktmorgen");
  is("no signed address", await fileUrl(heldPath, 300, "held.bin"), null);
  const served = await serveFile(file(heldPath));
  is("a download is refused, without saying why", [served.status, await served.text(), served.headers.get("cache-control")], [404, "This file is not available.", "no-store"]);
  const pic = await imageRoute(picture(HELD_PICTURE), { params: Promise.resolve({ folder: FOLDER, file: HELD_PICTURE }) });
  is("the public picture is not found, and not cached", [pic.status, pic.headers.get("cache-control")], [404, "no-store"]);
  const second = await imageRoute(picture(VARIANT_PICTURE), { params: Promise.resolve({ folder: FOLDER, file: VARIANT_PICTURE }) });
  is("nor is a picture shown only on its page's second version", [second.status, second.headers.get("cache-control")], [404, "no-store"]);
  const other = await imageRoute(picture(FREE_PICTURE), { params: Promise.resolve({ folder: FOLDER, file: FREE_PICTURE }) });
  is("another picture is still asked for (no token here, so it fails to fetch)", other.status, 502);

  const session = await openSession(owner);
  const describe = await aiRoute(new NextRequest("https://marktmorgen.com/api/store/ai", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: "https://marktmorgen.com", host: "marktmorgen.com" }, body: JSON.stringify({ kind: "alt", product: free.product.id, path: `images/${FOLDER}/${HELD_PICTURE}` }) }));
  is("its picture goes to no AI provider, even named under another product", [describe.status, ((await describe.json()) as { error?: string }).error], [409, "on_hold"]);
  const words = readFileSync("lib/child-safety.ts", "utf8") + readFileSync("docs/incident-response.md", "utf8");
  is("the owner is told what the site cannot take back: cached pictures for up to a year, issued addresses for up to 4 hours", [words.includes("for up to a year"), words.includes("Purge CDN cache"), words.includes("up to 4 hours")], [true, true, true]);
  is("the privacy policy says reported material is kept, unserved", readFileSync("app/privacy/page.tsx", "utf8").includes('id="child-safety-kept"'), true);

  // A stamped or previewed copy of a held file is handed to nobody, a copy kept from an earlier delivery included.
  const heldPdf = { pathname: `stores/placeholder/${held.product.id}/held.pdf`, name: "held.pdf", bytes: 1, contentType: "application/pdf", addedAt: "2026-11-09T00:00:00.000Z" };
  await holdFiles([heldPdf.pathname]);
  const keptCopy = { ...heldPdf, pathname: "stores/placeholder/stamped/abc/held.pdf" };
  await redis.pipeline([["SET", copyKey("pi_placeholder", heldPdf), JSON.stringify(keptCopy)], ["SET", previewKey(heldPdf, 2), JSON.stringify(keptCopy)]]);
  is("no stamped copy of a held file, not even one kept from before", await stampedCopy(heldPdf, { reference: "pi_placeholder", email: "buyer@example.com", paidAt: 1 }, ROOM), null);
  is("no preview copy either", await previewCopy(heldPdf, 2, ROOM), null);

  part("A mark that cannot be read keeps the file and hands nothing out");
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) =>
    String(commands[0]?.[1] ?? "").startsWith("nl:csa:file:") && commands[0]?.[0] === "GET" ? commands.map(() => 42) : real(commands)) as typeof redis.pipeline;
  is("deleting is refused", await fails(() => del(freePath)), "refused");
  is("no signed address", await fileUrl(freePath, 300, "free.bin"), null);
  const unread = await serveFile(file(freePath));
  is("a download is refused as not checked", [unread.status, unread.headers.get("cache-control")], [503, "no-store"]);
  const unreadPic = await imageRoute(picture(FREE_PICTURE), { params: Promise.resolve({ folder: FOLDER, file: FREE_PICTURE }) });
  is("the picture answers try again, not cached", [unreadPic.status, unreadPic.headers.get("cache-control")], [503, "no-store"]);
  redis.pipeline = real;

  done();
}

main();
