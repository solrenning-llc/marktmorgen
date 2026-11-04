/**
 * What a key that may write (lib/api-keys.ts) can change, and nothing more
 * (added 12 October 2026). The same rules as the studio's own doors, so a
 * creator's tool can never do through the API what the studio would refuse:
 *
 *   - Adding somebody to the list only with the caller's word, in the
 *     request itself, that they agreed to hear from the creator, as an
 *     import asks; never anybody who unsubscribed here, whatever the caller
 *     says. Somebody new starts the sequences a new subscriber starts.
 *   - Changing labels only of somebody already on the list; a label added
 *     starts the sequences that label starts, as in the studio.
 *   - Giving a product as an import gives one (lib/imported-purchases.ts):
 *     a file, a link, a course, a podcast or a bundle, never a membership, a
 *     call or one of several prices. It is shown to the buyer as given by
 *     the store, never as a sale, and only what the API gave is taken back
 *     through it.
 *   - The one email to say so, when asked, from the store's name, inside the
 *     same thirty-day allowance as an import's emails, and only while the
 *     store's plan is running.
 *
 * Each store may add GIVES_PER_DAY products and ADDS_PER_DAY new people a
 * day through the API: far more than a sync needs, and a wall for a loop.
 */
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { type Store, ensureListId, ensureStatsId, setPastBuyers, storeRef } from "@/lib/store";
import { readCards, readListing, readListings } from "@/lib/catalog";
import { deliverableItems } from "@/lib/bundle-rules";
import { MAX_CONTACT_NAME, changeLabels, importContactRows, leadsKey, parseContact, readTags } from "@/lib/contacts";
import { enroll } from "@/lib/flows";
import { grantImported, importedFor, takeGiven } from "@/lib/imported-purchases";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { releaseDay, reserveDay } from "@/lib/mail";
import { pausedFor } from "@/lib/mail-health";
import { isPaidUp } from "@/lib/billing";
import { reserveMoved } from "@/lib/imports";
import { storeBase } from "@/lib/purchase-email";
import { accessWords } from "@/lib/buyer-words/access";
import { redisPipeline } from "@/lib/redis";
import { withinLimit } from "@/lib/request-guard";
import { takeAllowance } from "@/lib/store-allowance";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { API_WRITE_UNITS } from "@/lib/store-allowance-rules";
import { DataRoomError } from "@/lib/store-data";

export const ADDS_PER_DAY = 2_000;
export const GIVES_PER_DAY = 1_000;

export type WriteError =
  | "email"
  | "consent"
  | "unsubscribed"
  | "list_full"
  | "not_on_list"
  | "labels"
  | "unknown_product"
  | "ambiguous_product"
  | "cannot_give"
  | "nothing_to_give"
  | "not_given_here"
  | "cannot_email"
  | "daily_limit"
  | "monthly_limit"
  | "no_place"
  | "store_full"
  | "unavailable";

// `message`, when given, is said instead of the code's fixed words: the store's own figure, in its own window.
type Done<T> = { ok: true; value: T } | { ok: false; error: WriteError; message?: string };

const fail = <T>(error: WriteError, message?: string): Done<T> => (message ? { ok: false, error, message } : { ok: false, error });

/** A refusal of the store's API figure, said as lib/api-guard.ts says it: used, no place this month, or not counted. */
export const refusedFigure = <T>(taken: { reason: "used" | "pool" | "unknown"; message: string }): Done<T> =>
  taken.reason === "used" ? fail("monthly_limit", taken.message) : taken.reason === "pool" ? fail("no_place", taken.message) : fail("unavailable");

function readEmail(raw: unknown): string {
  const email = normaliseEmail(typeof raw === "string" ? raw : "");
  return email && email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email) ? email : "";
}

function readLabels(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string")) return null;
  return readTags(raw as string[]);
}

/**
 * Whether a labels request adds any label (232 [CA1] unit 4c): one that only
 * removes labels creates no enrollment and stays open while a plan is unpaid
 * or disputed; an `add` that cannot be read counts as adding.
 */
export function addsLabels(body: Record<string, unknown>): boolean {
  const add = readLabels(body.add);
  return add === null || add.length > 0;
}

