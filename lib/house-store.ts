/**
 * The one store here that is ours: the demo store.
 *
 * "Live demo store" used to be a page written by hand. It looked like a
 * store and its checkout was real, but none of it was the code a creator's
 * store runs on — so what a visitor tried was not what a creator's buyers
 * get, and the speed published for it was not the speed of a store.
 *
 * Now it is a store: a record like any creator's, made through the same
 * functions the studio calls (lib/demo-seed.ts), drawn by the same pages,
 * sold through the same checkout and handed over by the same download. This
 * file is the short list of ways it is, on purpose, not like the others —
 * every one of them because it is the only store whose buyers pay nothing:
 *
 *   - It sells in Stripe's test mode whatever the site's own key is
 *     (lib/demo-account.ts), and its pages say so before anybody reaches a
 *     card form.
 *   - Nobody can sign in as its owner. It is changed by changing the code
 *     that makes it, and in no other way.
 *   - It takes no reviews. A review here would be words from anybody at all
 *     under "verified purchase", on a page of ours, with no creator to answer
 *     for them — and a purchase costs nothing.
 *   - It writes to no buyer (lib/purchase-email.ts): a checkout that takes
 *     any address for free must never be a way to send somebody an email.
 *
 * Everything else about it is whatever a store on its plan (Studio,
 * DEMO_STORE.tier in lib/demo-seed.ts) is.
 *
 * Nothing is imported here, so a page drawn in the browser can read the
 * store's address without carrying anything else along.
 */

/** The address the demo store is kept under. No sign-in link is ever sent to it (lib/auth.ts). */
export const HOUSE_OWNER = "demo@marktmorgen.com";

/** Where the demo store lives: marktmorgen.com/@harborkitchen. */
export const HOUSE_HANDLE = "harborkitchen";

/** Stripe's own test card, as the demo's pages print it. */
export const TEST_CARD = "4242 4242 4242 4242";

/**
 * Who opens the demo store's studio.
 *
 * Nobody signs in as the demo's owner, and its Zoom and Google Calendar
 * connections are made in the studio, the way every creator's are. So one
 * address is on its team as an Admin (lib/demo-seed.ts, lib/team.ts). It is
 * supplied only by the server's DEMO_STUDIO_ADMIN environment variable.
 * No personal address or default identity is kept in the repository.
 *
 * An Admin can reach the store's settings and products. They cannot change
 * what the demo is: it is built from lib/demo-seed.ts on every deployment
 * that changes it, and anything edited by hand is put back.
 */
/** Server configuration only; an absent or invalid address grants nobody access. */
export function configuredDemoStudioAdmin(value = process.env.DEMO_STUDIO_ADMIN): string {
  const address = (value ?? "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) ? address : "";
}
export const DEMO_STUDIO_ADMIN = configuredDemoStudioAdmin();

/**
 * What the demo store's booking pages say in place of the email they would
 * mention on a creator's store. A booking on the demo writes to nobody
 * (lib/calls.ts, writesAboutBookings), so a page there that promised a
 * confirmation, a reminder or a reply would promise what never comes. In
 * English, like everything the demo says about itself (components/demo-notes.tsx).
 */
export const DEMO_BOOKED_NOTE =
  "Join at that time with the link above, or add it to your calendar from here. This is the demo store, so no email is sent: this page is where your booking lives. Keep its address to come back to it or to move it.";
export const DEMO_MOVED_NOTE =
  "The new time and its link are here. This is the demo store, so no email is sent. The old time is free again for somebody else.";
export const DEMO_STAYS_NOTE = "Your booking stays as it is. This is the demo store, so there is nobody to write to about it.";

export function isHouseAddress(email: string): boolean {
  return email.trim().toLowerCase() === HOUSE_OWNER;
}

/** Whether a store is the demo store. By who owns it, which nobody can become. */
export function isHouseStore(store: { email: string }): boolean {
  return isHouseAddress(store.email);
}

/** Whether a store is the demo store, for the demo's own AI allowance (lib/demo-ai-rules.ts): false for anything
 * without an owner's address, never a throw. */
export function isDemoStore(store: { email?: unknown } | null | undefined): boolean {
  return !!store && typeof store.email === 'string' && isHouseAddress(store.email);
}

/** Whether buyers of this store may leave a review. Every store but the demo. */
export function takesReviews(store: { email: string }): boolean {
  return !isHouseStore(store);
}
