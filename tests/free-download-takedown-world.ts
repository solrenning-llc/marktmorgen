// Synthetic world for tests/free-download-takedown.test.ts: only the edges of
// app/api/store/free/download are stubbed; the route and lib/serve-file.ts are real.
export const world = {
  suspended: "",
  hidden: false,
  link: "",
  storeThrows: false,
  listingThrows: false,
  claimThrows: false,
  spent: 0,
  served: [] as string[],
  leads: 0,
  events: 0,
  queued: 0,
};
// next/server
export function after(task: () => unknown) {
  world.queued += 1;
  void task;
}
// @/lib/store
export const isFree = (p: { priceCents: number }) => p.priceCents === 0;
export async function storeForHandle(handle: string) {
  if (world.storeThrows) throw new Error("synthetic: the store record could not be read");
  // A store switched off after notices about its content carries the time in suspended (lib/takedown.ts, noteTakedown).
  return handle === "shop" ? { handle: "shop", language: "en", suspended: world.suspended, statsId: "s1" } : null;
}
// @/lib/free: what the emailed link names, read without spending, and one use of it spent.
export async function readClaim() {
  if (world.claimThrows) throw new Error("synthetic: the link could not be read");
  return { handle: "shop", productId: "prod1" };
}
export async function spendClaim() {
  world.spent += 1;
  return { ok: true, claim: { h: "shop", p: "prod1", e: "a@example.com", c: false, at: 1, a: "" } };
}
export async function recordLead() {
  world.leads += 1;
  return null;
}
// @/lib/affiliate-leads, @/lib/welcome-offer-send, @/lib/flows, @/lib/email-sync
export async function scheduleReminder() {}
export async function enroll() {}
export async function queuePerson() {}
// @/lib/webhooks
export async function emitEvent() {
  world.events += 1;
}
// @/lib/catalog: a product taken down by the "product" action is hidden (setProductHidden(ref, id, true)).
export async function readListing() {
  if (world.listingThrows) throw new Error("synthetic: the listing could not be read");
  return {
    id: "prod1",
    title: "Free guide",
    priceCents: 0,
    hidden: world.hidden,
    recurring: null,
    options: [],
    link: world.link || null,
    file: world.link
      ? null
      : { pathname: "stores/" + "f".repeat(32) + "/prod1/guide.pdf", name: "guide.pdf", bytes: 1000, contentType: "application/pdf", addedAt: "" },
  };
}
// @/lib/buyer-words/giving
export const givingWords = () => ({ freeGone: "gone", freeNothing: "nothing" });
// @/lib/blob (read by the real lib/serve-file.ts)
export async function get(pathname: string) {
  world.served.push(pathname);
  return { statusCode: 200, stream: new Blob(["%PDF-1.4 synthetic"]).stream(), blob: { size: 18 } };
}
export async function head() {
  throw new Error("unused");
}
export async function del() {}
export async function list() {
  return { blobs: [], hasMore: false };
}
export async function put() {}
export async function issueSignedToken() {
  return "t";
}
export async function presignUrl() {
  return { presignedUrl: "https://x" };
}
// @/lib/delivery (read by the real lib/serve-file.ts)
export const folderFromPathname = () => "f".repeat(32);
export async function freeDeliveryPause() {
  return "open";
}
export async function recordDelivery() {
  return true;
}
