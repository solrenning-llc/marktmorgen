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
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { deliverableItems } from "@/lib/bundle-rules";
import { MAX_CONTACT_NAME, changeLabels, importContactRows, leadsKey, parseContact, readTags } from "@/lib/contacts";
import { enroll } from "@/lib/flows";
import { grantUnlessErased, importedFor, takeGiven } from "@/lib/imported-purchases";
import { suppressedAmong, suppressedKey, suppressionPrint } from "@/lib/suppression";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { mailDay, releaseDay, reserveDay } from "@/lib/mail";
import { pauseForSending } from "@/lib/mail-health";
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
import { emailDocument, emailParagraphs } from "@/lib/email-document";
import { createHash } from "node:crypto";

export const ADDS_PER_DAY = 2_000;
export const GIVES_PER_DAY = 1_000;

/**
 * What an API write still owes after the write itself went through (defects #3979, #4035 and #4077): the sequences a
 * contact added or a label added starts, and the access email a product given with `notify: true` sends. Written
 * before the write, cleared once the follow-up is done, so a retry of the same request after a lost reply or a failed
 * start finishes it, once (a sequence's start is claimed per person and sequence, lib/flows.ts startFlows; the email
 * is claimed by the one DEL that removes this note). Named by a one-way hash of the address, never the address, and
 * gone by itself after OWE_SECONDS.
 *
 *   nl:api:owe:<listId>:<hash>     JSON { j: joined, t: labels } for a contact on the list
 *   nl:api:owe:<statsId>:<hash>    "1": the access email of one product given to one address
 */
export const OWE_SECONDS = 86_400;
const oweKey = (scope: string, what: string) => `nl:api:owe:${scope}:${createHash("sha256").update(`nimbus-api-owe:${scope}:${what}`).digest("hex").slice(0, 32)}`;
/**
 * The commands one API request sends for its note at the most: the note read with the contact (one GET), written
 * before the write (one SET) and cleared after it (one DEL), or for a product given written (SET) and claimed (DEL).
 * Priced, with one more sequence check (a label request that also finishes a contact's owed "joined"), on every API
 * request of each plan (tests/plan-cost-registry.ts, line api-write-owed; tests/api-write-follow-up-cost.test.ts).
 */
export const OWE_COMMANDS = 3;

type Owed = { joined: boolean; tags: string[] };

/** A contact's owed moments, read exactly: nil is none; anything else that is not the note's shape is unknown (null). */
function readOwed(raw: unknown): Owed | null {
  if (raw === null) return { joined: false, tags: [] };
  if (typeof raw !== "string" || raw.length > 4_096) return null;
  try {
    const value = JSON.parse(raw) as { j?: unknown; t?: unknown };
    if (!value || typeof value !== "object" || typeof value.j !== "boolean" || !Array.isArray(value.t) || value.t.some((t) => typeof t !== "string")) return null;
    return { joined: value.j, tags: value.t as string[] };
  } catch {
    return null;
  }
}

const sameLabel = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const unionLabels = (a: string[], b: string[]) => [...a, ...b.filter((t) => !a.some((h) => sameLabel(h, t)))];

/** Writes a contact's owed moments before the write that makes them; only exactly "OK" lets the write go on. */
async function noteOwed(key: string, owed: Owed): Promise<boolean> {
  const [reply] = await redisPipeline([["SET", key, JSON.stringify({ j: owed.joined, t: owed.tags }), "EX", OWE_SECONDS]]);
  return reply === "OK";
}

/**
 * Starts what a contact is owed, each moment once: "joined" and each label still on the contact (`labels`). The note
 * goes only when every start went through; otherwise it stays, and the request says to try again.
 */
async function settleOwed(store: Store, email: string, key: string, owed: Owed, labels: string[]): Promise<boolean> {
  let ok = true;
  if (owed.joined && !(await enroll(store, email, { joined: true }))) ok = false;
  for (const tag of owed.tags.filter((t) => labels.some((l) => sameLabel(l, t)))) {
    if (!(await enroll(store, email, { joined: false, tag }))) ok = false;
  }
  if (ok) await redisPipeline([["DEL", key]]);
  return ok;
}

