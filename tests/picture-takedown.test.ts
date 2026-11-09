/**
 * R44 (Claude 6 audit, 9 November 2026), finding 3: a product taken down by a notice keeps its picture only under a
 * new name. The address its public page, search data and shared card gave out answers "not found" at once, and the
 * creator's studio still shows the picture, from the new name. A failed or unknown step leaves the record as it was
 * and throws, and the next press finishes it; a picture the creator replaced in the meantime, or a product the
 * creator published again, is left alone. lib/takedown.ts, lib/picture-withdraw.ts.
 *
 * Claude 2's review of #3382 (9 November 2026): the old files are deleted only after the record names the copies, a
 * record that cannot be read keeps every file (the originals and the copies) and throws, a press after an unconfirmed
 * delete finishes without moving the picture twice, and an offer after paying never shows a picture taken from a
 * product that is off the store (lib/upsell.ts, funnelView).
 *
 * What this cannot show: copies a shared cache made before the takedown (see the PR). Synthetic data only.
 */
import { NextRequest } from "next/server";
import { GET as servePicture } from "@/app/api/image/[folder]/[file]/route";
import { addProduct, claimHandle, ensureStatsId, imageFolder, setProductFunnel, setProductHidden, setProductImage, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { readReport } from "@/lib/takedown-rules";
import { type Report, sendOwedNotice, takeDown } from "@/lib/takedown";
import { imageUrl, type ProductImage } from "@/lib/product-image";
import { funnelView, newUpsellKey } from "@/lib/upsell";
import { calls, faults, hooks, kept } from "./picture-takedown-world";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Sent = { to: string[] | string; subject: string; text: string };
const sent: Sent[] = [];
/** How many of the next emails the email provider refuses. */
let mailDown = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && mailDown > 0) {
    mailDown -= 1;
    return new Response(JSON.stringify({ message: "refused" }), { status: 422 });
  }
  if (url.hostname === "api.resend.com") {
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";
const OWNER = "pictures@example.test";
let serial = 0;

const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");

async function fetchPicture(path: string): Promise<[number, string | null, string]> {
  const [, folder, file] = path.split("/");
  const r = await servePicture(new NextRequest(`${ORIGIN}${imageUrl({ path })}`, { headers: { "x-forwarded-for": `198.51.100.${20 + (serial++ % 200)}` } }), { params: Promise.resolve({ folder, file }) });
  const body = r.status === 200 ? Buffer.from(await r.arrayBuffer()).toString("hex") : "";
  return [r.status, r.headers.get("cache-control"), body];
}

async function pictured(title: string, n: number): Promise<{ id: string; image: ProductImage }> {
  const made = await addProduct(OWNER, title, "", "9", null);
  if (!made.ok) throw new Error("no product");
  const folder = await imageFolder(OWNER);
  const path = `images/${folder}/${hex(n, 32)}.jpg`;
  const small = `images/${folder}/${hex(n + 1000, 32)}.jpg`;
  kept.set(path, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, 1, 2, 3]));
  kept.set(small, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, 9]));
  const image: ProductImage = { path, width: 1200, height: 900, alt: `Cover of ${title}`, bytes: 8, small: { path: small, width: 800, bytes: 6 }, tone: "#336699" };
  const done = await setProductImage(OWNER, made.product.id, image);
  if (!done.ok) throw new Error("no picture");
  return { id: made.product.id, image };
}

async function now(id: string) {
  const store = await storeForEmail(OWNER);
  if (!store) throw new Error("no store");
  const listing = await readListing(store, id);
  if (!listing) throw new Error("no product");
  return { store, listing };
}

async function press(report: Report, id: string): Promise<string | null | "threw"> {
  const { store } = await now(id);
  return takeDown(report, store, { type: "product", id }, ORIGIN).catch(() => "threw" as const);
}