/** Adds somebody who agreed to hear from the creator to the list; "already" when they are on it agreeing. */
export async function addLead(store: Store, body: Record<string, unknown>): Promise<Done<{ email: string; status: "added" | "already" }>> {
  const email = readEmail(body.email);
  if (!email) return fail("email");
  if (body.agreed !== true) return fail("consent");
  const tags = readLabels(body.tags);
  if (!tags) return fail("labels");
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return fail("unavailable");
  const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim().slice(0, MAX_CONTACT_NAME) : "";
  const listId = store.listId ?? (await ensureListId(storeRef(store)))?.listId;
  if (!listId) return fail("list_full");
  const [before] = await redisPipeline([["HGET", leadsKey(listId), email]]);
  const had = parseContact(before);
  if (!had && !(await withinLimit("api-add", store.sid ?? store.handle, ADDS_PER_DAY, 86_400))) return fail("daily_limit");
  // A contact written is API_WRITE_UNITS of the window's API requests, the request itself one of them.
  if (!had) {
    // Used, or not counted just now (no place this month, or the database did not answer): said as each is.
    const taken = await takeAllowance(store, "api", API_WRITE_UNITS - 1);
    if (!taken.ok) return refusedFigure(taken);
  }
  const [outcome] = await importContactRows(listId, [{ email, name, tags }], store);
  if (outcome === "left") return fail("unsubscribed");
  if (outcome === "full") return fail("list_full");
  const fresh = { ...store, listId };
  if (outcome === "added") await enroll(fresh, email, { joined: true });
  for (const tag of tags.filter((t) => !had?.tags.some((h) => h.toLowerCase() === t.toLowerCase()))) {
    await enroll(fresh, email, { joined: false, tag });
  }
  return { ok: true, value: { email, status: outcome === "added" ? "added" : "already" } };
}

/** Adds and takes away labels of somebody on the list. */
export async function changeLeadLabels(store: Store, body: Record<string, unknown>): Promise<Done<{ email: string; labels: string[] }>> {
  const email = readEmail(body.email);
  if (!email) return fail("email");
  const add = readLabels(body.add);
  const remove = readLabels(body.remove);
  if (!add || !remove || (!add.length && !remove.length)) return fail("labels");
  // Removing existing labels creates no enrollment; keep this cleanup path available.
  if (add.length > 0 && store.period?.funded === true && !(await reservePaidResourceWindow(store))) return fail("unavailable");
  if (!store.listId) return fail("not_on_list");
  const [raw] = await redisPipeline([["HGET", leadsKey(store.listId), email]]);
  const before = parseContact(raw);
  if (!before) return fail("not_on_list");
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  let after = before.tags;
  await changeLabels(store.listId, [email], (tags) => {
    const kept = tags.filter((t) => !remove.some((r) => same(r, t)));
    const next = readTags([...kept, ...add.filter((a) => !kept.some((k) => same(k, a)))]);
    after = next;
    return next.length === tags.length && next.every((t, i) => same(t, tags[i])) ? "same" : next;
  }, store);
  for (const tag of add.filter((a) => !before.tags.some((t) => same(t, a)) && after.some((t) => same(t, a)))) {
    await enroll(store, email, { joined: false, tag });
  }
  return { ok: true, value: { email, labels: after } };
}

/**
 * The product a request names, by its id or its exact name: the names are
 * one read for the whole store (readCards), and then only the product named,
 * and for a bundle the products in it, are read. An API call never costs a
 * read per product in the store.
 */
