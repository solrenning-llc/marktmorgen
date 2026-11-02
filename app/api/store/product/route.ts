import { dropCourseTasks } from "@/lib/assignment";
import { storeKey } from "@/lib/learn";
import { imagePaths } from "@/lib/product-image";
import { waitingCount } from "@/lib/preorders";
import type { NextRequest } from "next/server";
import { deleteFile as del } from "@/lib/file-store";
import {
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  StoreFullError,
  addProduct,
  editProduct,
  filesOnProduct,
  moveProduct,
  removeProduct,
  setProductAbout,
  setProductHidden,
  setProductIntro,
  setProductLink,
  setProductYearly,
  storeForEmail,
  type Product,
} from "@/lib/store";
import { MAX_LINK_LENGTH, readLink } from "@/lib/product-link";
import { readRecurring } from "@/lib/product-recurring";
import { type Intro, introProblem } from "@/lib/intro-price";
import { type Yearly, yearlyProblem } from "@/lib/yearly-price";
import { priceBounds, readMoney } from "@/lib/money";
import { MAX_ABOUT_LENGTH, cleanAbout, dropAbout, readAbout, writeAbout } from "@/lib/product-about";
import { jsonAccess } from "@/lib/studio-route";
import { dropPage } from "@/lib/sales-page-store";
import { dropThanksNote } from "@/lib/thanks-note-store";
import { dropReviews } from "@/lib/reviews";
import { guardStoreWrite, text } from "@/lib/store-request";
import { dropCourse, filesInCourse, readCourse } from "@/lib/course";
import { exampleTitlesLeft } from "@/lib/course-templates";
import { dropStream } from "@/lib/stream";
import { dropStamped } from "@/lib/pdf-stamp";
import { idsOfKind, readAllListings, readListing, readProducts } from "@/lib/catalog";
import { fastMoneyOnPage, fastMoneyRefusal } from "@/lib/terms-check-rules";
import { pageWords } from "@/lib/page-translate";
import { readPage } from "@/lib/sales-page-store";
import { quietedBy } from "@/lib/extras-notes";

const ACTIONS = new Set(["add", "edit", "remove", "move", "link", "unlink", "visibility"]);

/** What one change came to: the product as saved, when there is one to show. */
type Outcome =
  | { ok: true; product: Product | null }
  | { ok: false; reason: string; limit?: number; pwyw?: string };

/**
 * What a saved change has just stopped buyers being shown.
 *
 * A price cut on one product silences every checkout box and after-paying offer
 * that charged more for it than it now costs, on products the creator is not
 * looking at. Raise a price and the payment plan that used to cover it stops
 * being offered. All of that was already true and none of it was said; the
 * creator found out from the takings. Now the save says it.
 *
 * Only the products that carry a funnel are read in full — the catalog knows
 * which those are — so a store with two thousand products does not read two
 * thousand records to answer one price change.
 */
async function silenced(email: string, changedId: string): Promise<string[]> {
  try {
    const store = await storeForEmail(email);
    if (!store) return [];
    /*
     * This one still reads the catalogue, and deliberately.
     *
     * Which products a change has silenced can only be answered by looking at
     * every product that could refer to the changed one, and "has a bump" and
     * "has a payment plan" are not in the index. Narrowing it would mean
     * sometimes failing to tell a creator that their change just turned
     * something off — a correctness answer traded for a cost that is not
     * really there, because unlike a page this runs when a product is saved,
     * which happens a few times a day rather than a few times a minute.
     */
    const all = await readAllListings(store);
    const deep = new Set([...idsOfKind(store, "funnel"), changedId]);
    const full = await readProducts(store, deep);
    // Every product as something with a funnel field: the ones read in full as
    // they are, the rest as their listing with no funnel on it.
    const byId = new Map(full.map((p) => [p.id, p]));
    const products: Product[] = all.map(
      (listing) => byId.get(listing.id) ?? ({ ...listing, fields: [], funnel: null } as Product),
    );
    return quietedBy(changedId, products, all, store.currency);
  } catch (error) {
    // A change is never refused because this could not be worked out.
    console.error("could not work out what a change silenced", error);
    return [];
  }
}

/** How firmly to answer when a change is refused. */
const STATUS: Record<string, number> = {
  too_many: 409,
  unknown: 404,
};