export type WriteError =
  | "email"
  | "consent"
  | "unsubscribed"
  | "deleted"
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
  // The contact and what an earlier try of a write still owes them, read together (#3979, #4077).
  const owe = oweKey(listId, email);
  const [before, owedRaw] = await redisPipeline([["HGET", leadsKey(listId), email], ["GET", owe]]);
  const had = parseContact(before);
  const earlier = readOwed(owedRaw);
  if (!earlier) return fail("unavailable");
  if (!had && !(await withinLimit("api-add", store.sid ?? store.handle, ADDS_PER_DAY, 86_400))) return fail("daily_limit");
  // A contact written is API_WRITE_UNITS of the window's API requests, the request itself one of them.
  if (!had) {
    // Used, or not counted just now (no place this month, or the database did not answer): said as each is.
    const taken = await takeAllowance(store, "api", API_WRITE_UNITS - 1);
    if (!taken.ok) return refusedFigure(taken);
  }
  // What this write starts, noted before it is written, beside what an earlier try still owes: a lost reply or a
  // failed start then leaves the note, and the retry, which finds the contact already there, starts it.
  const fresh = tags.filter((t) => !had?.tags.some((h) => sameLabel(h, t)));
  const owed: Owed = { joined: earlier.joined || !had, tags: unionLabels(earlier.tags.filter((t) => had?.tags.some((h) => sameLabel(h, t))), fresh) };
  const noted = earlier.joined || earlier.tags.length > 0;
  if ((owed.joined && !earlier.joined) || fresh.length > 0) {
    if (!(await noteOwed(owe, owed))) return fail("unavailable");
  } else if (!noted) {
    // Nothing owed and nothing new: the write alone, as before.
    const [outcome] = await importContactRows(listId, [{ email, name, tags }], store);
    if (outcome === "left") return fail("unsubscribed");
    if (outcome === "full") return fail("list_full");
    return { ok: true, value: { email, status: outcome === "added" ? "added" : "already" } };
  }
  const [outcome] = await importContactRows(listId, [{ email, name, tags }], store);
  if (outcome === "left" || outcome === "full") {
    // Not on the list, or no longer agreeing: nothing can start, and nothing is owed.
    await redisPipeline([["DEL", owe]]);
    return fail(outcome === "left" ? "unsubscribed" : "list_full");
  }
  // "joined" only for somebody this write or an earlier try of it added; never for somebody already there.
  const due: Owed = { joined: outcome === "added" || earlier.joined, tags: owed.tags };
  const labels = unionLabels(had?.tags ?? [], tags);
  if (!(await settleOwed({ ...store, listId }, email, owe, due, labels))) return fail("unavailable");
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
  // A request that only takes labels away starts nothing and stays open while a plan is unpaid (addsLabels): it reads
  // no note and finishes nothing an earlier try owes.
  const owe = oweKey(store.listId, email);
  const [raw, owedRaw] = add.length > 0 ? await redisPipeline([["HGET", leadsKey(store.listId), email], ["GET", owe]]) : [...(await redisPipeline([["HGET", leadsKey(store.listId), email]])), null];
  const before = parseContact(raw);
  if (!before) return fail("not_on_list");
  const earlier = readOwed(owedRaw);
  if (!earlier) return fail("unavailable");
  const same = sameLabel;
  // Each label this request adds, noted before it is written beside what an earlier try owes (#3979, #4077).
  const fresh = add.filter((a) => !before.tags.some((t) => same(t, a)));
  const owed: Owed = { joined: earlier.joined, tags: unionLabels(earlier.tags.filter((t) => before.tags.some((h) => same(h, t))), fresh) };
  if (fresh.length > 0 && !(await noteOwed(owe, owed))) return fail("unavailable");
  let after = before.tags;
  await changeLabels(store.listId, [email], (tags) => {
    const kept = tags.filter((t) => !remove.some((r) => same(r, t)));
    const next = readTags([...kept, ...add.filter((a) => !kept.some((k) => same(k, a)))]);
    after = next;
    return next.length === tags.length && next.every((t, i) => same(t, tags[i])) ? "same" : next;
  }, store);
  if ((owed.joined || owed.tags.length > 0) && !(await settleOwed(store, email, owe, owed, after))) return fail("unavailable");
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

