import { apiAdder, apiError, apiOk, apiStore, apiWriter } from "@/lib/api-guard";
import { apiOkFields } from "@/lib/api-fields";
import { codeOut, refusalWords } from "@/lib/api-codes";
import { createCode, listCodes, stopCode } from "@/lib/discount";
import { readCodeAsked } from "@/lib/discount-input";
import { setHasDiscounts, storeRef, type Store } from "@/lib/store";
import { canSell } from "@/lib/store-checkout";

/**
 * Discount codes on the creator's own Stripe account (lib/api-codes.ts):
 *   GET    /api/v1/codes            every code, as the studio lists them
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
  try {
    const list = await listCodes(store.stripeAccountId as string);
    return list.state === "ok" ? apiOkFields(request, { data: list.codes.map(codeOut) }) : unreadable();
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
  try {
    const account = store.stripeAccountId as string;
    // Only a code the store's own list shows, never any id on the account.
    const before = await listCodes(account);
    if (before.state !== "ok") return unreadable();
    if (!before.codes.some((c) => c.id === id)) return apiError(404, "not_found", "No discount code of this store has that id.");
    if (!(await stopCode(account, id))) return apiError(502, "unavailable", "The code could not be switched off on Stripe just now. Try again in a moment.");
    // Listed again, so the answer is what Stripe says now; the checkout's box stays only while a code is live.
    const after = await listCodes(account);
    if (after.state !== "ok") return unreadable();
    await setHasDiscounts(storeRef(store), after.codes.some((c) => c.active));
    return apiOk({ data: after.codes.map(codeOut) });
  } catch (error) {
    console.error("api: switching a code off failed", error);
    return unreadable();
  }
}