const servedYear = (r: [number, string | null, string]) => [r[0], r[1]];

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_takedown_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_takedown_only_a_stand_in";
  if (!(await claimHandle(OWNER, "pictureshop", "Picture shop", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_pictureshop1", subscriptionId: "sub_pictureshop1", active: true, tier: "creator", period: paidPeriod() });
  await setStripeAccount(OWNER, "acct_1TestPictures", true);
  const read = readReport({
    kind: "copyright", url: `${ORIGIN}/@pictureshop`, work: "The cover art of my album, copied onto this product.", original: "https://example.com/album",
    name: "Rita Owner", email: "rita@example.com", contact: "+1 555 0100", signature: "Rita Owner", goodFaith: true, accurate: true,
  });
  if (!read.ok) throw new Error("notice not read");
  const report: Report = { ...read.report, id: "a1b2c3d4e5f60718", at: new Date().toISOString(), handle: "pictureshop" };
  const year = [200, "public, max-age=31536000, immutable"];
  const gone = [404, "no-store"];

  part("Control: a published product's picture and its smaller copy");
  const plain = await pictured("Album cover pack", 1);
  is("the picture is served and kept a year", servedYear(await fetchPicture(plain.image.path)), year);
  is("and so is its smaller copy", servedYear(await fetchPicture(plain.image.small!.path)), year);

  part("Taken down by a notice: the old address answers not found, the creator still sees the picture");
  is("the takedown says the product is unpublished", await press(report, plain.id), 'The product "Album cover pack", now unpublished');
  const after = (await now(plain.id)).listing;
  is("the product is off the store", after.hidden, true);
  is("the picture's old address answers not found, kept by nobody", servedYear(await fetchPicture(plain.image.path)), gone);
  is("so does its smaller copy's", servedYear(await fetchPicture(plain.image.small!.path)), gone);
  const moved = after.image;
  is("the product keeps a picture, under a new name in the same folder", [moved !== null, moved?.path !== plain.image.path, moved?.path.slice(0, moved.path.lastIndexOf("/")), moved?.path.endsWith(".jpg")], [true, true, plain.image.path.slice(0, plain.image.path.lastIndexOf("/")), true]);
  is("its smaller copy too", [moved?.small?.path !== plain.image.small!.path, moved?.small?.path.slice(0, moved.small.path.lastIndexOf("/")), moved?.small?.width], [true, plain.image.small!.path.slice(0, plain.image.small!.path.lastIndexOf("/")), 800]);
  is("everything else about the picture is kept", [moved?.alt, moved?.width, moved?.height, moved?.tone], [plain.image.alt, 1200, 900, "#336699"]);
  const newer = moved ? await fetchPicture(moved.path) : [0, null, ""] as [number, string | null, string];
  is("the creator's studio still shows it: the same bytes from the new name", [newer[0], newer[2]], [200, Buffer.from(kept.get(moved?.path ?? "") ?? []).toString("hex") || "missing"]);
  is("the bytes are the original's", newer[2], "ffd8ffe001010203");
  is("the creator is told once", sent.filter((m) => m.subject.includes("Content taken down")).length, 1);
  const copiesBefore = calls.filter((c) => c.startsWith("copy ")).length;
  is("pressing again does nothing", await press(report, plain.id), null);
  is("and moves nothing", calls.filter((c) => c.startsWith("copy ")).length, copiesBefore);

  part("An old file's delete the file store did not confirm: the record already names the copies, nothing is lost");
  const stuck = await pictured("Poster set", 2);
  faults.del = 1;
  is("the press throws", await press(report, stuck.id), "threw");
  is("the product is off the store all the same", (await now(stuck.id)).listing.hidden, true);
  const half = (await now(stuck.id)).listing.image;
  is("the record names the copies, served with the original bytes", [half?.path !== stuck.image.path, half?.small?.path !== stuck.image.small!.path, half ? (await fetchPicture(half.path))[2] : ""], [true, true, "ffd8ffe002010203"]);
  is("the old files are still there: nothing is lost", [kept.has(stuck.image.path), kept.has(stuck.image.small!.path)], [true, true]);
  is("the creator is not told yet", sent.filter((m) => m.text.includes("Poster set")).length, 0);
  const copiesStuck = calls.filter((c) => c.startsWith("copy ")).length;
  is("the next press finishes the takedown", await press(report, stuck.id), 'The product "Poster set", now unpublished');
  const finished = (await now(stuck.id)).listing.image;
  is("the picture is not moved a second time", [finished?.path === half?.path, finished?.small?.path === half?.small?.path, calls.filter((c) => c.startsWith("copy ")).length - copiesStuck], [true, true, 0]);
  is("which is still served, with the original bytes", finished ? [(await fetchPicture(finished.path))[0], (await fetchPicture(finished.path))[2]] : [], [200, "ffd8ffe002010203"]);
  is("the old address answers not found", servedYear(await fetchPicture(stuck.image.path)), gone);
  is("so does its smaller copy's", servedYear(await fetchPicture(stuck.image.small!.path)), gone);
  is("and the creator is told once", sent.filter((m) => m.text.includes("Poster set")).length, 1);

  part("The product's record cannot be read while its picture moves: every file is kept, and the next press finishes");
  const blind = await pictured("Brush pack", 7);
  const catalogId = (await storeForEmail(OWNER))?.catalog.id;
  if (!catalogId) throw new Error("the store keeps its products inline");
  const recordKey = `nl:catalog:${catalogId}:l:${blind.id}`;
  let held: unknown = null;
  hooks.onCopy = async () => {
    held = (await redis.pipeline([["GET", recordKey]]))[0];
    await redis.pipeline([["SET", recordKey, "{not a record"]]);
  };
  const blindPress = await press(report, blind.id);
  if (typeof held !== "string") throw new Error("the record was not held");
  await redis.pipeline([["SET", recordKey, held]]);
  is("the press throws", blindPress, "threw");
  is("the product is off the store all the same", (await now(blind.id)).listing.hidden, true);
  is("its record still names the picture as it was", (await now(blind.id)).listing.image?.path, blind.image.path);
  is("the picture's files are all still there", [kept.has(blind.image.path), kept.has(blind.image.small!.path)], [true, true]);
  is("which are still the original bytes", Buffer.from(kept.get(blind.image.path) ?? []).toString("hex"), "ffd8ffe007010203");
  is("the creator is not told yet", sent.filter((m) => m.text.includes("Brush pack")).length, 0);
  is("the next press finishes the takedown", await press(report, blind.id), 'The product "Brush pack", now unpublished');
  const seen = (await now(blind.id)).listing.image;
  is("the record names the copies, served with the original bytes", [seen?.path !== blind.image.path, seen ? (await fetchPicture(seen.path))[2] : ""], [true, "ffd8ffe007010203"]);
  is("the old address answers not found", servedYear(await fetchPicture(blind.image.path)), gone);
  is("and the creator is told once", sent.filter((m) => m.text.includes("Brush pack")).length, 1);

  part("The email to the creator fails after the picture moved: sending it again moves nothing");
  const unsent = await pictured("Pattern pack", 8);
  mailDown = 1;
  is("the press throws", await press(report, unsent.id), "threw");
  const movedOnce = (await now(unsent.id)).listing.image;
  is("the picture already moved", [movedOnce?.path !== unsent.image.path, kept.has(unsent.image.path)], [true, false]);
  const copiesUnsent = calls.filter((c) => c.startsWith("copy ")).length;
  const resent = await sendOwedNotice(report, (await now(unsent.id)).store, { type: "product", id: unsent.id }, ORIGIN);
  is("the owed email goes out", resent !== null && resent !== "unconfirmed", true);
  is("the picture is not moved a second time", [(await now(unsent.id)).listing.image?.path === movedOnce?.path, calls.filter((c) => c.startsWith("copy ")).length - copiesUnsent], [true, 0]);
  is("which is still served, with the original bytes", movedOnce ? (await fetchPicture(movedOnce.path))[2] : "", "ffd8ffe008010203");

  part("A copy the file store did not confirm: the press throws and the record is untouched");
  const unsure = await pictured("Sticker sheet", 3);
  faults.copy = 1;
  const dels = calls.filter((c) => c.startsWith("del ")).length;
  is("the press throws", await press(report, unsure.id), "threw");
  is("nothing was deleted", calls.filter((c) => c.startsWith("del ")).length, dels);
  is("the record still names the picture as it was", (await now(unsure.id)).listing.image?.path, unsure.image.path);
  is("the next press withdraws it", await press(report, unsure.id), 'The product "Sticker sheet", now unpublished');
  is("its old address answers not found", servedYear(await fetchPicture(unsure.image.path)), gone);

  part("The creator replaces the picture while the takedown runs: their new picture is kept");
  const racing = await pictured("Wallpaper bundle", 4);
  const folder = await imageFolder(OWNER);
  const theirs: ProductImage = { path: `images/${folder}/${hex(77, 32)}.jpg`, width: 640, height: 480, alt: "New cover", bytes: 7, small: null };
  kept.set(theirs.path, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 77, 7, 7]));
  hooks.onCopy = async () => { await setProductImage(OWNER, racing.id, theirs); };
  is("the takedown still goes through", await press(report, racing.id), 'The product "Wallpaper bundle", now unpublished');
  is("the record names the creator's new picture", (await now(racing.id)).listing.image?.path, theirs.path);
  is("which is served", (await fetchPicture(theirs.path))[0], 200);
  is("the old address answers not found", servedYear(await fetchPicture(racing.image.path)), gone);
  const live = await liveNames();
  const strays = [...kept.keys()].filter((p) => p.startsWith(`images/${folder}/`) && !live.has(p));
  is("no copy is left behind for a picture nobody shows", strays, []);

  part("A picture whose files the file store says are gone: the takedown is not held up by it");
  const lost = await pictured("Icon set", 6);
  kept.delete(lost.image.path);
  kept.delete(lost.image.small!.path);
  is("unpublished, and the creator told", [await press(report, lost.id), sent.filter((m) => m.text.includes("Icon set")).length], ['The product "Icon set", now unpublished', 1]);
  is("its old address answers not found", servedYear(await fetchPicture(lost.image.path)), gone);
  const shown = await liveNames();
  is("nothing is copied for it", [...kept.keys()].filter((p) => p.startsWith(`images/${folder}/`) && !shown.has(p)), []);

  part("An offer after paying whose picture comes from a product taken down: no picture is shown");
  const cover = await pictured("Cover art", 9);
  const sell = async (title: string) => {
    const made = await addProduct(OWNER, title, "", "29", null);
    if (!made.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    return made.product.id;
  };
  const front = await sell("Lettering course");
  const target = await sell("Lettering workbook");
  const funnel = await setProductFunnel(OWNER, front, { steps: [{ id: "cover1", productId: target, priceCents: 1900, headline: "", text: "", imageFrom: cover.id, yes: null, no: null }] });
  is("the funnel is accepted, its picture from another product", funnel.ok, true);
  const browser = newUpsellKey();
  const offerImage = async (session: string) => {
    const { store, listing } = await now(front);
    const view = await funnelView({ store, session, product: listing, alsoOwned: [], eligible: true, created: Math.floor(Date.now() / 1000) - 60, secret: browser.secret, upsellKey: browser.fingerprint });
    return [view.offer?.target.id ?? null, view.offer?.image?.path ?? null];
  };
  is("control: the offer shows that product's picture", await offerImage("cs_test_picturefunnel0001"), [target, cover.image.path]);
  is("the picture's product is taken down", await press(report, cover.id), 'The product "Cover art", now unpublished');
  const coverNow = (await now(cover.id)).listing.image;
  is("its picture moved to a new name", coverNow !== null && coverNow.path !== cover.image.path, true);
  is("the offer is still made, with no picture: the new name is not given out", await offerImage("cs_test_picturefunnel0002"), [target, null]);

  part("A product with no picture: taken down as before, nothing asked of the file store");
  const bare = await addProduct(OWNER, "Plain guide", "", "9", null);
  if (!bare.ok) throw new Error("no product");
  const before = calls.length;
  is("unpublished", await press(report, bare.product.id), 'The product "Plain guide", now unpublished');
  is("no file store call", calls.slice(before), []);

  part("Published again by the creator before the email still owed: its picture is left where it is");
  const back = await pictured("Font pack", 5);
  faults.copy = 1;
  is("the press throws", await press(report, back.id), "threw");
  await setProductHidden(OWNER, back.id, false);
  const { store } = await now(back.id);
  const owed = await sendOwedNotice(report, store, { type: "product", id: back.id }, ORIGIN);
  is("the owed email goes out", owed !== null && owed !== "unconfirmed", true);
  is("the published product keeps its picture's address", (await now(back.id)).listing.image?.path, back.image.path);
  is("which is still served", servedYear(await fetchPicture(back.image.path)), year);

  done();
}

/** Every picture name a product of the store shows now. */
async function liveNames(): Promise<Set<string>> {
  const store = await storeForEmail(OWNER);
  const names = new Set<string>();
  for (const item of store?.catalog.items ?? []) {
    const listing = store ? await readListing(store, item.id) : null;
    if (listing?.image) {
      names.add(listing.image.path);
      if (listing.image.small) names.add(listing.image.small.path);
    }
  }
  return names;
}

void main().catch((error) => { console.error(error); process.exitCode = 2; });