/** The access email as a whole HTML document beside its text, in the store's language, its subject as the title (AX274 Part A, item 5). */
export function givenEmailHtml(store: Pick<Store, "language">, subject: string, text: string): string {
  return emailDocument({ lang: LANGUAGES[parseLanguage(store.language)].locale, title: subject, body: emailParagraphs(text) });
}


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
  // Nobody deleted from the store is given anything again or emailed ("no import or API call puts them back"). Read
  // whole (CX-123 rule 24): an unknown reply refuses, never taking them as not deleted. A store with no list yet is
  // given one, as a deletion gives one, so the grant below is checked where it is written.
  const listId = store.listId ?? (await ensureListId(storeRef(store)))?.listId;
  if (!listId) return fail("unavailable");
  const notDeleted = async () => {
    const deleted = await suppressedAmong(listId, [email]).catch(() => null);
    return deleted ? deleted.size === 0 : null;
  };
  const before = await notDeleted();
  if (before === null) return fail("unavailable");
  if (!before) return fail("deleted");
  // The access email an earlier try of this request still owes (#4035): its gift went through, its answer did not.
  const owe = oweKey(statsId, `${email}\n${product.id}`);
  const already = (await importedFor({ ...store, statsId, pastBuyers: true }, email)).some((p) => p.productId === product.id);
  if (already) {
    // Only the one request whose DEL removes the note sends it: a second retry, or one racing it, sends nothing.
    const emailed = notify && (await claimOwed(owe)) ? await sendGiven(store, product, email, notDeleted) : false;
    return { ok: true, value: { email, product: product.id, status: "already", emailed } };
  }
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return fail("unavailable");
  if (!(await withinLimit("api-give", store.sid, GIVES_PER_DAY, 86_400))) return fail("daily_limit");
  const taken = await takeAllowance(store, "api", API_WRITE_UNITS - 1);
  if (!taken.ok) return refusedFigure(taken);
  // The email asked for, noted before the gift: whatever happens after the gift, a retry finds it owed.
  if (notify) {
    const [noted] = await redisPipeline([["SET", owe, "1", "EX", OWE_SECONDS]]);
    if (noted !== "OK") return fail("unavailable");
  }
  // Checked again where it is written, in the same step (GRANT_UNLESS_ERASED): somebody deleted since gets nothing.
  const answers = await grantUnlessErased(statsId, `api:${keyId}`, [{ email, productId: product.id, items }], { key: suppressedKey(listId), print: (e) => suppressionPrint(listId, e) }, store).catch((error: unknown) => {
    if (error instanceof DataRoomError) throw error;
    return null;
  });
  if (!answers) return fail("unavailable");
  if (answers[0] === "erased") {
    if (notify) await claimOwed(owe);
    return fail("deleted");
  }
  if (!store.pastBuyers) await setPastBuyers(storeRef(store));
  if (answers[0] !== "new") {
    // Given meanwhile by something else: the email goes only with a new one, as before.
    if (notify) await claimOwed(owe);
    return { ok: true, value: { email, product: product.id, status: "already", emailed: false } };
  }
  const emailed = notify && (await claimOwed(owe)) ? await sendGiven(store, product, email, notDeleted) : false;
  return { ok: true, value: { email, product: product.id, status: "given", emailed } };
}

/** Takes the note of an owed email: true only when this DEL removed it (exactly 1), so it is sent once at the most. */
async function claimOwed(key: string): Promise<boolean> {
  const [gone] = await redisPipeline([["DEL", key]]);
  return gone === 1;
}

/** The access email of a product given, inside the store's emails, never to somebody deleted, a paused store or past the day. */
async function sendGiven(store: Store, product: { id: string; title: string; course?: unknown }, email: string, notDeleted: () => Promise<boolean | null>): Promise<boolean> {
  // And just before the email, as an import's emails are: deleted since, or unknown, nothing is sent.
  const day = mailDay();
  // A pause read in an unknown shape is not "no pause" (CX-123 rule 24, Claude 6's MEDIUM on #2687): no email.
  if (!store.sid || (await pauseForSending(store.sid)) !== null || (await notDeleted()) !== true || !(await reserveDay(1, day))) return false;
  if ((await reserveMoved(store, 1)) < 1) {
    await releaseDay(1, day);
    return false;
  }
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
  const subject = a.subject(product.title, store.name).slice(0, 200);
  return await sendEmail({ meter: { by: "monthly" },
    from: `"${store.name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 60) || "A store"} via Marktmorgen" <${senderAddress()}>`,
    to: email,
    subject,
    text,
    html: givenEmailHtml(store, subject, text),
    replyTo: store.email,
  });
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
  deleted: [409, "This person was deleted from your store, so nothing is given to them and they are not emailed."],
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
