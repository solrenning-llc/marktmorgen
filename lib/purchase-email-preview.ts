/**
 * An example of the email a buyer gets after paying for one product, for the
 * creator to read in the studio before any sale (queue item 380 [TB6], unit 1:
 * seeing what a buyer receives without paying for a real order).
 *
 * It is not a second template. The example is written by confirmationFor
 * (lib/purchase-email.ts), the same function that writes the real email, for
 * a made-up order of the product: a test-mode order reference, a buyer at
 * example.com, the product's listed price (its first option's, when it has
 * options), and, where the product needs them, a made-up license key and
 * shipping address. So when the real email's wording changes, the example
 * changes with it.
 *
 * It costs nothing: no Redis command, no Stripe call, nothing sent. The store
 * and the product are the ones the studio page has already read. The creator's
 * note after paying (lib/thanks-note.ts) is kept in its own record; rather
 * than read it a second time, the example shows a marker where it goes.
 *
 * It is offered only where the regular purchase email is what a buyer gets:
 * never for something free (a sign-up has its own page), a booked call (its
 * own confirmation, lib/calls.ts), a package of calls (lib/call-packages.ts),
 * or the demo's account, which confirms nothing by email (canConfirm).
 * Pre-orders, gifts and purchases for a team also get emails of their own;
 * the panel says so.
 */
import { DEMO_CONNECTED_ACCOUNT } from "@/lib/demo-account";
import { confirmationFor, fromStore, type KeyLine, type SessionRecord } from "@/lib/purchase-email";
import { speechFor } from "@/lib/buyer-words";
import { isFree, type Listing, type Store } from "@/lib/store";
import type { ThanksNote } from "@/lib/thanks-note";

/** A test-mode order reference, plainly made up: never a live order's. */
export const EXAMPLE_ORDER = "cs_test_ExampleOrder01";

/** The made-up buyer (example.com is reserved for examples). */
export const EXAMPLE_BUYER = "buyer@example.com";

/** A made-up license key, for a product that hands them out. */
export const EXAMPLE_KEY = "XXXX-XXXX-XXXX-XXXX";

/** A made-up shipping address, for something shipped. */
export const EXAMPLE_ADDRESS = {
  name: "Alex Example",
  line1: "123 Example Street",
  city: "Springfield",
  state: "IL",
  postal_code: "62701",
  country: "US",
} as const;

/** Where the creator's own note after paying goes, marked as such. */
export const NOTE_PLACEHOLDER: ThanksNote = {
  heading: "[Your note after paying]",
  body: "[What you saved under “After paying: a note from you” goes here: its heading, words, video and button.]",
  video: null,
  button: null,
};

export type EmailPreview = {
  /** The From line, as the real email has it. */
  from: string;
  /** The made-up buyer it is addressed to. */
  to: string;
  subject: string;
  text: string;
  /** The buyer's language of the store, for the quote's lang attribute. */
  lang: string;
};

/** The made-up, paid checkout the example is written for. */
export function exampleSession(store: Pick<Store, "handle" | "currency">, product: Listing, nowSeconds: number): SessionRecord & Record<string, unknown> {
  const option = product.options[0] ?? null;
  const metadata: Record<string, string> = { store: store.handle, product: product.id };
  if (option) metadata.option = option.id;
  if (product.shipping) metadata.ship = "yes";
  const { name, ...address } = EXAMPLE_ADDRESS;
  return {
    id: EXAMPLE_ORDER,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: product.recurring ? "subscription" : "payment",
    amount_total: option ? option.priceCents : product.priceCents,
    currency: store.currency,
    created: Math.floor(nowSeconds),
    customer_details: { email: EXAMPLE_BUYER },
    metadata,
    ...(product.shipping ? { collected_information: { shipping_details: { name, address: { ...address, line2: null } } } } : {}),
  };
}

/**
 * The example email for one product, or null where the regular purchase email
 * is not what its buyers get. `demoAccount` is the demo's connected account
 * (lib/demo-account.ts); an empty one matches nothing.
 */
export function purchaseEmailPreview(
  store: Store,
  product: Listing,
  nowSeconds = Date.now() / 1000,
  demoAccount: string = DEMO_CONNECTED_ACCOUNT,
): EmailPreview | null {
  if (isFree(product) || product.call || product.callPackage) return null;
  if (demoAccount && store.stripeAccountId === demoAccount) return null;
  const keys: KeyLine[] = product.keys ? [{ title: product.title, key: { state: "issued", key: EXAMPLE_KEY, revoked: false } }] : [];
  const letter = confirmationFor(
    store,
    exampleSession(store, product, nowSeconds),
    nowSeconds,
    keys,
    [product],
    product.note ? NOTE_PLACEHOLDER : null,
    null,
  );
  if (!letter) return null;
  return {
    from: fromStore(store),
    to: letter.to,
    subject: letter.subject,
    text: letter.text,
    lang: speechFor(store.language, store.currency).lang.locale,
  };
}
