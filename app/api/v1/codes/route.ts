import { apiAdder, apiError, apiOk, apiStore, apiWriter, takeMoreApi } from "@/lib/api-guard";
import { apiOkFields, badFields } from "@/lib/api-fields";
import { apiReadUnits, codeMakeWork, codeStopWork, codesWork } from "@/lib/api-read-rules";
import { CODE_FIELDS, codeOut, refusalWords } from "@/lib/api-codes";
import { createCode, findCode, listCodes, stopCode } from "@/lib/discount";
import { readCodeAsked } from "@/lib/discount-input";
import { setHasDiscounts, storeRef, type Store } from "@/lib/store";
import { canSell } from "@/lib/store-checkout";

/**
 * Discount codes on the creator's own Stripe account (lib/api-codes.ts):
 *   GET    /api/v1/codes            the newest page of codes, as the studio lists them, and has_more
 *   POST   /api/v1/codes            { code, percent } or { code, kind: "amount", amount }, with uses and minimum optional
 *   DELETE /api/v1/codes?id=promo_… switches one of this store's codes off
 * Writing needs a key that writes. While the store is not taking payments,
 * 409 not_selling, as in the studio.
 */
const notSelling = () => apiError(409, "not_selling", "This store is not taking payments, so it has no discount codes to use.");
const unreadable = () => apiError(502, "unavailable", "Your discount codes could not be read from Stripe just now. Try again in a moment.");
const selling = (store: Store) => Boolean(store.stripeAccountId) && canSell(store);

export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  if (!selling(store)) return notSelling();
  // A ?fields= that cannot be answered is refused before any further request is taken or anything read.
  const bad = badFields(request, CODE_FIELDS);
  if (bad) return bad;
  // One page of the creator's Stripe account, taken before it is read (lib/api-read-rules.ts, codesWork).
  const refused = await takeMoreApi(store, apiReadUnits(codesWork()));
  if (refused) return refused;
  try {
    const list = await listCodes(store.stripeAccountId as string);
    // has_more: the newest page of codes, with older ones on Stripe behind it (lib/discount.ts, listCodes).
    return list.state === "ok" ? apiOkFields(request, { data: list.codes.map(codeOut), has_more: !list.complete }) : unreadable();
  } catch (error) {
    console.error("api: codes failed", error);
    return unreadable();
  }
}

export async function POST(request: Request) {
  const writer = await apiAdder(request);
  if (writer instanceof Response) return writer;
  const { store, body } = writer;
  if (!selling(store)) return notSelling();
  const read = readCodeAsked(body, store.currency);
  if (!read.ok) return apiError(400, read.reason, refusalWords(read, store.currency));
  const { code, off, maxRedemptions, minimum } = read.asked;
  // Two calls to the creator's Stripe account, taken before either is made (lib/api-read-rules.ts, codeMakeWork).
  const refused = await takeMoreApi(store, apiReadUnits(codeMakeWork()));
  if (refused) return refused;
  try {
    const made = await createCode(store.stripeAccountId as string, code, off, maxRedemptions, minimum);
    if (!made.ok) {
      return made.reason === "taken"
        ? apiError(409, "taken", "Your Stripe account already has a code with these letters. Choose another.")
        : apiError(502, "unavailable", "The code could not be made on Stripe just now. Try again in a moment.");
    }
    await setHasDiscounts(storeRef(store), true);
    return apiOk({ data: codeOut(made.code) });
  } catch (error) {
    console.error("api: making a code failed", error);
    return apiError(502, "unavailable", "The code could not be made on Stripe just now. Try again in a moment.");
  }
}

export async function DELETE(request: Request) {
  const writer = await apiWriter(request);
  if (writer instanceof Response) return writer;
  const { store } = writer;
  if (!selling(store)) return notSelling();
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^promo_[A-Za-z0-9]{1,200}$/.test(id)) return apiError(400, "id", "Give the code's id, from GET /api/v1/codes.");
  // The codes read to find it, the call that switches it off and the codes read again and sent, at their most,
  // taken before Stripe is asked (lib/api-read-rules.ts, codeStopWork).
  const refused = await takeMoreApi(store, apiReadUnits(codeStopWork()));
  if (refused) return refused;
  try {
    const account = store.stripeAccountId as string;
    // Asked for by its id on the store's own Stripe account, the account the
    // list reads, so a code on any page of it is found; only Stripe's "no
    // such code" is a 404, and a lookup it cannot answer switches nothing off.
    const before = await findCode(account, id);
    if (before.state === "error") return unreadable();
    if (before.state === "none") return apiError(404, "not_found", "No discount code of this store has that id.");
    if (!(await stopCode(account, id))) return apiError(502, "unavailable", "The code could not be switched off on Stripe just now. Try again in a moment.");
    // Listed again, so the answer is what Stripe says now; the checkout's box stays only while a code is live.
    const after = await listCodes(account);
    // Switched off on Stripe already: said as done, with the codes not read
    // back as data null (not known, never an empty list), and nothing written from them.
    if (after.state !== "ok") return apiOk({ stopped: id, listed: false, data: null, message: "The code was switched off. Your discount codes could not be read back from Stripe just now; read them again with GET /api/v1/codes." });
    // "No live code" only from a list read to its end; a page with more behind it leaves the box as it was.
    const live = after.codes.some((c) => c.active);
    if (live || after.complete) await setHasDiscounts(storeRef(store), live);
    return apiOk({ data: after.codes.map(codeOut), has_more: !after.complete });
  } catch (error) {
    console.error("api: switching a code off failed", error);
    return unreadable();
  }
}