async function productFor(store: Store, raw: unknown) {
  const asked = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  if (!asked) return { error: "unknown_product" as const };
  const byId = await readListing(store, asked);
  let product = byId;
  if (!product) {
    const named = [...(await readCards(store)).values()].filter((c) => c.title.replace(/\s+/g, " ").trim().toLowerCase() === asked.toLowerCase());
    if (named.length > 1) return { error: "ambiguous_product" as const };
    product = named.length ? await readListing(store, named[0].id) : null;
  }
  if (!product) return { error: "unknown_product" as const };
  const listings = product.bundle?.length ? await readListings(store, product.bundle) : [];
  return { product, listings };
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function senderAddress(): string {
  const match = NIMBUS_FROM.match(/<([^>]+)>/);
  return (match ? match[1] : NIMBUS_FROM).trim();
}

/**
 * Gives a product to an address, with no payment, as an import gives one.
 * "already" when that address has it given already; the email, when asked
 * for, goes only with a new one.
 */
export async function giveAccess(
  store: Store,
  keyId: string,
  body: Record<string, unknown>,
): Promise<Done<{ email: string; product: string; status: "given" | "already"; emailed: boolean }>> {
  const email = readEmail(body.email);
  if (!email) return fail("email");
  const found = await productFor(store, body.product);
  if ("error" in found) return fail(found.error ?? "unknown_product");
  const { product, listings } = found;
  // The same as an import of past buyers can give (lib/imports.ts).
  if (product.recurring || product.call) return fail("cannot_give");
  if (product.options.length > 0 && !product.course && !product.podcast) return fail("cannot_give");
  const items = product.bundle ? deliverableItems(product, listings).map((p) => p.id) : null;
  if (!(product.course || product.podcast || product.file || product.link || (items && items.length > 0))) return fail("nothing_to_give");
  const notify = body.notify === true;
  if (notify && (!isSenderConfigured() || !isPaidUp(store))) return fail("cannot_email");

  if (store.period?.funded === true && !store.statsId) return fail("unavailable");
  const statsId = store.statsId ?? (await ensureStatsId(storeRef(store)))?.statsId;
  if (!statsId || !store.sid) return fail("nothing_to_give");
  const already = (await importedFor({ ...store, statsId, pastBuyers: true }, email)).some((p) => p.productId === product.id);
  if (already) return { ok: true, value: { email, product: product.id, status: "already", emailed: false } };
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return fail("unavailable");
  if (!(await withinLimit("api-give", store.sid, GIVES_PER_DAY, 86_400))) return fail("daily_limit");
  const taken = await takeAllowance(store, "api", API_WRITE_UNITS - 1);
  if (!taken.ok) return refusedFigure(taken);
  const [isNew] = await grantImported(statsId, `api:${keyId}`, [{ email, productId: product.id, items }], undefined, store.sid, store);
  if (!store.pastBuyers) await setPastBuyers(storeRef(store));
  if (!isNew) return { ok: true, value: { email, product: product.id, status: "already", emailed: false } };

  let emailed = false;
  if (notify && !(await pausedFor(store.sid)) && (await reserveDay(1))) {
    if ((await reserveMoved(store, 1)) < 1) await releaseDay(1);
    else {
      const a = accessWords(store.language);
      const base = storeBase(store);
      const text = [
        a.given(store.name, product.title),
        "",
        ...(product.course ? [a.startCourse(`${base}/course/${product.id}`), ""] : []),
        a.openOrders(`${base}/orders`, email, store.name),
        "",
        a.why(store.name),
        a.sentBy(store.name),
      ].join("\n");
      emailed = await sendEmail({ meter: { by: "monthly" },
        from: `"${store.name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 60) || "A store"} via Marktmorgen" <${senderAddress()}>`,
        to: email,
        subject: a.subject(product.title, store.name).slice(0, 200),
        text,
        html: `<div style="font-family:system-ui,sans-serif;line-height:1.5">${text
          .split("\n\n")
          .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
          .join("")}</div>`,
        replyTo: store.email,
      });
    }
  }
  return { ok: true, value: { email, product: product.id, status: "given", emailed } };
}

/** Takes back a product the API gave. Anything else (a sale, an import, a gift) is not the API's to take. */
export async function takeAccess(store: Store, body: Record<string, unknown>): Promise<Done<{ email: string; product: string }>> {
  const email = readEmail(body.email);
  if (!email) return fail("email");
  const found = await productFor(store, body.product);
  if ("error" in found) return fail(found.error ?? "unknown_product");
  if (!store.statsId) return fail("not_given_here");
  const taken = await takeGiven(store.statsId, email, found.product.id, "api:", store);
  return taken ? { ok: true, value: { email, product: found.product.id } } : fail("not_given_here");
}

/** What each refusal says, and its status, as the API answers it. */
export const WRITE_ERRORS: Record<WriteError, [number, string]> = {
  unavailable: [503, "The store could not make this change just now. Try again in a moment."],
  email: [400, "Send email: an address."],
  consent: [400, "Send agreed: true, your word that this person agreed to hear from you. Nobody is added without it."],
  unsubscribed: [409, "This person unsubscribed from your list, so they are not added back."],
  list_full: [409, "Your list is full."],
  not_on_list: [404, "Nobody with this address is on your list."],
  labels: [400, "Send labels as a list of words: add, remove, or both."],
  unknown_product: [404, "No product in your store has this id or name."],
  ambiguous_product: [409, "Several products have this name: send the product's id instead."],
  cannot_give: [409, "Memberships, calls and products with several prices cannot be given this way."],
  nothing_to_give: [409, "This product has nothing to hand over yet: add its file, link or lessons first."],
  not_given_here: [404, "This address was not given this product through the API, so the API cannot take it back."],
  cannot_email: [409, "Emailing needs your store's plan to be active. Send notify: false, or start your plan."],
  daily_limit: [429, "That is as many as a store may add in a day through the API. Try again tomorrow."],
  // Said with the store's own words when the write has them (refusedFigure); these are only the fallback.
  monthly_limit: [429, `Your store's API requests are used (each contact added or product given counts as ${API_WRITE_UNITS}).`],
  no_place: [429, "Stores without a paid plan are full for this month, so this can't run right now."],
  store_full: [409, "Your store's data room is full, so nothing was added. Delete something you no longer need, such as old posts, drafts, pages or contacts."],
};

/** A write the store's data room did not fit (lib/store-data.ts) is said as one, not as a failure to try again. */
export async function roomFor<T>(work: () => Promise<Done<T>>): Promise<Done<T>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DataRoomError) return fail("store_full");
    throw error;
  }
}