/**
 * The file setters can also fail with "invalid", which describes a pathname
 * rather than a product. Nothing on this path can produce it, and answering
 * with a word the caller has never seen would be worse than "unknown".
 */
function asProductReason(
  reason: "none" | "unknown" | "invalid" | "call" | "course" | "bundle" | "shipped",
): "none" | "unknown" | "call" | "course" | "bundle" | "shipped" {
  return reason === "invalid" ? "unknown" : reason;
}

/**
 * The long description of one of the signed-in creator's products, read when
 * they open it to edit. `?about=<product id>`.
 */
export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "products");
  if (access instanceof Response) return access;
  const id = request.nextUrl.searchParams.get("about") ?? "";
  try {
    const store = access.store;
    const product = await readListing(store, id);
    if (!store || !product) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
    const about = product.about ? await readAbout(store.statsId, product.id) : "";
    return Response.json({ ok: true, about }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("reading a description failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}

/** Adds, changes, reorders or removes one thing on the creator's store. */
export async function POST(request: NextRequest) {
  // Room for the long description, which is the one big thing sent here.
  const guarded = await guardStoreWrite(request, "products", 40_000);
  if (!guarded.ok) return guarded.response;

  const { ref, body } = guarded;
  const action = text(body.action, 10);
  if (!ACTIONS.has(action)) {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }

  const id = text(body.id, 40);
  const title = text(body.title, MAX_TITLE_LENGTH);
  const summary = text(body.summary, MAX_SUMMARY_LENGTH);
  const price = text(body.price, 20);
  // One past the length kept, so a longer link is refused as too long rather than cut and kept broken.
  const link = text(body.link, MAX_LINK_LENGTH + 1);
  // Absent or unrecognised means a single sale, which is what a product is
  // unless the creator says otherwise. A trial or a payment count that was
  // typed and is not a whole number in range is said, not dropped.
  const recurring = readRecurring(text(body.every, 10), body.trial, body.payments);
  if (recurring === "trial" || recurring === "payments") {
    return Response.json({ ok: false, error: recurring }, { status: 400 });
  }
  // The suggested price, when the buyer chooses what to pay, as typed: it is
  // read in the store's own currency when the product is saved. Absent means
  // the price is the price.
  const suggested =
    body.pwyw !== undefined && body.pwyw !== null && body.pwyw !== false ? text(body.pwyw, 20) : null;
  // Only written when it was sent, so an older screen never wipes it.
  const about = typeof body.about === "string" ? cleanAbout(body.about.slice(0, MAX_ABOUT_LENGTH * 2)) : null;

  if (action !== "add" && !id) {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }

  // What the Terms forbid ("anything that promises fast or easy money, or income
  // for little effort") is not published (567 [GD1] (d)): a new product, which
  // is on the store at once, and a published one, are refused with the passage,
  // why and the fix. A draft may be saved with it; it is checked again when it
  // is published, below. The creator's words are never changed for them.
  if (action === "add" || action === "edit") {
    // A product that cannot be read is taken as published: a failed read never lets words through.
    const published = action === "add" || (await readListing(guarded.store, id).catch(() => null))?.hidden !== true;
    const refused = published ? fastMoneyRefusal({ title, summary, about: about ?? "" }) : null;
    if (refused) return Response.json({ ok: false, error: "fast_money", passage: refused }, { status: 409 });
  }

  // A membership's introductory price (lib/intro-price.ts) and its yearly
  // price (lib/yearly-price.ts), each only written when it was sent, so an
  // older screen never wipes it. Checked before anything is saved, against the
  // product as this save will leave it — both together, since only one of the
  // two may be offered — so a product is never saved with half of what the
  // creator asked for.
  let intro: Intro | null | undefined;
  let yearly: Yearly | null | undefined;
  if ((action === "add" || action === "edit") && ("intro" in body || "yearly" in body)) {
    const store = guarded.store;
    const typedOf = (raw: unknown) => (raw && typeof raw === "object" ? text((raw as Record<string, unknown>).price, 20).trim() : "");
    if ("intro" in body) {
      const typed = typedOf(body.intro);
      if (!typed) intro = null;
      else {
        const cents = readMoney(typed, store.currency);
        const count = Number((body.intro as Record<string, unknown>).count ?? 1);
        if (cents === null || !recurring) return Response.json({ ok: false, error: recurring ? "intro_price" : "intro_membership" }, { status: 400 });
        intro = { cents, count: Number.isInteger(count) ? count : 0 };
      }
    }
    if ("yearly" in body) {
      const typed = typedOf(body.yearly);
      if (!typed) yearly = null;
      else {
        const cents = readMoney(typed, store.currency);
        if (cents === null || !recurring) return Response.json({ ok: false, error: recurring ? "yearly_price" : "yearly_membership" }, { status: 400 });
        yearly = { cents };
      }
    }
    const current = action === "edit" ? await readListing(store, id) : null;
    const after = {
      id: current?.id ?? "",
      priceCents: readMoney(price, store.currency) ?? 0,
      recurring,
      options: current?.options ?? [],
      pwyw: suggested,
      intro: intro === undefined ? (current?.intro ?? null) : intro,
      yearly: yearly === undefined ? (current?.yearly ?? null) : yearly,
    };
    const min = priceBounds(store.currency).min;
    if (after.intro) {
      const problem = introProblem(after, after.intro, min, store.tiers);
      if (problem) return Response.json({ ok: false, error: `intro_${problem}` }, { status: 400 });
    }
    if (after.yearly) {
      const problem = yearlyProblem(after, after.yearly, min, store.tiers);
      if (problem) return Response.json({ ok: false, error: `yearly_${problem}` }, { status: 400 });
    }
  }

  try {
    let result: Outcome;
    if (action === "add" || action === "edit") {
      const done =
        action === "add"
          ? await addProduct(ref, title, summary, price, recurring, suggested)
          : await editProduct(ref, id, title, summary, price, recurring, suggested);
      result = done.ok ? { ok: true, product: done.product } : done;
      // What is taken off goes first, so the one put on in its place is never refused for the other.
      const steps: (() => Promise<{ ok: true; product: Product } | { ok: false; reason: string }>)[] = [];
      if (done.ok) {
        const productId = done.product.id;
        const introStep = intro !== undefined && (intro !== null || done.product.intro) ? () => setProductIntro(ref, productId, intro ?? null) : null;
        const yearlyStep = yearly !== undefined && (yearly !== null || done.product.yearly) ? () => setProductYearly(ref, productId, yearly ?? null) : null;
        if (introStep && intro === null) steps.push(introStep);
        if (yearlyStep && yearly === null) steps.push(yearlyStep);
        if (introStep && intro !== null) steps.push(introStep);
        if (yearlyStep && yearly !== null) steps.push(yearlyStep);
      }
      for (const step of steps) {
        if (!result.ok) break;
        const priced = await step();
        result = priced.ok ? { ok: true, product: priced.product } : { ok: false, reason: priced.reason };
      }
      if (result.ok && result.product && about !== null) {
        const saved = result.product;
        if (about !== "" || saved.about) {
          const marked = await setProductAbout(ref, saved.id, about !== "");
          if (marked.ok && marked.store.statsId) {
            await writeAbout(marked.store.statsId, saved.id, about, marked.store);
            result = { ok: true, product: marked.product };
          }
        }
      }
    } else if (action === "remove") {
      // Paid pre-orders wait for it (lib/preorders.ts): it stays until they
      // are handed over or refunded, so nobody paid for something deleted.
      if ((await waitingCount(guarded.store, id)) > 0) {
        return Response.json({ ok: false, error: "preorders" }, { status: 409 });
      }
      // The product comes back as it was, so the storage its files used can
      // be released once the removal is safely written. A product with price
      // options holds one file per option as well as its own.
      const removed = await removeProduct(ref, id);
      result = removed.ok ? { ok: true, product: null } : removed;
      if (removed.ok) {
        const going = removed.product;
        const had: { pathname: string }[] = filesOnProduct(going);
        // Its picture goes with it, and so does its long description.
        had.push(...imagePaths(going.image).map((pathname) => ({ pathname })));
        // A course takes its lessons with it: their records, and their files.
        const course = going.course ? await readCourse(going.course.id).catch(() => null) : null;
        if (course) had.push(...filesInCourse(course));
        // And the work its students handed in for its assignments (lib/assignment.ts).
        if (course) {
          const handed = await dropCourseTasks(course, storeKey(removed.store), removed.store).catch(() => [] as string[]);
          had.push(...handed.map((pathname) => ({ pathname })));
        }
        if (going.about) await dropAbout(removed.store.statsId, id, removed.store).catch(() => {});
        if (going.note) await dropThanksNote(removed.store.statsId, id, removed.store).catch(() => {});
        // Its page of blocks, and the reviews of a product nobody can buy any more.
        if (going.page) {
          // And the pictures on that page (lib/sales-page-store.ts).
          const pictures = await dropPage(removed.store.statsId, id, removed.store).catch(() => [] as string[]);
          had.push(...pictures.map((pathname) => ({ pathname })));
        }
        // And the photos buyers added to them (lib/reviews.ts).
        const reviewPhotos = await dropReviews(removed.store.statsId, id).catch(() => [] as string[]);
        had.push(...reviewPhotos.map((pathname) => ({ pathname })));
        if (course) await dropCourse(course, removed.store).catch((error: unknown) => console.error("could not drop a removed course", error));
        for (const file of had) {
          // A lesson video the video service keeps is taken away there (lib/stream.ts).
          if (await dropStream(file.pathname, removed.store).catch(() => false)) continue;
          await del(file.pathname).catch((error: unknown) => {
            console.error("could not delete the file of a removed product", error);
          });
        }
        for (const file of filesOnProduct(going)) await dropStamped(file);
      }
    } else if (action === "link") {
      // The link is checked before anything is written, so a product is never
      // left pointing at something a buyer could not open.
      const read = readLink(link);
      if (!read.ok) {
        return Response.json(
          { ok: false, error: "link", reason: read.reason },
          { status: 400 },
        );
      }
      // Pointing at a link displaces any file that was there. The storage is
      // released only after the record that pointed at it is written.
      const linked = await setProductLink(ref, id, read.url);
      if (linked.ok && linked.removed) {
        await del(linked.removed.pathname).catch((error: unknown) => {
          console.error("could not delete a file replaced by a link", error);
        });
        await dropStamped(linked.removed);
      }
      result = linked.ok ? { ok: true, product: null } : { ok: false, reason: asProductReason(linked.reason) };
    } else if (action === "visibility") {
      // A draft published, or a product taken off the store and kept.
      if (typeof body.hidden !== "boolean") return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      if (body.hidden === false) {
        // Published only when nothing a buyer reads promises fast or easy money (the Terms; 567 [GD1] (d)).
        const draft = await readListing(guarded.store, id);
        if (draft) {
          const words = draft.about && guarded.store.statsId ? await readAbout(guarded.store.statsId, draft.id) : "";
          const shownPage = draft.page && guarded.store.statsId ? await readPage(guarded.store.statsId, draft.id) : null;
          const refused = fastMoneyRefusal({ title: draft.title, summary: draft.summary, about: words }) ?? (shownPage ? fastMoneyOnPage(pageWords(shownPage)) : null);
          if (refused) return Response.json({ ok: false, error: "fast_money", passage: { ...refused, product: draft.title } }, { status: 409 });
          // A course from a ready structure is published only once its example titles are replaced (540 [CU1]).
          if (draft.course) {
            const course = await readCourse(draft.course.id);
            if (!course) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
            if (exampleTitlesLeft(course) > 0) return Response.json({ ok: false, error: "course_examples" }, { status: 409 });
          }
        }
      }
      const done = await setProductHidden(ref, id, body.hidden);
      result = done.ok ? { ok: true, product: done.product } : done;
    } else if (action === "unlink") {
      const cleared = await setProductLink(ref, id, null);
      result = cleared.ok ? { ok: true, product: null } : { ok: false, reason: asProductReason(cleared.reason) };
    } else {
      const direction =
        body.direction === "up" || body.direction === "top" || body.direction === "bottom" ? body.direction : "down";
      const moved = await moveProduct(ref, id, direction);
      result = moved.ok ? { ok: true, product: null } : moved;
    }

    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.reason, limit: result.limit, pwyw: result.pwyw },
        { status: STATUS[result.reason] ?? 400 },
      );
    }
    // Said only where something can actually have been silenced: a price, a
    // shape, or a product going off the store (its own id changes nothing, but
    // everything that offered it does).
    const quiet =
      (action === "edit" || action === "visibility" || action === "remove") && id ? await silenced(ref, id) : [];
    return Response.json({ ok: true, product: result.product, quiet: quiet.length ? quiet : undefined });
  } catch (error) {
    if (error instanceof StoreFullError) {
      return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    }
    console.error("changing a product failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
